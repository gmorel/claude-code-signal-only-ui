import { describe, expect, test } from 'bun:test'
import type { CardItem, CardModel, CardState, Marker, ThemeCtx } from '../../hooks/theme.ts'
import { theme as gmorel } from '../../hooks/themes/gmorel.ts'

type Node = { type: 'Box' | 'Text' | 'Button' | 'Code'; props: Record<string, unknown> }

const table = {
  Box: (props: Record<string, unknown>) => ({ type: 'Box', props }) as Node,
  Text: (props: Record<string, unknown>) => ({ type: 'Text', props }) as Node,
  Button: (props: Record<string, unknown>) => ({ type: 'Button', props }) as Node,
  Code: (props: Record<string, unknown>) => ({ type: 'Code', props }) as Node,
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && 'type' in value && 'props' in value

const walk = (value: unknown, out: Node[] = []): Node[] => {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, out)
    return out
  }
  if (!isNode(value)) return out
  out.push(value)
  walk(value.props.children, out)
  return out
}

const texts = (nodes: Node[]) => nodes.filter(n => n.type === 'Text')
const boxes = (nodes: Node[]) => nodes.filter(n => n.type === 'Box')
const buttons = (nodes: Node[]) => nodes.filter(n => n.type === 'Button')
const str = (node: Node): string => (typeof node.props.children === 'string' ? node.props.children : '')
const indexOfText = (nodes: Node[], needle: string) =>
  nodes.findIndex(n => n.type === 'Text' && str(n).toLowerCase().includes(needle.toLowerCase()))

const isDarkColor = (color: unknown): boolean =>
  color === 'black' || (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) && parseInt(color.slice(1), 16) < 0x808080)

const textsInBox = (box: Node): Node[] => {
  const found: Node[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (!isNode(value)) return
    if (value.type === 'Text') found.push(value)
    else visit(value.props.children)
  }
  visit(box.props.children)
  return found
}

const columnLineCount = (col: Node): number => {
  const kids = col.props.children
  if (!Array.isArray(kids)) return 1
  return kids.reduce<number>((n, child) => {
    if (!isNode(child)) return n
    if (child.type === 'Box') return n + 1
    if (child.type === 'Text') return n + 1
    return n
  }, 0)
}

const optionBlockRows = (row: Node): number => {
  const cols = boxes(walk(row)).filter(b => b.props.flexDirection === 'column')
  if (cols.length === 0) return 1
  return Math.max(...cols.map(columnLineCount))
}

const chooserAreaRows = (optionsBox: Node): number => {
  const kids = optionsBox.props.children
  if (!Array.isArray(kids)) return 0
  return kids.reduce<number>((n, child) => {
    if (!isNode(child)) return n
    if (child.type === 'Text') return n + 1
    if (child.type === 'Box' && String(child.props.key).includes(':option-row:')) return n + optionBlockRows(child)
    return n
  }, 0)
}

const item = (marker: Marker, text: string, extra: Partial<CardItem> = {}): CardItem => ({
  marker,
  text,
  bold: false,
  lines: [],
  code: [],
  ...extra,
})

const DONE_TEXTS = [
  'Copied to ~/.claude/skills/claude-mermaid',
  'Loads from there, claude-mermaid@skills-dir',
  'Draws from there, screen captured',
  'Marketplace copy uninstalled',
  'Tests 42/42, backup mirror checked 09:36:27Z',
]
const READ_TEXT = 'Two ui.render hooks would fire if the CI badge had stayed red'
const INFO_TEXTS = ['renamed `config.yml` to `config.yaml`; 12 tests still pass', 'the CI badge is green again']
const SKIP_TEXT = 'The rsync printed 16 files, none of them interesting'
const QUESTION = 'Patch your copy so fences inside a quote are drawn too?'
const OPTIONS = [{ label: 'yes' }, { label: 'no' }]

const fixture = (): CardModel => {
  const decide = item('decide', `À décider : ${QUESTION} Sans réponse de ta part : leave it`, { bold: true })
  const done = DONE_TEXTS.map((text, i) =>
    item('done', text, {
      bold: i < 4,
      ...(i === 1 ? { lines: ['debug log read'] } : {}),
      ...(i === 4 ? { code: [{ lang: 'bash', source: 'bun test tests/unit' }] } : {}),
    }),
  )
  const items = [decide, ...done, item('read', READ_TEXT), ...INFO_TEXTS.map(t => item('info', t)), item('skip', SKIP_TEXT)]
  return {
    preamble: [],
    header: true,
    verdict: decide,
    decision: { question: QUESTION, defaultText: 'leave it', defaultKey: null, options: [...OPTIONS] },
    items,
    counts: { done: 5, decide: 1, blocked: 0, read: 1, info: 2, skip: 1 },
    quoted: true,
    raw: 'irrelevant',
  }
}

