import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isHeader, markerOf, parseCard, parseDecision, unbold, unquote } from '../../hooks/card.ts'

// SPEC §5: the grammar of hooks/card.ts, in both languages, quoted and not.

const lines = (...rows: string[]) => rows.join('\n')

/** the card this plugin exists to draw, as the model writes it: blockquoted, headed, one bold decision */
const EN = lines(
  '> **👉 For you**',
  '> 🟡 **Decide: patch the copy so quoted fences draw too? If you say nothing: I leave it as is.**',
  '> 🟢 42/42 unit tests in the copy.',
  '> ⚠️ Two ui.render hooks would fire if the CI badge had stayed red.',
  '> ▫️ renamed `config.yml` to `config.yaml`; 12 tests still pass.',
  '> ℹ️ Clone and node_modules live in the scratchpad.',
)

/** the same card in French, whose decision does carry two short answers */
const FR = lines(
  '> **👉 Pour toi**',
  '> 🟡 **À décider : corriger la copie ou la laisser ? Sans réponse de ta part : je la laisse telle quelle.**',
  '> 🟢 42/42 tests unitaires dans la copie.',
  '> ⚠️ Deux hooks ui.render se déclencheraient si la copie du marketplace était restée.',
  "> ▫️ `config.yml` renommé en `config.yaml` ; 12 tests passent encore.",
  '> ℹ️ Le clone et node_modules vivent dans le scratchpad.',
)

/** the wrapper is a presentation rule the mod makes unnecessary, so the same card without it must parse */
const EN_PLAIN = EN.split('\n')
  .map(line => line.replace(/^> /, ''))
  .join('\n')

describe('unquote', () => {
  test('strips one level of `>` and reports a fully quoted block', () => {
    const out = unquote(EN)
    expect(out.quoted).toBe(true)
    expect(out.lines[0]).toBe('**👉 For you**')
  })

  test('one unquoted line is enough to make the block unquoted', () => {
    expect(unquote(lines('> 🟢 done', '🟡 decide')).quoted).toBe(false)
  })

  test('a blank line does not decide quotedness', () => {
    expect(unquote(lines('> 🟢 done', '', '> 🟡 decide')).quoted).toBe(true)
  })

  test('a block with no quote marks at all is unquoted', () => {
    expect(unquote(EN_PLAIN).quoted).toBe(false)
  })
})

describe('markerOf', () => {
  test('reads every glyph, with and without the variation selector', () => {
    expect(markerOf('🟢 done')).toEqual({ marker: 'done', text: 'done' })
    expect(markerOf('🟡 decide')).toEqual({ marker: 'decide', text: 'decide' })
    expect(markerOf('🔴 blocked')).toEqual({ marker: 'blocked', text: 'blocked' })
    expect(markerOf('⚠️ read')).toEqual({ marker: 'read', text: 'read' })
    expect(markerOf('⚠ read')).toEqual({ marker: 'read', text: 'read' })
    expect(markerOf('▫️ info')).toEqual({ marker: 'info', text: 'info' })
    expect(markerOf('▫ info')).toEqual({ marker: 'info', text: 'info' })
    expect(markerOf('ℹ️ skip')).toEqual({ marker: 'skip', text: 'skip' })
    expect(markerOf('ℹ skip')).toEqual({ marker: 'skip', text: 'skip' })
  })

  test('a line without a glyph opens no item', () => {
    expect(markerOf('just a sentence')).toBeNull()
    expect(markerOf('the 🟢 was mid-line')).toBeNull()
  })
})

describe('isHeader', () => {
  test('both languages, bold optional, trailing spaces ignored', () => {
    expect(isHeader('**👉 For you**')).toBe(true)
    expect(isHeader('👉 For you  ')).toBe(true)
    expect(isHeader('**👉 Pour toi**')).toBe(true)
    expect(isHeader('👉 Pour toi')).toBe(true)
  })

  test('anything else is an item or a line', () => {
    expect(isHeader('🟢 For you')).toBe(false)
    expect(isHeader('**👉 For the team**')).toBe(false)
  })
})

