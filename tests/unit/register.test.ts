import { describe, expect, test } from 'bun:test'
import type { EngineInterface, Register } from 'claude-code'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { register } from '../../hooks/register.ts'

type Handler = ($: EngineInterface, event: any, next: any) => unknown

const CARD = readFileSync(join(import.meta.dir, 'fixtures/three-options.txt'), 'utf8')

const walk = (value: unknown, texts: string[] = []): string[] => {
  if (typeof value === 'string') {
    texts.push(value)
    return texts
  }
  if (Array.isArray(value)) {
    for (const child of value) walk(child, texts)
    return texts
  }
  if (!value || typeof value !== 'object') return texts
  const node = value as { props?: { children?: unknown } }
  if (node.props?.children !== undefined) walk(node.props.children, texts)
  return texts
}

const harness = () => {
  const handlers = new Map<string, Handler>()
  const invalidations: string[] = []
  const store = new Map<string, unknown>()
  let observerRunning = false

  const on: Register = (event, filterOrHandler, maybeHandler) => {
    const key =
      typeof filterOrHandler === 'function'
        ? String(event)
        : `${String(event)}:${JSON.stringify(filterOrHandler)}`
    const handler = (typeof filterOrHandler === 'function' ? filterOrHandler : maybeHandler) as Handler
    handlers.set(key, handler)
  }

  register(on, { theme: 'gmorel' })

  const $ = {
    agent: {
      list: async () => (observerRunning ? [{ id: 'obs-1', type: 'claim-sentinel', status: 'running' }] : []),
    },
    ui: {
      invalidate: (scope: string) => void invalidations.push(scope),
      resolve: () => ({
        Box: (props: Record<string, unknown>) => ({ type: 'Box', props }),
        Text: (props: Record<string, unknown>) => ({ type: 'Text', props }),
        Button: (props: Record<string, unknown>) => ({ type: 'Button', props }),
        Code: (props: Record<string, unknown>) => ({ type: 'Code', props }),
      }),
      log: () => {},
    },
    prompt: { fill: async () => ({ isFilled: true }) },
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
    },
    command: { register: async () => {} },
  } as unknown as EngineInterface

  return { handlers, invalidations, $, setObserverRunning: (running: boolean) => void (observerRunning = running) }
}

describe('register witness refresh', () => {
  test('redraws the witness check when an observer starts mid-turn', async () => {
    const { handlers, invalidations, $, setObserverRunning } = harness()
    let listCalls = 0
    const origList = $.agent.list
    $.agent.list = async () => {
      listCalls++
      return origList()
    }

    const turnStart = handlers.get('turn.start')!
    const turnComplete = handlers.get('turn.complete')!
    const render = handlers.get('ui.render:{"component":"AssistantMessage"}')!

    let now = 1_000_000
    const realNow = Date.now
    Date.now = () => now

    await turnStart($, { turnId: 'turn-1' }, async (e: unknown) => e)
    expect(listCalls).toBe(1)

    const first = (await render(
      $,
      { requestId: 'req-1', props: { text: CARD }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'raw' } }),
    )) as { props: { children: unknown } }

    expect(walk(first.props.children).includes('✓')).toBe(false)

    setObserverRunning(true)
    now += 3_000
    const turnStep = handlers.get('turn.step')!
    for await (const _ of turnStep($, { agentId: undefined, chunks: [] }, async function* () {})) {
      /* drain */
    }

    const second = (await render(
      $,
      { requestId: 'req-1', props: { text: CARD }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'raw' } }),
    )) as { props: { children: unknown } }

    Date.now = realNow

    expect(walk(second.props.children).includes('✓')).toBe(true)
    expect(listCalls).toBeGreaterThan(1)

    setObserverRunning(false)
    await turnComplete($, { turnId: 'turn-1', agentId: undefined, usage: undefined }, async (e: unknown) => e)
    expect(invalidations).toContain('ui.render')
  })
})