type Calls = { toggled: string[]; filled: string[] }

const context = (
  over: { columns?: number; open?: CardState['open']; observerRunning?: boolean; usage?: ThemeCtx['usage'] } = {},
): { ctx: ThemeCtx; calls: Calls } => {
  const calls: Calls = { toggled: [], filled: [] }
  const ctx = {
    el: table as unknown as ThemeCtx['el'],
    columns: over.columns ?? 100,
    surface: 'terminal',
    state: { open: over.open ?? {}, answered: null },
    actions: {
      toggle: (section: string) => void calls.toggled.push(section),
      fill: (text: string) => void calls.filled.push(text),
    },
    witness: { observerRunning: over.observerRunning ?? false, hiddenReports: 0 },
    id: 'msg-1',
    usage: over.usage,
  } as unknown as ThemeCtx
  return { ctx, calls }
}

describe('gmorel', () => {
  test('exports id, name and tagline', () => {
    expect(gmorel.id).toBe('gmorel')
    expect(gmorel.name).toBe('gmorel 1.1.0')
    expect(gmorel.tagline.length).toBeGreaterThan(0)
  })

  test('full card: header with witness, counters, decision, markers, folded skip', () => {
    const { ctx } = context({ observerRunning: true, columns: 100 })
    const nodes = walk(gmorel.render(fixture(), ctx))
    expect(indexOfText(nodes, '👉 For you')).toBe(-1)
    expect(texts(nodes).filter(n => str(n) === '✓' && n.props.color === 'green')).toHaveLength(1)
    expect(texts(nodes).some(n => str(n) === '☑' && n.props.color === 'green')).toBe(true)
    const readBox = boxes(nodes).find(n => n.props.key === 'msg-1:read:6')
    expect(readBox?.props.borderColor).toBe('#D98324')
    expect(readBox?.props.borderStyle).toBe('round')
    expect(indexOfText(nodes, 'decision')).toBeGreaterThanOrEqual(0)
    expect(indexOfText(nodes, 'done')).toBeGreaterThanOrEqual(0)
    expect(texts(nodes).some(n => str(n).includes('proven'))).toBe(false)
    expect(indexOfText(nodes, '🟡 DECISION')).toBeGreaterThanOrEqual(0)
    expect(buttons(nodes).filter(b => b.props.label === 'yes' || b.props.label === 'no')).toHaveLength(2)
    expect(indexOfText(nodes, DONE_TEXTS[0]!)).toBeGreaterThanOrEqual(0)
    expect(indexOfText(nodes, SKIP_TEXT)).toBe(-1)
    expect(indexOfText(nodes, '1 skippable detail hidden')).toBeGreaterThanOrEqual(0)
  })

  test('pure answer: Answer header, no counters, no witness', () => {
    const model: CardModel = {
      preamble: [],
      header: true,
      verdict: item('info', 'The answer is forty-two.', { bold: true }),
      decision: null,
      items: [
        item('info', 'The answer is forty-two.', { bold: true }),
        item('read', 'You may want to read the manual.'),
        item('skip', 'Footnote about Douglas Adams.'),
      ],
      counts: { done: 0, decide: 0, blocked: 0, read: 1, info: 1, skip: 1 },
      quoted: false,
      raw: '',
    }
    const { ctx } = context({ observerRunning: true, columns: 100 })
    const nodes = walk(gmorel.render(model, ctx))
    expect(indexOfText(nodes, '▫️ Answer')).toBeGreaterThanOrEqual(0)
    expect(indexOfText(nodes, 'nothing to do')).toBeGreaterThanOrEqual(0)
    expect(indexOfText(nodes, 'done, proven')).toBe(-1)
    expect(texts(nodes).some(n => str(n).includes('proven'))).toBe(false)
    expect(texts(nodes).filter(n => str(n) === '✓')).toHaveLength(0)
  })

  test('the verdict sits in a box bordered by its own marker colour, not a cyan bar', () => {
    const border = (marker: Marker): unknown => {
      const model: CardModel = {
        preamble: [],
        header: true,
        verdict: item(marker, 'The verdict line.', { bold: true }),
        decision: null,
        items: [item(marker, 'The verdict line.', { bold: true }), item('skip', 'a footnote')],
        counts: { done: 0, decide: 0, blocked: 0, read: marker === 'read' ? 1 : 0, info: marker === 'info' ? 1 : 0, skip: 1 },
        quoted: false,
        raw: '',
      }
      const nodes = walk(gmorel.render(model, context().ctx))
      const box = boxes(nodes).find(n => typeof n.props.borderColor === 'string' && n.props.borderStyle === 'round')
      return box?.props.borderColor
    }
    // a plain answer reads green; a warning keeps the same orange as the ⚠️ box
    expect(border('info')).toBe('green')
    expect(border('read')).toBe('#D98324')
    // and the old fixed cyan bar is gone for good
    const model: CardModel = {
      preamble: [],
      header: true,
      verdict: item('info', 'The verdict line.', { bold: true }),
      decision: null,
      items: [item('info', 'The verdict line.', { bold: true })],
      counts: { done: 0, decide: 0, blocked: 0, read: 0, info: 1, skip: 0 },
      quoted: false,
      raw: '',
    }
    expect(boxes(walk(gmorel.render(model, context().ctx))).some(n => n.props.backgroundColor === 'cyan')).toBe(false)
  })

  test('blocked card: red label and only-you-can-unblock hint', () => {
    const model: CardModel = {
      preamble: [],
      header: true,
      verdict: item('blocked', 'Need your API key in .env', { bold: true }),
      decision: null,
      items: [item('blocked', 'Need your API key in .env', { bold: true, lines: ['export ANTHROPIC_API_KEY=…'] })],
      counts: { done: 0, decide: 0, blocked: 1, read: 0, info: 0, skip: 0 },
      quoted: false,
      raw: '',
    }
    const nodes = walk(gmorel.render(model, context().ctx))
    expect(indexOfText(nodes, '🔴 BLOCKED')).toBeGreaterThanOrEqual(0)
    const blocked = texts(nodes).find(n => str(n).includes('BLOCKED'))
    expect(blocked?.props.color).toBe('red')
    expect(indexOfText(nodes, 'only you can unblock')).toBeGreaterThanOrEqual(0)
  })

  test('one-line card: no header and no counters', () => {
    const model: CardModel = {
      preamble: [],
      header: true,
      verdict: null,
      decision: null,
      items: [item('done', 'All good.')],
      counts: { done: 1, decide: 0, blocked: 0, read: 0, info: 0, skip: 0 },
      quoted: false,
      raw: '',
    }
    const nodes = walk(gmorel.render(model, context({ observerRunning: true }).ctx))
    expect(indexOfText(nodes, '👉 For you')).toBe(-1)
    expect(indexOfText(nodes, '▫️ Answer')).toBe(-1)
    expect(indexOfText(nodes, 'decision')).toBe(-1)
    expect(indexOfText(nodes, 'All good.')).toBeGreaterThanOrEqual(0)
  })

  test('counters row draws only non-zero counts', () => {
    const model: CardModel = {
      preamble: [],
      header: true,
      verdict: item('done', 'Six .png files copied.', { bold: true }),
      decision: null,
      items: [
        item('done', 'Six .png files copied.', { bold: true }),
        item('info', 'renamed config.yml'),
        item('info', 'badge is green'),
      ],
      counts: { done: 1, decide: 0, blocked: 0, read: 0, info: 2, skip: 0 },
      quoted: false,
      raw: '',
    }
    const nodes = walk(gmorel.render(model, context({ columns: 100 }).ctx))
    const counterTiles = nodes.filter(n => String(n.props.key).startsWith('msg-1:count:'))
    expect(counterTiles).toHaveLength(1)
    expect(textsInBox(counterTiles[0]!).some(t => str(t) === 'done')).toBe(true)
    expect(texts(nodes).some(t => str(t) === 'decision')).toBe(false)
    expect(texts(nodes).some(t => str(t) === 'to read')).toBe(false)
    expect(texts(nodes).some(t => str(t) === 'blocked')).toBe(false)
  })

  test('all-zero counts draw no counter row', () => {
    const model: CardModel = {
      preamble: [],
      header: true,
      verdict: item('info', 'Nothing pending.'),
      decision: null,
      items: [item('info', 'Nothing pending.')],
      counts: { done: 0, decide: 0, blocked: 0, read: 0, info: 1, skip: 0 },
      quoted: false,
      raw: '',
    }
    const nodes = walk(gmorel.render(model, context({ columns: 100 }).ctx))
    expect(nodes.some(n => n.props.key === 'msg-1:counters')).toBe(false)
    expect(nodes.filter(n => String(n.props.key).startsWith('msg-1:count:'))).toHaveLength(0)
  })

  test('done verdict box sits above counters and appears once', () => {
    const verdictText = 'Six .png files in docs/, 887 715 bytes total'
    const model: CardModel = {
      preamble: [],
      header: true,
      verdict: item('done', verdictText, { bold: true }),
      decision: null,
      items: [
        item('done', verdictText, { bold: true }),
        item('info', 'renamed config.yml'),
        item('info', 'badge is green'),
      ],
      counts: { done: 1, decide: 0, blocked: 0, read: 0, info: 2, skip: 0 },
      quoted: false,
      raw: '',
    }
    const nodes = walk(gmorel.render(model, context({ columns: 100 }).ctx))
    const verdictBox = boxes(nodes).find(n => n.props.key === 'msg-1:verdict')
    expect(verdictBox?.props.borderStyle).toBe('round')
    expect(verdictBox?.props.borderColor).toBe('green')
    const countersIdx = nodes.findIndex(n => n.props.key === 'msg-1:counters')
    const verdictIdx = nodes.findIndex(n => n.props.key === 'msg-1:verdict')
    expect(verdictIdx).toBeGreaterThanOrEqual(0)
    expect(countersIdx).toBeGreaterThanOrEqual(0)
    expect(verdictIdx).toBeLessThan(countersIdx)
    expect(texts(nodes).filter(n => str(n).includes(verdictText))).toHaveLength(1)
  })

  test('narrow counters render as one combined line', () => {
    const { ctx } = context({ columns: 60 })
    const nodes = walk(gmorel.render(fixture(), ctx))
    const combined = texts(nodes).find(n => str(n).includes('decision') && str(n).includes('done'))
    expect(combined).toBeDefined()
    expect(nodes.filter(n => n.props.key === 'msg-1:count:decide')).toHaveLength(0)
  })

  test('skip fold closed by default, open when toggled', () => {
    const closed = walk(gmorel.render(fixture(), context().ctx))
    expect(indexOfText(closed, SKIP_TEXT)).toBe(-1)
    expect(buttons(closed).some(b => b.props.label === 'show')).toBe(true)

    const open = walk(gmorel.render(fixture(), context({ open: { skip: true } }).ctx))
    expect(indexOfText(open, SKIP_TEXT)).toBeGreaterThanOrEqual(0)
    expect(buttons(open).some(b => b.props.label === 'hide')).toBe(true)
  })

  test('three-option decision: compact chooser, default tag and risk colour', () => {
    const decide = item(
      'decide',
      'À décider : A, B ou C ? Pick one. A = fake both. B = record real sessions. C = install both. Sans réponse de ta part : B',
      { bold: true },
    )
    const model: CardModel = {
      preamble: [],
      header: true,
      verdict: decide,
      decision: {
        question: 'A, B, C? Pick one.',
        defaultText: 'B',
        defaultKey: 'B',
        options: [
          {
            key: 'A',
            label: 'fake both',
            detail: 'fake both. ~2h. Risk: high.',
            estimate: '2h',
            risk: 'high',
            cost: '≈ $1.20',
          },
          {
            key: 'B',
            label: 'record real sessions',
            detail: 'record real sessions. ≈ 45 min. Risk: low.',
            estimate: '45 min',
            risk: 'low',
            cost: '≈ $0.05',
          },
          {
            key: 'C',
            label: 'install both',
            detail: 'install both. 1 day. Risk: medium.',
            estimate: '1 day',
            risk: 'medium',
            cost: '≈ $0.30',
          },
        ],
      },
      items: [decide, item('done', 'tests green')],
      counts: { done: 1, decide: 1, blocked: 0, read: 0, info: 0, skip: 0 },
      quoted: false,
      raw: '',
    }
    const nodes = walk(gmorel.render(model, context({ columns: 100 }).ctx))
    const optionsBox = boxes(nodes).find(n => n.props.key === 'msg-1:options')
    expect(optionsBox).toBeDefined()

    expect(buttons(nodes).map(b => b.props.label)).toEqual(['fake both', 'record real sessions', 'install both'])
    expect(texts(nodes).every(n => !str(n).toLowerCase().includes('default if you say nothing'))).toBe(true)
    expect(texts(nodes).some(n => str(n).includes('🟡 DECISION') && !str(n).includes('if you say nothing'))).toBe(true)

    // no fill anywhere: a background makes the text fight the reader's own terminal colours
    expect(boxes(nodes).every(b => b.props.backgroundColor === undefined)).toBe(true)
    const defaultBox = boxes(nodes).find(b => String(b.props.key) === 'msg-1:option-row:1')!
    expect(defaultBox).toBeDefined()

    // the recommended row wears one yellow rule; the others pay the same two columns in blank
    const rules = texts(nodes).filter(n => str(n) === '▌')
    expect(rules).toHaveLength(1)
    expect(rules[0]?.props.color).toBe('yellow')
    expect(textsInBox(defaultBox).some(n => str(n) === '▌')).toBe(true)
    for (const key of ['msg-1:option-row:0', 'msg-1:option-row:2']) {
      const row = boxes(nodes).find(b => String(b.props.key) === key)!
      expect(textsInBox(row).some(n => str(n) === '▌')).toBe(false)
    }

    const defaultTexts = textsInBox(defaultBox)
    // the number is bold and the word default is dim: no colour is spent on the recommendation itself
    expect(defaultTexts.some(n => str(n) === '2 ·' && n.props.bold === true)).toBe(true)
    const badge = defaultTexts.find(n => str(n) === 'default')
    expect(badge).toBeDefined()
    expect(badge?.props.dimColor).toBe(true)
    expect(defaultTexts.every(n => n.props.color !== '#1B222B')).toBe(true)

    expect(texts(nodes).some(n => str(n).includes('risk: high') && n.props.color === 'red')).toBe(true)
    expect(defaultTexts.some(n => str(n).includes('risk: low'))).toBe(true)
    expect(texts(nodes).some(n => str(n).includes('≈ 45 min'))).toBe(true)

    for (const option of model.decision!.options) {
      expect(indexOfText(nodes, option.label)).toBeGreaterThanOrEqual(0)
      expect(indexOfText(nodes, option.detail!)).toBeGreaterThanOrEqual(0)
      expect(indexOfText(nodes, `≈ ${option.estimate!}`)).toBeGreaterThanOrEqual(0)
      expect(indexOfText(nodes, `risk: ${option.risk!}`)).toBeGreaterThanOrEqual(0)
      expect(indexOfText(nodes, option.cost!)).toBeGreaterThanOrEqual(0)
    }

    const optionArea = walk(optionsBox!)
    expect(chooserAreaRows(optionsBox!)).toBeLessThanOrEqual(12)
    // every Text carries something, except the one-space spacer that keeps a non-default row on the rule's grid
    expect(texts(optionArea).every(n => str(n).trim().length > 0 || str(n) === ' ')).toBe(true)
  })

  test('zero-option decision shows default clause; two-option decision does not', () => {
    const decide = item('decide', `À décider : ${QUESTION} Sans réponse de ta part : leave it`, { bold: true })
    const zeroOpts: CardModel = {
      preamble: [],
      header: true,
      verdict: decide,
      decision: { question: QUESTION, defaultText: 'leave it', defaultKey: null, options: [] },
      items: [decide],
      counts: { done: 0, decide: 1, blocked: 0, read: 0, info: 0, skip: 0 },
      quoted: false,
      raw: '',
    }
    const zeroNodes = walk(gmorel.render(zeroOpts, context().ctx))
    expect(indexOfText(zeroNodes, 'default if you say nothing: leave it')).toBeGreaterThanOrEqual(0)

    const twoNodes = walk(gmorel.render(fixture(), context().ctx))
    expect(texts(twoNodes).every(n => !str(n).toLowerCase().includes('default if you say nothing'))).toBe(true)
  })

  test('cost line when usage is set, absent otherwise', () => {
    const without = walk(gmorel.render(fixture(), context().ctx))
    expect(indexOfText(without, 'API price')).toBe(-1)

    const zeroUsage = walk(
      gmorel.render(fixture(), context({ usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }).ctx),
    )
    expect(indexOfText(zeroUsage, 'API price')).toBe(-1)

    const withUsage = walk(
      gmorel.render(fixture(), context({ usage: { inputTokens: 20_000, outputTokens: 2_000, costUsd: 0.09 } }).ctx),
    )
    expect(indexOfText(withUsage, '≈ $0.09 · 22k tokens · API price')).toBeGreaterThanOrEqual(0)
  })

  const foldModel = (items: CardItem[]): CardModel => ({
    preamble: [],
    header: false,
    verdict: null,
    decision: null,
    items,
    counts: { done: items.length, decide: 0, blocked: 0, read: 0, info: 0, skip: 0 },
    quoted: false,
    raw: '',
  })

  /** isOneLine skips markerLine; pad with a second done item so folds render through markerLine. */
  const paddedFoldModel = (target: CardItem): CardModel =>
    foldModel([target, item('done', 'padding item')])

  test('item with three lines: hook visible, lines folded behind summary', () => {
    const model = paddedFoldModel(item('done', 'Hook text', { lines: ['Line one', 'Line two', 'Line three'] }))
    const nodes = walk(gmorel.render(model, context().ctx))
    expect(indexOfText(nodes, 'Hook text')).toBeGreaterThanOrEqual(0)
    expect(indexOfText(nodes, 'Line one')).toBe(-1)
    expect(indexOfText(nodes, 'Line two')).toBe(-1)
    expect(indexOfText(nodes, 'Line three')).toBe(-1)
    expect(indexOfText(nodes, '+ summary')).toBeGreaterThanOrEqual(0)
    expect(buttons(nodes).some(b => b.props.label === 'show')).toBe(true)
  })

  test('item with summary open: first line and detail fold only', () => {
    const model = paddedFoldModel(item('done', 'Hook text', { lines: ['Line one', 'Line two', 'Line three'] }))
    const nodes = walk(gmorel.render(model, context({ open: { 'item:0:summary': true } }).ctx))
    expect(indexOfText(nodes, 'Line one')).toBeGreaterThanOrEqual(0)
    expect(indexOfText(nodes, 'Line two')).toBe(-1)
    expect(indexOfText(nodes, 'Line three')).toBe(-1)
    expect(indexOfText(nodes, '+ detail')).toBeGreaterThanOrEqual(0)
  })

  test('item with summary and detail open: remaining lines drawn', () => {
    const model = paddedFoldModel(item('done', 'Hook text', { lines: ['Line one', 'Line two', 'Line three'] }))
    const nodes = walk(
      gmorel.render(model, context({ open: { 'item:0:summary': true, 'item:0:detail': true } }).ctx),
    )
    expect(indexOfText(nodes, 'Line two')).toBeGreaterThanOrEqual(0)
    expect(indexOfText(nodes, 'Line three')).toBeGreaterThanOrEqual(0)
  })

  test('item with no lines and no code: no fold affordance', () => {
    const model = foldModel([item('done', 'Hook only')])
    const nodes = walk(gmorel.render(model, context().ctx))
    expect(indexOfText(nodes, '+ summary')).toBe(-1)
    expect(indexOfText(nodes, '+ detail')).toBe(-1)
    expect(buttons(nodes).filter(b => b.props.label === 'show' || b.props.label === 'hide')).toHaveLength(0)
  })

  test('item with one line and summary open: no detail row', () => {
    const model = paddedFoldModel(item('done', 'Hook text', { lines: ['Only line'] }))
    const nodes = walk(gmorel.render(model, context({ open: { 'item:0:summary': true } }).ctx))
    expect(indexOfText(nodes, 'Only line')).toBeGreaterThanOrEqual(0)
    expect(indexOfText(nodes, '+ detail')).toBe(-1)
    expect(indexOfText(nodes, 'detail')).toBe(-1)
  })

  test('two items with lines: independent summary folds', () => {
    const model = foldModel([
      item('done', 'First hook', { lines: ['First line'] }),
      item('done', 'Second hook', { lines: ['Second line'] }),
    ])
    const { ctx, calls } = context({ open: { 'item:0:summary': true } })
    const nodes = walk(gmorel.render(model, ctx))
    expect(indexOfText(nodes, 'First line')).toBeGreaterThanOrEqual(0)
    expect(indexOfText(nodes, 'Second line')).toBe(-1)

    const summaryBtn = buttons(nodes).find(b => String(b.props.key).endsWith(':toggle:item:0:summary'))
    const otherBtn = buttons(nodes).find(b => String(b.props.key).endsWith(':toggle:item:1:summary'))
    summaryBtn?.props.onPress?.()
    otherBtn?.props.onPress?.()
    expect(calls.toggled).toEqual(['item:0:summary', 'item:1:summary'])
  })
})