describe('unbold', () => {
  test('stars around the whole text', () => {
    expect(unbold('**Decide: do it?**')).toEqual({ text: 'Decide: do it?', bold: true })
  })

  test('stars around the text after a label', () => {
    expect(unbold('À décider : **corriger ?**')).toEqual({ text: 'À décider : corriger ?', bold: true })
  })

  test('no stars, no bold, text untouched', () => {
    expect(unbold('42/42 unit tests in the copy.')).toEqual({ text: '42/42 unit tests in the copy.', bold: false })
  })

  test('two bold spans strip both and are not bold', () => {
    expect(unbold('**foo** and **bar**')).toEqual({ text: 'foo and bar', bold: false })
  })
})

describe('parseDecision', () => {
  test('English label and default clause', () => {
    expect(parseDecision('Decide: patch the copy so quoted fences draw too? If you say nothing: I leave it as is.')).toEqual({
      question: 'patch the copy so quoted fences draw too?',
      defaultText: 'I leave it as is.',
      defaultKey: null,
      options: [],
    })
  })

  test('French label and default clause', () => {
    expect(parseDecision('À décider : corriger ou laisser ? Sans réponse de ta part : je la laisse telle quelle.')).toEqual({
      question: 'corriger ou laisser ?',
      defaultText: 'je la laisse telle quelle.',
      defaultKey: null,
      options: [{ label: 'corriger' }, { label: 'laisser' }],
    })
  })

  test('`Decision:` is a label too', () => {
    expect(parseDecision('Decision: ship it?').question).toBe('ship it?')
  })

  test('`A or B?` gives two short answers', () => {
    expect(parseDecision('Decide: patch it or leave it?').options).toEqual([{ label: 'patch it' }, { label: 'leave it' }])
  })

  test('`A, B or C?` gives three keyed answers with inline titles and a default key', () => {
    expect(
      parseDecision(
        'Decide: A, B or C? How should CI run once the repo is public. A = fake both. B = record real sessions. C = install both. If you say nothing: B',
      ),
    ).toEqual({
      question: 'A, B, C? How should CI run once the repo is public.',
      defaultText: 'B',
      defaultKey: 'B',
      options: [
        { key: 'A', label: 'fake both' },
        { key: 'B', label: 'record real sessions' },
        { key: 'C', label: 'install both' },
      ],
    })
  })

  test('a side over 40 characters is a sentence, not a button', () => {
    const long = 'rewrite every quoted fence in the transcript by hand tonight'
    expect(parseDecision(`Decide: ${long} or leave it?`).options).toEqual([])
  })

  test('a question with no conjunction has no options', () => {
    expect(parseDecision('Decide: should the fold default to closed?').options).toEqual([])
  })

  test('no default clause leaves defaultText null', () => {
    expect(parseDecision('Decide: ship it?').defaultText).toBeNull()
  })

  test('default clause is case-insensitive and accepts alternate phrasings', () => {
    expect(parseDecision('Decide: ship it? DEFAULT: wait').defaultText).toBe('wait')
    expect(parseDecision('À décider : partir ? Par défaut : demain').defaultText).toBe('demain')
    expect(parseDecision('Decide: ship it? Sans réponse : later').defaultText).toBe('later')
  })

  test('default clause is read from continuation lines', () => {
    expect(parseDecision('Decide: ship it?', ['If you say nothing: hold']).defaultText).toBe('hold')
  })

  test('interrogative stems are stripped from option labels', () => {
    expect(parseDecision('Decide: should I patch it or leave it?').options).toEqual([{ label: 'patch it' }, { label: 'leave it' }])
  })

  test('lopsided option sides are dropped', () => {
    expect(parseDecision('Decide: patch it or rewrite every quoted fence in the transcript by hand tonight?').options).toEqual([])
  })
})

