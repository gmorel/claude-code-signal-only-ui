import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { block, hasClaude, hasTmux, MARKER_CARD, REPO, startSession, stripAnsi, type Fixture, type Session } from './harness.ts'

// End to end: a real Claude Code, its replies scripted by aimock, this plugin
// loaded from the repository root. Needs tmux and claude on PATH; skipped
// otherwise. Run it with `npm run test:e2e`, which mirrors the repository into
// $TMPDIR first — a node_modules directory next to the plugin changes what
// --plugin-dir loads, so dependencies install only in the mirror.

/** a file inside the mirror: a Read anywhere else would ask before it ran */
const README = join(REPO, 'README.md')

const FIXTURES: Fixture[] = [
  // one card per session, so no prompt is another's prefix and aimock cannot answer the wrong one
  { prompt: 'card alpha token', reply: MARKER_CARD },
  { prompt: 'card bravo token', reply: MARKER_CARD },
  { prompt: 'card charlie token', reply: MARKER_CARD },
  { prompt: 'card delta token', reply: MARKER_CARD },
  { prompt: 'card echo token', reply: MARKER_CARD },
  { prompt: 'prose foxtrot token', reply: 'No markers anywhere in this one, just a sentence. PROSE-DONE' },
  // a sentence, then a tool call, then the card: the shape SPEC §3.2 folds
  {
    prompt: 'narrate golf token',
    lead: 'Let me read the README before I answer.',
    tool: { name: 'Read', arguments: { file_path: README } },
    reply: MARKER_CARD,
  },
]

const ready = hasTmux() && hasClaude()
/** a turn through aimock plus the redraw; well past bun's 5s default */
const TURN_MS = 60_000
/** a paced turn streams for ten-odd seconds before the card lands */
const SLOW_MS = 120_000

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Preferences live in `$.store`, which outlives the session: a run that ended
 * on `/signal fold off` would silently disarm the next one. So every session
 * says what it wants before it asserts anything.
 */
const prime = async (s: Session, theme: string) => {
  for (const [args, answer] of [
    [`theme ${theme}`, `signal: theme ${theme} ·`],
    ['fold on', 'signal: fold on ·'],
    ['observer on', 'signal: observer on ·'],
  ] as const) {
    s.send(`/signal ${args}`)
    // the colon is what tells the answer from the echo of the words just typed
    await s.waitFor(answer, TURN_MS)
  }
}

describe.skipIf(!ready)('a marker card in the receipt theme', () => {
  let s: Session

  beforeAll(async () => {
    s = await startSession(FIXTURES, { columns: 100, rows: 40 })
    await prime(s, 'receipt')
  }, 120_000)

  afterAll(async () => {
    await s?.stop()
  })

  test('the card is drawn: the decision first, its answers as buttons, the skippable line folded away', async () => {
    s.send('card alpha token')
    const screen = await s.waitFor('1 skippable line', TURN_MS)
    const card = block(screen, 'FOR YOU', '1 skippable line')

    expect(card).toContain('FOR YOU')
    expect(card).toContain('PATCH THE COPY OR KEEP THE ORIGINAL?')
    // receipt says the default clause its own way, as an order-form line
    expect(card).toContain('default: keep it.')
    // a press fills the prompt box; the label is the answer the reader would send
    expect(card).toContain('[ patch the copy ]')
    expect(card).toContain('[ keep the original ]')
    expect(card).toContain('[??]')
    expect(card).toContain('[!!]')
    expect((card.match(/\[OK\]/g) ?? []).length).toBeGreaterThanOrEqual(5)
    expect(card).toContain('.....')
    expect(card).toContain('Two ui.render hooks would fire')
    expect(card).toContain('1 skippable line [ show ]')
    // still folded: the ℹ️ line is behind the button
    expect(card).not.toContain('Clone and node_modules live in the scratchpad')
    // the model wrote the card inside a blockquote; the drawing carries no trace of it
    expect(card).not.toContain('>')
    expect(card).not.toContain('▎')
    expect(card).not.toMatch(/[┌┐└┘├┤┬┴┼─│╭╮╰╯═║]/)
  }, TURN_MS)

  test('a reply without markers passes through exactly as the model wrote it', async () => {
    s.send('prose foxtrot token')
    await s.waitFor('PROSE-DONE', TURN_MS)
    const line = s.rows().find(row => row.includes('PROSE-DONE'))
    // the engine's own bullet and the sentence, nothing added and nothing folded
    expect(line).toBe('⏺ No markers anywhere in this one, just a sentence. PROSE-DONE')
  }, TURN_MS)

  test('every tree the hook drew validated', () => {
    const log = readFileSync(s.debugLog, 'utf8')
    expect(log).not.toContain('does not validate')
    expect(log).toMatch(/hooks module signal-only-ui ui\.render settled/)
  })

  // last in the session: the last two words change preferences the tests above rely on
  test('/signal answers with its status, its themes and its switches', async () => {
    s.send('/signal')
    // the answer is one line the terminal wraps, so it is read with its spacing collapsed
    const status = stripAnsi(await s.waitFor(/signal: theme \w+ · observer (on|off) · fold (on|off)/, TURN_MS)).replace(/\s+/g, ' ')
    expect(status).toMatch(/signal: theme receipt · observer on · fold on · audit off · \d+ reports? hidden/)
    expect(status).toMatch(/(an observer is running|no observer running)/)

    s.send('/signal themes')
    const themes = stripAnsi(await s.waitFor('kanban —', TURN_MS))
    expect(themes).toContain('receipt — framed till roll, ASCII')
    expect(themes).toContain('kanban — sticky notes with real fills')

    s.send('/signal observer off')
    expect(stripAnsi(await s.waitFor('signal: observer off ·', TURN_MS))).toContain('reports drawn as they come')

    s.send('/signal fold off')
    expect(stripAnsi(await s.waitFor('signal: fold off ·', TURN_MS))).toContain('every block drawn whole')
  }, TURN_MS * 2)
})