describe('register observer reports', () => {
  test('hides UserMessage with origin.kind observer and counts hiddenReports', async () => {
    const { handlers, $ } = harness()
    const render = handlers.get('ui.render:{"component":"UserMessage"}')!
    const hidden = (await render(
      $,
      { requestId: 'u-1', props: { text: 'observer saw a mismatch', origin: { kind: 'observer' } }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'visible' } }),
    )) as { props: { display?: string } }
    expect(hidden.props.display).toBe('none')

    const card = (await handlers.get('ui.render:{"component":"AssistantMessage"}')!(
      $,
      { requestId: 'a-1', props: { text: CARD }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'raw' } }),
    )) as { props: { children: unknown } }
    expect(walk(card.props.children).some(text => text.includes('observer report'))).toBe(true)
  })

  test('/signal observers lists hidden reports', async () => {
    const { handlers, $ } = harness()
    const render = handlers.get('ui.render:{"component":"UserMessage"}')!
    await render(
      $,
      { requestId: 'u-2', props: { text: 'first report', origin: { kind: 'observer' } }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'visible' } }),
    )
    const command = handlers.get('command.run:{"command":"signal"}')!
    const answer = (await command($, { args: 'observers' })) as { text: string }
    expect(answer.text).toContain('first report')
    expect(answer.text).toMatch(/observer reports? hidden/)
  })

  test('a report during the turn shows ⚑ on the card', async () => {
    const { handlers, $ } = harness()
    const turnStart = handlers.get('turn.start')!
    const userRender = handlers.get('ui.render:{"component":"UserMessage"}')!
    const assistantRender = handlers.get('ui.render:{"component":"AssistantMessage"}')!

    await turnStart($, { turnId: 'turn-1' }, async (e: unknown) => e)
    await userRender(
      $,
      { requestId: 'u-3', props: { text: 'mid-turn report', origin: { kind: 'observer' } }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'visible' } }),
    )
    const card = (await assistantRender(
      $,
      { requestId: 'a-3', props: { text: CARD }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'raw' } }),
    )) as { props: { children: unknown } }
    expect(walk(card.props.children).some(text => text.includes('⚑ 1'))).toBe(true)
  })

  test('a report after turn.complete shows ⚑ on the next turn’s first card only', async () => {
    const { handlers, $ } = harness()
    const turnStart = handlers.get('turn.start')!
    const turnComplete = handlers.get('turn.complete')!
    const userRender = handlers.get('ui.render:{"component":"UserMessage"}')!
    const assistantRender = handlers.get('ui.render:{"component":"AssistantMessage"}')!

    await turnStart($, { turnId: 'turn-1' }, async (e: unknown) => e)
    await assistantRender(
      $,
      { requestId: 'a-first', props: { text: CARD }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'raw' } }),
    )
    await turnComplete($, { turnId: 'turn-1', agentId: undefined, usage: undefined }, async (e: unknown) => e)
    await userRender(
      $,
      { requestId: 'u-gap', props: { text: 'between turns', origin: { kind: 'observer' } }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'visible' } }),
    )
    await turnStart($, { turnId: 'turn-2' }, async (e: unknown) => e)
    const first = (await assistantRender(
      $,
      { requestId: 'a-second-1', props: { text: CARD }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'raw' } }),
    )) as { props: { children: unknown } }
    const second = (await assistantRender(
      $,
      { requestId: 'a-second-2', props: { text: CARD }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'raw' } }),
    )) as { props: { children: unknown } }
    expect(walk(first.props.children).some(text => text.includes('⚑ 1'))).toBe(true)
    expect(walk(second.props.children).some(text => text.includes('⚑'))).toBe(false)
  })

  test('a report between turns invalidates ui.render once for the previous card', async () => {
    const { handlers, invalidations, $ } = harness()
    const turnStart = handlers.get('turn.start')!
    const turnComplete = handlers.get('turn.complete')!
    const userRender = handlers.get('ui.render:{"component":"UserMessage"}')!
    const assistantRender = handlers.get('ui.render:{"component":"AssistantMessage"}')!

    await turnStart($, { turnId: 'turn-1' }, async (e: unknown) => e)
    await assistantRender(
      $,
      { requestId: 'a-gap', props: { text: CARD }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'raw' } }),
    )
    await turnComplete($, { turnId: 'turn-1', agentId: undefined, usage: undefined }, async (e: unknown) => e)
    invalidations.length = 0
    await userRender(
      $,
      { requestId: 'u-gap-2', props: { text: 'late report', origin: { kind: 'observer' } }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'visible' } }),
    )
    expect(invalidations.filter(scope => scope === 'ui.render')).toHaveLength(1)
  })
})

describe('register notification folding', () => {
  test('a failed task-notification draws its full text', async () => {
    const { handlers, $ } = harness()
    const render = handlers.get('ui.render:{"component":"UserMessage"}')!
    const drawn = (await render(
      $,
      { requestId: 'n-fail', props: { text: 'e2e: 3 fail', origin: { kind: 'task-notification' } }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'e2e: 3 fail' } }),
    )) as { props: { children: string } }
    expect(drawn.props.children).toBe('e2e: 3 fail')
  })

  test('a plain task-notification still folds to one dim line', async () => {
    const { handlers, $ } = harness()
    const render = handlers.get('ui.render:{"component":"UserMessage"}')!
    const folded = (await render(
      $,
      { requestId: 'n-ok', props: { text: 'background work finished', origin: { kind: 'task-notification' } }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: 'background work finished' } }),
    )) as { props: { children: unknown } }
    expect(walk(folded.props.children)).toContain('· background task ·')
  })
})

describe('register narration folding', () => {
  test('clears narrationByText on turn.start so a repeated phrase does not mark a later answer', async () => {
    const { handlers, $ } = harness()
    const turnStart = handlers.get('turn.start')!
    const turnStep = handlers.get('turn.step')!
    const render = handlers.get('ui.render:{"component":"AssistantMessage"}')!

    await turnStart($, { turnId: 'turn-1' }, async (e: unknown) => e)
    for await (const _ of turnStep(
      $,
      { agentId: undefined },
      async function* () {
        yield { kind: 'text', index: 0, text: 'Working on it.' }
        yield { kind: 'tool', index: 1 }
      },
    )) {
      /* drain */
    }
    const prose = 'Working on it.'
    const first = (await render(
      $,
      { requestId: 'req-a', props: { text: prose }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: prose } }),
    )) as { props: { children: unknown } }
    expect(walk(first.props.children).some(text => text.includes('narration'))).toBe(true)

    await turnStart($, { turnId: 'turn-2' }, async (e: unknown) => e)
    const second = (await render(
      $,
      { requestId: 'req-b', props: { text: prose }, viewport: { columns: 100 }, surface: 'terminal' },
      async () => ({ type: 'Box', props: { children: prose } }),
    )) as { props: { children: string } }
    expect(second.props.children).toBe(prose)
  })
})