describe('parseCard', () => {
  test('the English card, quoted', () => {
    const card = parseCard(EN)
    expect(card).not.toBeNull()
    expect(card!.quoted).toBe(true)
    expect(card!.header).toBe(true)
    expect(card!.items).toHaveLength(5)
    expect(card!.counts).toEqual({ done: 1, decide: 1, blocked: 0, read: 1, info: 1, skip: 1 })
    expect(card!.raw).toBe(EN)
  })

  test('the verdict is the bold decision, its stars gone', () => {
    const card = parseCard(EN)!
    expect(card.verdict?.marker).toBe('decide')
    expect(card.verdict?.bold).toBe(true)
    expect(card.verdict?.text.startsWith('Decide: patch the copy')).toBe(true)
  })

  test('the first bold line is the verdict when no decision is bold', () => {
    const card = parseCard(lines('🟢 **42/42 unit tests in the copy.**', '⚠️ Two ui.render hooks would fire.'))!
    expect(card.verdict?.marker).toBe('done')
    expect(card.decision).toBeNull()
  })

  test('no bold line, no verdict', () => {
    const card = parseCard(lines('🟢 42/42 unit tests.', '⚠️ Two ui.render hooks would fire.'))!
    expect(card.verdict).toBeNull()
  })

  test('the decision is read off the 🟡 line', () => {
    const card = parseCard(EN)!
    expect(card.decision).toEqual({
      question: 'patch the copy so quoted fences draw too?',
      defaultText: 'I leave it as is.',
      defaultKey: null,
      options: [],
    })
  })

  test('the French twin: `À décider :`, `Sans réponse de ta part :`, `A ou B ?`', () => {
    const card = parseCard(FR)!
    expect(card.header).toBe(true)
    expect(card.quoted).toBe(true)
    expect(card.counts).toEqual({ done: 1, decide: 1, blocked: 0, read: 1, info: 1, skip: 1 })
    expect(card.decision).toEqual({
      question: 'corriger la copie ou la laisser ?',
      defaultText: 'je la laisse telle quelle.',
      defaultKey: null,
      options: [{ label: 'corriger la copie' }, { label: 'la laisser' }],
    })
  })

  test('the French three-option fixture: keys, details, meta and default', () => {
    const card = parseCard(readFileSync(join(import.meta.dir, 'fixtures/three-options.txt'), 'utf8'))!
    expect(card.decision?.defaultKey).toBe('B')
    expect(card.decision?.options).toEqual([
      { key: 'A', label: 'fake both', detail: 'fake both. ~2h. Risk: high.', estimate: '2h', risk: 'high' },
      {
        key: 'B',
        label: 'record real sessions',
        detail: 'record real sessions. ≈ 45 min. risque : faible. Coût : ~$1.',
        estimate: '45 min',
        risk: 'low',
        cost: '~$1',
      },
      { key: 'C', label: 'install both', detail: 'install both. 1 day. Risk: medium.', estimate: '1 day', risk: 'medium' },
    ])
    expect(card.items.filter(item => item.marker === 'info').map(item => item.text)).toEqual([])
  })

  test('the English three-option twin parses the same shape', () => {
    const EN_THREE = lines(
      '**👉 For you**',
      '🟡 **Decide: A, B or C? How should CI run once the repo is public. A = fake both. B = record real sessions. C = install both. If you say nothing: B**',
      '▫️ A — fake both. ~2h. Risk: high.',
      '▫️ B — record real sessions. ≈ 45 min. Risk: low. Cost: ~$1.',
      '▫️ C — install both. 1 day. Risk: medium.',
      '🟢 42/42 unit tests pass.',
      '⚠️ The README badge will say failing without a CI answer.',
    )
    const card = parseCard(EN_THREE)!
    expect(card.decision?.defaultKey).toBe('B')
    expect(card.decision?.options.map(option => option.key)).toEqual(['A', 'B', 'C'])
    expect(card.decision?.options[1]?.risk).toBe('low')
    expect(card.items.filter(item => item.marker === 'info')).toHaveLength(0)
  })

  test('the same card without the `>` wrapper parses the same way', () => {
    const quoted = parseCard(EN)!
    const plain = parseCard(EN_PLAIN)!
    expect(plain.quoted).toBe(false)
    expect(plain.header).toBe(true)
    expect(plain.counts).toEqual(quoted.counts)
    expect(plain.items.map(item => item.text)).toEqual(quoted.items.map(item => item.text))
    expect(plain.decision).toEqual(quoted.decision)
  })

  test('the header is not an item', () => {
    const card = parseCard(lines('**👉 For you**', '🟢 done', '⚠️ read'))!
    expect(card.header).toBe(true)
    expect(card.items).toHaveLength(2)
  })

  test('a card with no header still parses', () => {
    const card = parseCard(lines('🟢 42/42 unit tests.', '⚠️ Two ui.render hooks would fire.'))!
    expect(card.header).toBe(false)
    expect(card.items).toHaveLength(2)
  })

  test('a line without a marker continues the item above it', () => {
    const card = parseCard(
      lines('> 🟢 42/42 unit tests in the copy.', '> ran with bun test, no dependencies.', '> ⚠️ Two ui.render hooks would fire.'),
    )!
    expect(card.items[0]!.lines).toEqual(['ran with bun test, no dependencies.'])
    expect(card.items[1]!.lines).toEqual([])
  })

  test('lines before the first marker are kept in preamble', () => {
    const card = parseCard(lines('Here is where things stand.', '🟢 42/42 unit tests.', '⚠️ Two hooks would fire.'))!
    expect(card.preamble).toEqual(['Here is where things stand.'])
    expect(card.items).toHaveLength(2)
    expect(card.items[0]!.lines).toEqual([])
  })

  test('one prose line plus two distinct markers is a card that keeps the prose', () => {
    const card = parseCard(lines('Here is where things stand.', '🟢 tests green.', '🔴 need your API key.'))!
    expect(card).not.toBeNull()
    expect(card!.preamble).toEqual(['Here is where things stand.'])
    expect(card!.counts).toEqual({ done: 1, decide: 0, blocked: 1, read: 0, info: 0, skip: 0 })
  })

  test('ten prose lines with two done markers is not a card', () => {
    const body = [
      'Line one.',
      'Line two.',
      'Line three.',
      'Line four.',
      'Line five.',
      'Line six.',
      'Line seven.',
      'Line eight.',
      '🟢 first done.',
      '🟢 second done.',
    ]
    expect(parseCard(lines(...body))).toBeNull()
  })

  test('one done marker with ten continuation lines and one info marker is a card', () => {
    const body = ['🟢 tests passed', ...Array.from({ length: 10 }, (_, i) => `line ${i + 1}`), '▫️ note']
    expect(parseCard(lines(...body))).not.toBeNull()
  })

  test('a fence inside a quoted card attaches to the item above it, language kept', () => {
    const card = parseCard(
      lines('> 🟢 42/42 unit tests in the copy.', '> ```bash', '> bun test tests/unit', '> ```', '> ⚠️ Two ui.render hooks would fire.'),
    )!
    expect(card.items).toHaveLength(2)
    expect(card.items[0]!.code).toEqual([{ lang: 'bash', source: 'bun test tests/unit' }])
    expect(card.items[1]!.code).toEqual([])
  })

  test('a fence keeps its blank lines and its indentation verbatim', () => {
    const card = parseCard(lines('🟢 the registry', '```ts', 'export const themes = {', '', '  receipt,', '}', '```', '⚠️ two hooks'))!
    expect(card.items[0]!.code[0]).toEqual({ lang: 'ts', source: 'export const themes = {\n\n  receipt,\n}' })
  })

  test('an unclosed fence runs to the end of the block', () => {
    const card = parseCard(lines('🟢 the registry', '⚠️ two hooks', '```ts', 'const a = 1'))!
    expect(card.items[1]!.code).toEqual([{ lang: 'ts', source: 'const a = 1' }])
  })

  test('a shorter closing fence inside a fence does not close early', () => {
    const card = parseCard(lines('🟢 nested', '````ts', 'outer', '```not a close', 'still outer', '````', '⚠️ tail'))!
    expect(card.items[0]!.code[0]?.source).toBe('outer\n```not a close\nstill outer')
  })

  test('counts every marker, blocked included', () => {
    const card = parseCard(lines('🔴 need your API key in .env.', '🔴 CI badge still red.', '🟢 12 tests pass.'))!
    expect(card.counts).toEqual({ done: 1, decide: 0, blocked: 2, read: 0, info: 0, skip: 0 })
  })

  test('plain prose is not a card', () => {
    expect(parseCard('I looked at the two copies and the marketplace one is the older.\nNothing else changed.')).toBeNull()
  })

  test('a lone fenced block is not a card', () => {
    expect(parseCard(lines('```ts', 'export const themes = {}', '```'))).toBeNull()
  })

  test('one marker followed by prose is a card whose item carries the prose as continuation lines', () => {
    const model = parseCard('🟢 Done.\nThe rename touched three files.\nAll tests pass.')
    expect(model).not.toBeNull()
    expect(model!.items).toHaveLength(1)
    expect(model!.items[0].lines).toEqual(['The rename touched three files.', 'All tests pass.'])
  })

  test('one marker with preamble prose is not a card', () => {
    expect(parseCard(lines('and that is all there is to say.', '🟢 42/42 unit tests in the copy.'))).toBeNull()
  })

  test('the empty block is not a card', () => {
    expect(parseCard('')).toBeNull()
  })
})