describe.skipIf(!ready)('the same card in the receipt theme', () => {
  let s: Session

  beforeAll(async () => {
    s = await startSession(FIXTURES, { columns: 100, rows: 40 })
    await prime(s, 'receipt')
  }, 120_000)

  afterAll(async () => {
    await s?.stop()
  })

  test('a till roll: FOR YOU, dotted leaders, [OK] [!!] [??], and not one box-drawing glyph', async () => {
    s.send('card bravo token')
    const screen = await s.waitFor('1 skippable line', TURN_MS)
    const card = block(screen, 'FOR YOU', '1 skippable line')

    expect(card).toContain('FOR YOU')
    expect(card).toContain('1 decision · 5 done · 1 read')
    // shouted, as a till prints
    expect(card).toContain('PATCH THE COPY OR KEEP THE ORIGINAL?')
    // frame must never clip these literals again
    expect(card).toContain('[??]')
    // frame must never clip these literals again
    expect(card).toContain('[!!]')
    // frame must never clip these literals again
    expect(card).toContain('[OK]')
    expect(card).toContain('.....')
    expect(card).toContain('[ patch the copy ]')
    // the whole point of this theme: any terminal, any font, any screen reader.
    // Scoped to the card because the composer draws a box of its own below it.
    expect(card).not.toMatch(/[┌┐└┘├┤┬┴┼─│╭╮╰╯═║]/)
  }, TURN_MS)
})

describe.skipIf(!ready)('the kanban theme at 170 columns', () => {
  let s: Session

  beforeAll(async () => {
    s = await startSession(FIXTURES, { columns: 170, rows: 50 })
    await prime(s, 'kanban')
  }, 120_000)

  afterAll(async () => {
    await s?.stop()
  })

  test('three columns side by side', async () => {
    s.send('card charlie token')
    await s.waitFor('TO DECIDE', TURN_MS)
    const heading = s.rows().find(row => row.includes('TO DECIDE'))!
    // one row carries all three: that is what makes it a kanban
    expect(heading).toMatch(/TO DECIDE · 1.*DONE · 5.*TO READ · 1/)
  }, TURN_MS)
})

describe.skipIf(!ready)('the kanban theme below 84 columns', () => {
  let s: Session

  beforeAll(async () => {
    // tall on purpose: stacked, the same card is three times the rows
    s = await startSession(FIXTURES, { columns: 80, rows: 60 })
    await prime(s, 'kanban')
  }, 120_000)

  afterAll(async () => {
    await s?.stop()
  })

  test('the three columns stack, because three 20-wide columns are not a kanban', async () => {
    s.send('card delta token')
    await s.waitFor('TO READ', TURN_MS)
    const rows = s.rows()
    const decide = rows.findIndex(row => row.includes('TO DECIDE · 1'))
    const done = rows.findIndex(row => row.trimStart().startsWith('DONE · 5'))
    const read = rows.findIndex(row => row.includes('TO READ · 1'))
    expect(decide).toBeGreaterThanOrEqual(0)
    expect(done).toBeGreaterThan(decide)
    expect(read).toBeGreaterThan(done)
  }, TURN_MS)
})

describe.skipIf(!ready)('narration between tool calls', () => {
  let s: Session

  beforeAll(async () => {
    // turn.step marks narration before render; no paced streaming needed
    s = await startSession(FIXTURES, { columns: 100, rows: 40 })
    await prime(s, 'receipt')
  }, 120_000)

  afterAll(async () => {
    await s?.stop()
  })

  test('the sentence the model said before its tool call becomes one dim line', async () => {
    s.send('narrate golf token')
    await s.waitFor('FOR YOU', SLOW_MS)
    const rows = s.rows()
    expect(rows.some(row => row.includes('· narration · 1 line'))).toBe(true)
    expect(rows.some(row => row.includes('Let me read the README before I answer.'))).toBe(false)
    // the card that ends the turn has no tool call after it, so it is never folded
    expect(rows.some(row => row.toUpperCase().includes('PATCH THE COPY OR KEEP THE ORIGINAL?'))).toBe(true)
  }, SLOW_MS)
})

describe.skipIf(!ready || !process.env.E2E_CLICK)('a click on the fold, under the fullscreen renderer', () => {
  let s: Session

  beforeAll(async () => {
    // CLAUDE_CODE_NO_FLICKER=1: mouse reports reach a Button only there
    s = await startSession(FIXTURES, { columns: 100, rows: 40, fullscreen: true })
    await prime(s, 'receipt')
  }, 120_000)

  afterAll(async () => {
    await s?.stop()
  })

  test('[ show ] reveals the skippable line', async () => {
    s.send('card echo token')
    await s.waitFor('1 skippable line [ show ]', TURN_MS)

    let revealed = false
    for (let waited = 0; waited < 5_000 && !revealed; waited += 1_000) {
      await s.click('show')
      await sleep(700)
      revealed = s.rows().some(row => row.includes('Clone and node_modules live in the scratchpad'))
    }
    expect(revealed).toBe(true)

    const rows = s.rows()
    expect(rows.some(row => row.includes('Clone and node_modules live in the scratchpad, disposable.'))).toBe(true)
    // the fold is reversible: the button now offers the way back
    expect(rows.some(row => row.includes('1 skippable line [ hide ]'))).toBe(true)
  }, TURN_MS)
})
