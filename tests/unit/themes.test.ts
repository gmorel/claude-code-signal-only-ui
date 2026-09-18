import { describe, expect, test } from 'bun:test'
import type { CardItem, CardModel, CardState, Marker, Theme, ThemeCtx } from '../../hooks/theme.ts'
import { themeOf } from '../../hooks/themes/index.ts'
import { theme as kanban, wrapRows } from '../../hooks/themes/kanban.ts'
import { theme as gmorel } from '../../hooks/themes/gmorel.ts'
import { theme as receipt } from '../../hooks/themes/receipt.ts'
import { room, softBreak } from '../../hooks/themes/_shared.ts'

// A theme is a pure function to a tree, so the tree is what is asserted: the
// fake element table keeps the props instead of drawing them.

type Node = { type: 'Box' | 'Text' | 'Button' | 'Code'; props: Record<string, unknown> }

const table = {
  Box: (props: Record<string, unknown>) => ({ type: 'Box', props }) as Node,
  Text: (props: Record<string, unknown>) => ({ type: 'Text', props }) as Node,
  Button: (props: Record<string, unknown>) => ({ type: 'Button', props }) as Node,
  Code: (props: Record<string, unknown>) => ({ type: 'Code', props }) as Node,
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && 'type' in value && 'props' in value

/** Depth-first, children in the order the theme wrote them: reading order. */
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
const buttons = (nodes: Node[]) => nodes.filter(n => n.type === 'Button')
const str = (node: Node): string => (typeof node.props.children === 'string' ? node.props.children : '')
// case-insensitive on purpose: receipt shouts its question, as a till prints
const indexOfText = (nodes: Node[], needle: string) =>
  nodes.findIndex(n => n.type === 'Text' && str(n).toLowerCase().includes(needle.toLowerCase()))

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
const CHOOSER_OPTIONS = [
  { key: '1', label: 'Patch it', detail: 'regex learns the prefix', estimate: '10 min', risk: 'low' as const, cost: '3 tests' },
  { key: '2', label: 'Keep original', detail: 'byte-identical copy', estimate: '0 min', risk: 'low' as const },
  { key: '3', label: 'Something else', detail: 'type your answer' },
]

const fixture = (): CardModel => {
  // the decide line is the verdict; four of the five done lines are bold in the
  // model on purpose — a theme must still draw exactly one bold line
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
    raw: 'irrelevant to a theme',
  }
}

const questionFixture = (): CardModel => {
  const decide = item('decide', QUESTION, {
    bold: true,
    lines: ['card-guard forces every reply into a quote'],
  })
  const done = DONE_TEXTS.map((text, i) => item('done', text, { bold: i < 4 }))
  const items = [decide, ...done, item('read', READ_TEXT), ...INFO_TEXTS.map(t => item('info', t)), item('skip', SKIP_TEXT)]
  return {
    preamble: [],
    header: true,
    verdict: decide,
    decision: {
      question: QUESTION,
      defaultText: 'Keep original',
      defaultKey: '2',
      options: [...CHOOSER_OPTIONS],
    },
    items,
    counts: { done: 5, decide: 1, blocked: 0, read: 1, info: 2, skip: 1 },
    quoted: true,
    raw: '',
  }
}

const boxes = (nodes: Node[]) => nodes.filter(n => n.type === 'Box')
const treeText = (nodes: Node[]) =>
  nodes.flatMap(n => (n.type === 'Text' || n.type === 'Button' ? [str(n)] : [])).join('\n')

/** Chrome that may be bold without being the verdict. */
const narrativeBold = (themeId: string, bold: Node[]): Node[] => {
  if (themeId === 'gmorel') return bold.filter(n => !/^\d+$/.test(str(n)) && !str(n).includes('👉'))
  if (themeId === 'kanban') {
    return bold.filter(n => !/^(TO DECIDE|DONE|TO READ|NOTES|OPTIONS|DECIDED|WHY I ASK) ·/.test(str(n)))
  }
  return bold
}

const skipSummary = (themeId: string): string => {
  if (themeId === 'gmorel') return '1 skippable detail hidden'
  if (themeId === 'kanban') return '+1 scrap folded'
  return '1 skippable line'
}

const optionButtonLabel = (_themeId: string, label: string): string => label

const skipShowButton = (nodes: Node[]) =>
  buttons(nodes).find(b => b.props.key === 'msg-1:toggle:skip' || (b.props.label === 'show' && b.props.key?.includes(':toggle:skip'))) ??
  buttons(nodes).find(b => b.props.label === 'show')!

type Calls = { toggled: string[]; filled: string[] }

const context = (
  over: { columns?: number; open?: CardState['open']; observerRunning?: boolean; hiddenReports?: number } = {},
): { ctx: ThemeCtx; calls: Calls } => {
  const calls: Calls = { toggled: [], filled: [] }
  const ctx = {
    el: table as unknown as ThemeCtx['el'],
    columns: over.columns ?? 76,
    surface: 'terminal',
    state: { open: over.open ?? {}, answered: null },
    actions: {
      toggle: (section: string) => void calls.toggled.push(section),
      fill: (text: string) => void calls.filled.push(text),
    },
    witness: { observerRunning: over.observerRunning ?? false, hiddenReports: over.hiddenReports ?? 0 },
    id: 'msg-1',
  } as unknown as ThemeCtx
  return { ctx, calls }
}

const THEMES: Theme[] = [receipt, kanban, gmorel]

for (const theme of THEMES) {
  describe(theme.id, () => {
    test('exports its own file stem as id, with a name and a tagline', () => {
      expect(['receipt', 'kanban', 'gmorel']).toContain(theme.id)
      expect(theme.name.length).toBeGreaterThan(0)
      expect(theme.tagline.length).toBeGreaterThan(0)
    })

    test('draws exactly one bold Text, and it is the verdict', () => {
      const { ctx } = context()
      const bold = texts(walk(theme.render(fixture(), ctx))).filter(n => n.props.bold === true)
      const narrative = narrativeBold(theme.id, bold)
      expect(narrative).toHaveLength(1)
      expect(str(narrative[0]!).toLowerCase()).toContain('fences inside a quote')
    })

    test('draws the decision before any done item', () => {
      const { ctx } = context()
      const nodes = walk(theme.render(fixture(), ctx))
      const decision = indexOfText(nodes, 'fences inside a quote')
      const firstDone = Math.min(...DONE_TEXTS.map(t => indexOfText(nodes, t)).filter(i => i >= 0))
      expect(decision).toBeGreaterThanOrEqual(0)
      expect(firstDone).toBeGreaterThan(decision)
    })

    test('folds skip by default: the line is gone, the summary and its control are not', () => {
      const { ctx } = context()
      const nodes = walk(theme.render(fixture(), ctx))
      expect(indexOfText(nodes, SKIP_TEXT)).toBe(-1)
      expect(indexOfText(nodes, skipSummary(theme.id))).toBeGreaterThanOrEqual(0)
      expect(buttons(nodes).some(b => b.props.label === 'show')).toBe(true)
    })

    test('the summary control toggles the section it summarises', () => {
      const { ctx, calls } = context()
      const nodes = walk(theme.render(fixture(), ctx))
      const show = skipShowButton(nodes)
      expect(show).toBeDefined()
      ;(show.props.onPress as () => void)()
      expect(calls.toggled).toEqual(['skip'])
    })

    test('an opened skip section shows its line and a control that folds it back', () => {
      const { ctx, calls } = context({ open: { skip: true } })
      const nodes = walk(theme.render(fixture(), ctx))
      expect(indexOfText(nodes, SKIP_TEXT)).toBeGreaterThanOrEqual(0)
      const hide = buttons(nodes).find(b => b.props.label === 'hide')!
      expect(hide).toBeDefined()
      ;(hide.props.onPress as () => void)()
      expect(calls.toggled).toEqual(['skip'])
    })

    test('the witness check follows hiddenReports and observerRunning', () => {
      const green = (nodes: Node[]) =>
        texts(nodes).filter(n => str(n) === '✓' && n.props.dimColor === true && n.props.color === 'green')
      const flag = (nodes: Node[]) => texts(nodes).filter(n => str(n).startsWith('⚑'))
      expect(green(walk(theme.render(fixture(), context().ctx)))).toHaveLength(0)
      expect(flag(walk(theme.render(fixture(), context().ctx)))).toHaveLength(0)
      expect(green(walk(theme.render(fixture(), context({ observerRunning: true }).ctx)))).toHaveLength(1)
      expect(green(walk(theme.render(fixture(), context({ hiddenReports: 2 }).ctx)))).toHaveLength(0)
      expect(flag(walk(theme.render(fixture(), context({ hiddenReports: 2 }).ctx)))).toHaveLength(1)
    })

    test('every item text appears in the rendered tree', () => {
      const model: CardModel = {
        preamble: [],
        header: true,
        verdict: item('decide', 'First decision?', { bold: true }),
        decision: { question: 'First decision?', defaultText: null, defaultKey: null, options: [] },
        items: [
          item('decide', 'First decision?', { bold: true }),
          item('decide', 'Second decision?'),
          item('blocked', 'First blocked'),
          item('blocked', 'Second blocked'),
          item('done', 'Done one'),
          item('done', 'Done two'),
          item('done', 'Done three'),
          item('read', 'Read one'),
          item('read', 'Read two'),
          item('info', 'Note one'),
          item('info', 'Note two'),
          item('skip', 'Skip one'),
          item('skip', 'Skip two'),
        ],
        counts: { decide: 2, blocked: 2, done: 3, read: 2, info: 2, skip: 2 },
        quoted: false,
        raw: '',
      }
      const { ctx } = context({ open: { skip: true, info: true, done: true, read: true } })
      const drawn = walk(theme.render(model, ctx))
        .flatMap(n => (n.type === 'Text' || n.type === 'Button' ? [str(n)] : []))
        .join('\n')
      for (const line of model.items) expect(drawn.toLowerCase()).toContain(line.text.toLowerCase())
    })

    test('each decision option is a Button that fills the prompt with its own text', () => {
      const { ctx, calls } = context()
      const nodes = walk(theme.render(fixture(), ctx))
      for (const option of OPTIONS) {
        const label = optionButtonLabel(theme.id, option.label)
        const button = buttons(nodes).find(b => b.props.label === label)!
        expect(button).toBeDefined()
        ;(button.props.onPress as () => void)()
      }
      expect(calls.filled).toEqual(OPTIONS.map(option => option.label))
    })

    test('a decision without options draws the question and its default clause alone', () => {
      const { ctx } = context()
      const model = fixture()
      model.decision = { question: QUESTION, defaultText: 'leave it', defaultKey: null, options: [] }
      const nodes = walk(theme.render(model, ctx))
      expect(indexOfText(nodes, 'fences inside a quote')).toBeGreaterThanOrEqual(0)
      expect(indexOfText(nodes, 'leave it')).toBeGreaterThanOrEqual(0)
      expect(buttons(nodes).some(b => b.props.label === 'yes' || b.props.label === 'no')).toBe(false)
    })

    test('no text wider than the columns it was given unless it wraps', () => {
      for (const columns of [40, 76, 120]) {
        const { ctx } = context({ columns, open: { skip: true } })
        const nodes = walk(theme.render(fixture(), ctx))
        for (const node of texts(nodes)) {
          if (str(node).length > columns) expect(node.props.wrap).toBe('wrap')
        }
        for (const node of walk(theme.render(fixture(), ctx)).filter(n => n.type === 'Box')) {
          if (typeof node.props.width === 'number') expect(node.props.width).toBeLessThanOrEqual(columns)
        }
      }
    })

    test('the fenced block of an item is drawn by Code, with its language', () => {
      const { ctx } = context()
      const code = walk(theme.render(fixture(), ctx)).filter(n => n.type === 'Code')
      expect(code).toHaveLength(1)
      expect(code[0]!.props.source).toBe('bun test tests/unit')
      expect(code[0]!.props.language).toBe('bash')
    })
  })
}

describe('softBreak', () => {
  test('short runs are unchanged', () => {
    expect(softBreak('short/path', 26)).toBe('short/path')
  })

  test('a long path breaks greedily so no segment exceeds the column', () => {
    const path = '/very/long/nested/path/that/exceeds/twenty/six'
    const broken = softBreak(path, 26)
    for (const run of broken.split(/\s+/)) expect(run.length).toBeLessThanOrEqual(26)
  })

  test('inserts the fewest breaks: one space at the last separator at or before width', () => {
    const path = '~/.claude/skills/claude-mermaid'
    const broken = softBreak(path, 26)
    expect(broken).toBe('~/.claude/skills/claude- mermaid')
    expect(broken.match(/ /g)?.length).toBe(1)
    for (const run of broken.split(/\s+/)) expect(run.length).toBeLessThanOrEqual(26)
  })

  test('breaks a long GitHub URL at width 26', () => {
    const url = 'https://github.com/gmorel/claude-code-signal-only-ui/blob/main/docs/kanban-question.png'
    const broken = softBreak(url, 26)
    expect(broken).not.toBe(url)
    for (const run of broken.split(/\s+/)) expect(run.length).toBeLessThanOrEqual(26)
  })

  test('splits off a tail after a separator-free head that exceeds width', () => {
    const run = 'a'.repeat(60) + '/tail'
    const broken = softBreak(run, 26)
    const pieces = broken.split(/\s+/)
    expect(pieces[pieces.length - 1]).toBe('tail')
    expect(pieces[0]!.length).toBeGreaterThan(26)
  })
})

describe('kanban columns', () => {
  const columnsBox = (nodes: Node[]) => nodes.find(n => n.props.key === 'msg-1:columns')!

  test('stacks below 84 columns: one column of columns, nothing side by side', () => {
    const { ctx } = context({ columns: 80 })
    const nodes = walk(kanban.render(fixture(), ctx))
    expect(columnsBox(nodes).props.flexDirection).toBe('column')
    expect(nodes.filter(n => n.props.flexDirection === 'row' && Array.isArray(n.props.children) && (n.props.children as unknown[]).length === 3)).toHaveLength(0)
  })

  test('three across once there is room', () => {
    const { ctx } = context({ columns: 120 })
    const nodes = walk(kanban.render(fixture(), ctx))
    expect(columnsBox(nodes).props.flexDirection).toBe('row')
    expect((columnsBox(nodes).props.children as unknown[]).length).toBe(3)
  })

  test('drops an empty TO DECIDE column when there is no decision and no decide items', () => {
    const done = DONE_TEXTS.map(text => item('done', text))
    const model: CardModel = {
      preamble: [],
      header: true,
      verdict: done[0]!,
      decision: null,
      items: [...done, item('read', READ_TEXT), ...INFO_TEXTS.map(t => item('info', t))],
      counts: { done: 5, decide: 0, blocked: 0, read: 1, info: 2, skip: 0 },
      quoted: false,
      raw: '',
    }
    const { ctx } = context({ columns: 120 })
    const nodes = walk(kanban.render(model, ctx))
    expect(texts(nodes).some(n => /^TO DECIDE/.test(str(n)))).toBe(false)
    expect(boxes(nodes).some(b => b.props.key === 'msg-1:column:decide')).toBe(false)
  })

  test('gives DONE more width than TO READ when done content is much longer', () => {
    const longDone = DONE_TEXTS.map(text => item('done', text.repeat(4)))
    const shortRead = item('read', READ_TEXT.slice(0, 20))
    const shortInfo = INFO_TEXTS.map(t => item('info', t.slice(0, 15)))
    const model: CardModel = {
      preamble: [],
      header: false,
      verdict: longDone[0]!,
      decision: null,
      items: [...longDone, shortRead, ...shortInfo],
      counts: { done: 5, decide: 0, blocked: 0, read: 1, info: 2, skip: 0 },
      quoted: false,
      raw: '',
    }
    const { ctx } = context({ columns: 120 })
    const nodes = walk(kanban.render(model, ctx))
    const doneCol = boxes(nodes).find(b => b.props.key === 'msg-1:column:done')!
    const readCol = boxes(nodes).find(b => b.props.key === 'msg-1:column:read')!
    expect(doneCol.props.width as number).toBeGreaterThan(readCol.props.width as number)
  })

  for (const columns of [100, 120]) {
    test(`surviving column widths respect clamps at ${columns} columns`, () => {
      const model = fixture()
      const { ctx } = context({ columns })
      const nodes = walk(kanban.render(model, ctx))
      const cols = boxes(nodes).filter(b => String(b.props.key).startsWith('msg-1:column:'))
      const maxW = Math.floor(columns * 0.55)
      let widthSum = 0
      for (const col of cols) {
        const w = col.props.width as number
        const minW = col.props.key === 'msg-1:column:decide' ? 28 : 18
        expect(w).toBeGreaterThanOrEqual(minW)
        expect(w).toBeLessThanOrEqual(maxW)
        widthSum += w
      }
      const gaps = Math.max(0, cols.length - 1) * 2
      expect(widthSum + gaps).toBeLessThanOrEqual(columns)
    })
  }

  for (const columns of [100, 120]) {
    test(`shipped card redistributes width to DONE at ${columns} columns`, () => {
      const model = fixture()
      const { ctx } = context({ columns })
      const nodes = walk(kanban.render(model, ctx))
      const decideCol = boxes(nodes).find(b => b.props.key === 'msg-1:column:decide')!
      const doneCol = boxes(nodes).find(b => b.props.key === 'msg-1:column:done')!
      const readCol = boxes(nodes).find(b => b.props.key === 'msg-1:column:read')!
      const widths = [decideCol.props.width as number, doneCol.props.width as number, readCol.props.width as number]
      const maxW = Math.floor(columns * 0.55)
      expect(widths.some((w, i) => w !== widths[0])).toBe(true)
      expect(doneCol.props.width as number).toBeGreaterThan(decideCol.props.width as number)
      expect(doneCol.props.width as number).toBeGreaterThan(readCol.props.width as number)
      expect(decideCol.props.width as number).toBeGreaterThanOrEqual(28)
      expect(doneCol.props.width as number).toBeGreaterThanOrEqual(18)
      expect(readCol.props.width as number).toBeGreaterThanOrEqual(18)
      for (const w of widths) {
        expect(w).toBeLessThanOrEqual(maxW)
      }
      const gaps = 2 * 2
      expect(widths.reduce((a, b) => a + b, 0) + gaps).toBeLessThanOrEqual(columns)
    })
  }
})

describe('kanban stickies', () => {
  const stickyNotes = (nodes: Node[]) =>
    boxes(nodes).filter(b => /^msg-1:sticky:\d+$/.test(String(b.props.key)))

  const FILL_TO_TAPE: Record<string, string> = {
    '#F2C14E': '#C89B2E',
    '#8EE0A8': '#5CC48A',
    '#F0A050': '#D89040',
    '#D9DEE5': '#B8BEC8',
  }

  const tapeColour = (fill: string): string => FILL_TO_TAPE[fill]!

  const shadowDrawn = (shadowRow: Node): Node => {
    const rowChildren = shadowRow.props.children as Node[]
    expect(rowChildren[0]!.props.width).toBe(1)
    const drawn = rowChildren[1]!
    expect(drawn.props.backgroundColor).toBe('#0E0E0E')
    expect(drawn.props.width).toBe((shadowRow.props.width as number) - 1)
    expect(drawn.props.height).toBe(1)
    expect(drawn.props.flexShrink).toBe(0)
    return drawn
  }

  const noteBodyFill = (sticky: Node): string | undefined => {
    const children = sticky.props.children as Node[]
    const body = children.find(c => String(c.props.key).endsWith(':body'))
    return body?.props.backgroundColor as string | undefined
  }

  const tapeHasTitle = (tape: Node): boolean => textsInBox(tape).length > 0

  const boxHasContent = (box: Node): boolean =>
    walk(box.props.children).some(n => n.type === 'Text' || n.type === 'Code')

  const noEmptyColouredBox = (sticky: Node): void => {
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) visit(child)
        return
      }
      if (!isNode(value) || value.type !== 'Box') return
      const bg = value.props.backgroundColor as string | undefined
      if (bg && (Object.values(FILL_TO_TAPE).includes(bg) || Object.keys(FILL_TO_TAPE).includes(bg))) {
        expect(boxHasContent(value)).toBe(true)
      }
      visit(value.props.children)
    }
    visit(sticky.props.children)
  }

  test('every plain sticky has a tape band with its title and an offset shadow row', () => {
    const { ctx } = context({ columns: 120 })
    const nodes = walk(kanban.render(fixture(), ctx))
    const stickies = stickyNotes(nodes)
    expect(stickies.length).toBeGreaterThan(0)
    for (const sticky of stickies) {
      const children = sticky.props.children as Node[]
      const tape = children[0]!
      const shadowRow = children[children.length - 1]!
      const fill = noteBodyFill(sticky) ?? Object.keys(FILL_TO_TAPE).find(f => tapeColour(f) === tape.props.backgroundColor)!
      expect(tape.props.backgroundColor).toBe(tapeColour(fill ?? '#8EE0A8'))
      expect(tape.props.width).toBe(sticky.props.width)
      expect(tape.props.paddingX).toBe(1)
      expect(tapeHasTitle(tape)).toBe(true)
      expect(shadowRow.props.flexDirection).toBe('row')
      expect(shadowRow.props.width).toBe(sticky.props.width)
      shadowDrawn(shadowRow)
      noEmptyColouredBox(sticky)
      if (children.length === 2) {
        expect(children[1]).toBe(shadowRow)
      } else {
        const body = children[1]!
        expect(body.props.backgroundColor).toBe(fill)
        expect(body).not.toBe(shadowRow)
        expect(children[2]).toBe(shadowRow)
      }
    }
  })

  test('the decision sticky has the same tape band and offset shadow', () => {
    const { ctx } = context({ columns: 120 })
    const nodes = walk(kanban.render(fixture(), ctx))
    const decision = boxes(nodes).find(b => b.props.key === 'msg-1:decision')!
    const decideCol = boxes(nodes).find(b => b.props.key === 'msg-1:column:decide')!
    const inner = room(decideCol.props.width as number, 4)
    const expected = wrapRows(softBreak(QUESTION, inner), inner)
    const children = decision.props.children as Node[]
    const tape = children[0]!
    const shadowRow = children[children.length - 1]!
    const body = children.length > 2 ? children[1]! : undefined
    expect(tape.props.backgroundColor).toBe('#C89B2E')
    expect(tapeHasTitle(tape)).toBe(true)
    expect(str(textsInBox(tape)[0]!)).toBe(expected[0])
    if (expected.length > 1) {
      expect(body).toBeDefined()
      const questionBody = textsInBox(body!)
        .map(str)
        .filter(t => !t.includes('if you say nothing'))
      expect(questionBody).toEqual(expected.slice(1))
    }
    const rendered = [expected[0], ...expected.slice(1)].join(' ')
    expect(rendered.toLowerCase()).toContain('fences inside a quote')
    expect(shadowRow.props.flexDirection).toBe('row')
    shadowDrawn(shadowRow)
    noEmptyColouredBox(decision)
  })

  const optionsBox = (nodes: Node[]) => boxes(nodes).find(b => b.props.key === 'msg-1:decision:options')!

  const buttonRowWidth = (labels: string[], gap: number): number =>
    labels.reduce((sum, label) => sum + label.length + 4, 0) + (labels.length - 1) * gap

  for (const columns of [100, 120]) {
    test(`two-option buttons fit their column at ${columns} columns`, () => {
      const { ctx } = context({ columns })
      const nodes = walk(kanban.render(fixture(), ctx))
      const decideCol = boxes(nodes).find(b => b.props.key === 'msg-1:column:decide')!
      const colW = decideCol.props.width as number
      const opts = optionsBox(nodes)
      expect(opts.props.width).toBe(colW)
      expect(opts.props.flexShrink).toBe(0)
      const labels = OPTIONS.map(o => o.label)
      if (buttonRowWidth(labels, 1) <= colW) {
        expect(opts.props.flexDirection).toBe('row')
        expect(buttonRowWidth(labels, 1)).toBeLessThanOrEqual(colW)
      } else {
        expect(opts.props.flexDirection).toBe('column')
      }
    })
  }

  test('option buttons stack when they cannot fit on one row', () => {
    const longOptions = [{ label: 'patch the copy' }, { label: 'keep the original' }]
    const model = fixture()
    model.decision = { question: QUESTION, defaultText: 'leave it', defaultKey: null, options: longOptions }
    const { ctx } = context({ columns: 84 })
    const nodes = walk(kanban.render(model, ctx))
    const decideCol = boxes(nodes).find(b => b.props.key === 'msg-1:column:decide')!
    const colW = decideCol.props.width as number
    const opts = optionsBox(nodes)
    expect(opts.props.width).toBe(colW)
    expect(opts.props.flexShrink).toBe(0)
    const labels = longOptions.map(o => o.label)
    expect(buttonRowWidth(labels, 1)).toBeGreaterThan(colW)
    expect(opts.props.flexDirection).toBe('column')
  })

  test('a one-row title leaves no lighter body between tape and shadow', () => {
    const short = item('done', 'Copied to ~/.claude/skills/claude-mermaid')
    const model: CardModel = {
      preamble: [],
      header: false,
      verdict: short,
      decision: null,
      items: [short],
      counts: { done: 1, decide: 0, blocked: 0, read: 0, info: 0, skip: 0 },
      quoted: false,
      raw: '',
    }
    const { ctx } = context({ columns: 120 })
    const nodes = walk(kanban.render(model, ctx))
    const sticky = stickyNotes(nodes)[0]!
    const children = sticky.props.children as Node[]
    expect(children).toHaveLength(2)
    expect(String(children[0]!.props.key).endsWith(':tape')).toBe(true)
    expect(String(children[1]!.props.key).endsWith(':shadow-row')).toBe(true)
    expect(noteBodyFill(sticky)).toBeUndefined()
  })

  test('a multi-row title splits across tape and lighter fill', () => {
    const title = 'alpha bravo charlie delta echo foxtrot golf hotel india'
    const model: CardModel = {
      preamble: [],
      header: false,
      verdict: item('done', title),
      decision: null,
      items: [item('done', title)],
      counts: { done: 1, decide: 0, blocked: 0, read: 0, info: 0, skip: 0 },
      quoted: false,
      raw: '',
    }
    const { ctx } = context({ columns: 40 })
    const nodes = walk(kanban.render(model, ctx))
    const sticky = stickyNotes(nodes)[0]!
    const stickyW = sticky.props.width as number
    const inner = room(stickyW, 4)
    const expected = wrapRows(softBreak(title, inner), inner)
    expect(expected.length).toBeGreaterThanOrEqual(2)

    const children = sticky.props.children as Node[]
    const tape = children[0]!
    const body = children[1]!
    expect(body.props.backgroundColor).toBe('#8EE0A8')
    expect(str(textsInBox(tape)[0]!)).toBe(expected[0])
    const bodyTexts = textsInBox(body).map(str)
    expect(bodyTexts.slice(0, expected.length - 1)).toEqual(expected.slice(1))
    expect(bodyTexts.join(' ')).toBe(expected.slice(1).join(' '))
    expect(wrapRows(title, inner).join(' ').split(/\s+/)).toEqual(title.split(/\s+/))
    for (const text of [...textsInBox(tape), ...textsInBox(body).slice(0, expected.length - 1)]) {
      expect(text.props.color).toBe('black')
      expect(text.props.dimColor).not.toBe(true)
    }
  })

  const FILL_AND_TAPE = new Set([
    '#F2C14E',
    '#C89B2E',
    '#8EE0A8',
    '#5CC48A',
    '#F0A050',
    '#D89040',
    '#D9DEE5',
    '#B8BEC8',
  ])

  const filledNoteRegions = (note: Node): Node[] => {
    const regions: Node[] = []
    const noteBg = note.props.backgroundColor as string | undefined
    if (noteBg && FILL_AND_TAPE.has(noteBg)) regions.push(note)
    for (const child of note.props.children as Node[]) {
      const bg = child.props.backgroundColor as string | undefined
      if (bg && FILL_AND_TAPE.has(bg)) regions.push(child)
    }
    return regions
  }

  const assertNothingDimOnFill = (note: Node): void => {
    for (const region of filledNoteRegions(note)) {
      for (const node of walk(region.props.children)) {
        expect(node.props.dimColor).not.toBe(true)
        if (node.type === 'Text') expect(node.props.color).toBe('black')
      }
    }
  }

  test('nothing on a note fill or tape is dim; title and continuation lines stay black', () => {
    const title = 'alpha bravo charlie delta echo foxtrot golf hotel india'
    const model: CardModel = {
      preamble: [],
      header: false,
      verdict: item('done', title, { lines: ['quieter continuation detail'] }),
      decision: null,
      items: [item('done', title, { lines: ['quieter continuation detail'] })],
      counts: { done: 1, decide: 0, blocked: 0, read: 0, info: 0, skip: 0 },
      quoted: false,
      raw: '',
    }
    const { ctx } = context({ columns: 40 })
    const nodes = walk(kanban.render(model, ctx))
    const sticky = stickyNotes(nodes)[0]!
    assertNothingDimOnFill(sticky)
    const children = sticky.props.children as Node[]
    const body = children[1]!
    const inner = room(sticky.props.width as number, 4)
    const expected = wrapRows(softBreak(title, inner), inner)
    const lineTexts = textsInBox(body).slice(expected.length - 1)
    expect(lineTexts).toHaveLength(1)
    expect(str(lineTexts[0]!)).toBe('quieter continuation detail')
    expect(lineTexts[0]!.props.color).toBe('black')
  })

  test('every element on fill or tape is black and not dim — continuation, multi-row title, decision sticky', () => {
    const multiTitle = 'alpha bravo charlie delta echo foxtrot golf hotel india'
    const continuationModel: CardModel = {
      preamble: [],
      header: false,
      verdict: item('done', 'short title', { lines: ['debug log read', 'second continuation'] }),
      decision: null,
      items: [item('done', 'short title', { lines: ['debug log read', 'second continuation'] })],
      counts: { done: 1, decide: 0, blocked: 0, read: 0, info: 0, skip: 0 },
      quoted: false,
      raw: '',
    }
    const multiRowModel: CardModel = {
      preamble: [],
      header: false,
      verdict: item('done', multiTitle),
      decision: null,
      items: [item('done', multiTitle)],
      counts: { done: 1, decide: 0, blocked: 0, read: 0, info: 0, skip: 0 },
      quoted: false,
      raw: '',
    }
    const decisionModel = fixture()
    const { ctx } = context({ columns: 40 })
    for (const model of [continuationModel, multiRowModel, decisionModel]) {
      const nodes = walk(kanban.render(model, ctx))
      for (const sticky of stickyNotes(nodes)) assertNothingDimOnFill(sticky)
      const decision = boxes(nodes).find(b => b.props.key === 'msg-1:decision')
      if (decision) assertNothingDimOnFill(decision)
    }
    const chooserNodes = walk(kanban.render(questionFixture(), context({ columns: 100 }).ctx))
    const summary = boxes(chooserNodes).find(b => b.props.key === 'msg-1:kanban-summary')!
    assertNothingDimOnFill(summary)
    for (const sticky of boxes(chooserNodes).filter(
      b => b.props.backgroundColor === '#F2C14E' && String(b.props.key).includes(':option:'),
    )) {
      assertNothingDimOnFill(sticky)
    }
  })

  test('decision question continuation rows stay black, not dim', () => {
    const question = 'Patch your copy so fences inside a quote are drawn too, including every nested block?'
    const model = fixture()
    model.decision = { question, defaultText: 'leave it', defaultKey: null, options: [...OPTIONS] }
    model.items[0] = item('decide', question, { bold: true })
    model.verdict = model.items[0]!
    const { ctx } = context({ columns: 40 })
    const nodes = walk(kanban.render(model, ctx))
    const decision = boxes(nodes).find(b => b.props.key === 'msg-1:decision')!
    const decideCol = boxes(nodes).find(b => b.props.key === 'msg-1:column:decide')!
    const inner = room(decideCol.props.width as number, 4)
    const expected = wrapRows(softBreak(question, inner), inner)
    expect(expected.length).toBeGreaterThanOrEqual(2)
    const children = decision.props.children as Node[]
    const tape = children[0]!
    const body = children[1]!
    for (const text of textsInBox(tape)) {
      expect(text.props.color).toBe('black')
      expect(text.props.dimColor).not.toBe(true)
    }
    const questionTexts = textsInBox(body).filter(t => !str(t).includes('if you say nothing'))
    expect(questionTexts.map(str)).toEqual(expected.slice(1))
    for (const text of questionTexts) {
      expect(text.props.color).toBe('black')
      expect(text.props.dimColor).not.toBe(true)
    }
  })
})

describe('wrapRows', () => {
  test('packs a sentence across several rows on word boundaries', () => {
    expect(wrapRows('one two three four five six', 8)).toEqual(['one two', 'three', 'four', 'five six'])
  })

  test('a word exactly width long occupies one row alone', () => {
    const word = 'a'.repeat(10)
    expect(wrapRows(`${word} tail`, 10)).toEqual([word, 'tail'])
    expect(wrapRows(word, 10)).toEqual([word])
  })

  test('a word longer than width gets its own overflowing row', () => {
    const long = 'x'.repeat(15)
    expect(wrapRows(`before ${long} after`, 10)).toEqual(['before', long, 'after'])
  })

  test('leading, trailing and doubled spaces produce no empty rows', () => {
    expect(wrapRows('  hello   world  ', 10)).toEqual(['hello', 'world'])
    expect(wrapRows('   ', 10)).toEqual([])
    expect(wrapRows('a  b', 10)).toEqual(['a b'])
    for (const rows of [wrapRows('  hello   world  ', 10), wrapRows('a  b', 10)]) {
      expect(rows.every(r => r.length > 0)).toBe(true)
    }
  })

  test('empty string and sub-one width', () => {
    expect(wrapRows('', 10)).toEqual([])
    expect(wrapRows('hello', 0)).toEqual(['hello'])
    expect(wrapRows('', 0)).toEqual([])
  })

  test('join preserves every input word in order', () => {
    const inputs = [
      'alpha bravo charlie delta',
      '  spaced   out  words ',
      'short',
      'overflow-' + 'z'.repeat(20),
    ]
    for (const text of inputs) {
      const words = text.trim().split(/\s+/).filter(w => w.length > 0)
      if (words.length === 0) continue
      const joined = wrapRows(text, 12).join(' ')
      const outWords = joined.split(/\s+/).filter(w => w.length > 0)
      expect(outWords).toEqual(words)
    }
  })
})

const SHIPPED: Theme[] = [receipt, kanban]

for (const theme of SHIPPED) {
  describe(`${theme.id} artboard`, () => {
    test('two-option card: frame, tints and key chrome', () => {
      const { ctx } = context({ columns: 100 })
      const nodes = walk(theme.render(fixture(), ctx))
      const frame = boxes(nodes).find(n => n.props.key === 'msg-1:frame')
      if (theme.id === 'receipt') {
        expect(frame?.props.borderStyle).toBe('classic')
        expect(indexOfText(nodes, 'FOR YOU')).toBeGreaterThanOrEqual(0)
        expect(indexOfText(nodes, '[OK]')).toBeGreaterThanOrEqual(0)
      }
      if (theme.id === 'kanban') {
        expect(boxes(nodes).some(b => b.props.backgroundColor === '#F2C14E')).toBe(true)
        expect(indexOfText(nodes, 'TO DECIDE')).toBeGreaterThanOrEqual(0)
        expect(indexOfText(nodes, 'DONE')).toBeGreaterThanOrEqual(0)
      }
    })

    test('three-option chooser: titles, default badge, meta and numbered buttons', () => {
      const { ctx } = context({ columns: 100 })
      const nodes = walk(theme.render(questionFixture(), ctx))
      for (const option of CHOOSER_OPTIONS) {
        expect(indexOfText(nodes, option.label)).toBeGreaterThanOrEqual(0)
      }
      expect(treeText(nodes).toLowerCase()).toMatch(/default/)
      expect(indexOfText(nodes, '10 min')).toBeGreaterThanOrEqual(0)
      expect(indexOfText(nodes, 'risk')).toBeGreaterThanOrEqual(0)
      const numbered = buttons(nodes).filter(b => String(b.props.label).match(/^[123]$/))
      expect(numbered.length).toBeGreaterThanOrEqual(3)
    })

    test('chooser layout stacks below the wide threshold', () => {
      const narrow = theme.id === 'kanban' ? 80 : 76
      const { ctx } = context({ columns: narrow })
      const nodes = walk(theme.render(questionFixture(), ctx))
      if (theme.id === 'kanban') {
        const chooserCols = boxes(nodes).find(n => n.props.key === 'msg-1:chooser-cols')
        expect(chooserCols?.props.flexDirection).toBe('column')
      }
    })

    test('never invents recommendation language or markdown emphasis', () => {
      const { ctx } = context({ columns: 100 })
      const drawn = treeText(walk(theme.render(questionFixture(), ctx)))
      expect(drawn).not.toMatch(/\*\*/)
      expect(drawn.toLowerCase()).not.toMatch(/proven|recommended|verified/)
    })
  })
}

describe('receipt keeps to the till roll', () => {
  test('no box drawing and no emoji, the witness check apart', () => {
    const { ctx } = context({ open: { skip: true }, observerRunning: true })
    const nodes = walk(receipt.render(fixture(), ctx))
    const drawn = [...texts(nodes).map(str), ...buttons(nodes).map(b => String(b.props.label))].join('')
    // U+2500..U+257F is box drawing; the emoji planes start at U+1F300
    expect(drawn.replace(/✓/gu, '')).not.toMatch(/[─-╿\u{1F300}-\u{1FAFF}]/u)
  })
})

const borderSpent = (props: Record<string, unknown>): number => {
  let spent = 0
  if (props.borderStyle) spent += 2
  if (typeof props.paddingX === 'number') spent += props.paddingX * 2
  return spent
}

const forEachTextInBorderedBox = (
  value: unknown,
  avail: number | undefined,
  visit: (text: Node, limit: number) => void,
): void => {
  if (Array.isArray(value)) {
    for (const child of value) forEachTextInBorderedBox(child, avail, visit)
    return
  }
  if (!isNode(value)) return
  const width = typeof value.props.width === 'number' ? value.props.width : avail
  if (value.type === 'Box' && value.props.borderStyle && width !== undefined) {
    const limit = Math.max(8, width - borderSpent(value.props))
    const walkInside = (inner: unknown): void => {
      if (Array.isArray(inner)) {
        for (const child of inner) walkInside(child)
        return
      }
      if (!isNode(inner)) return
      if (inner.type === 'Text') visit(inner, limit)
      else if (inner.type === 'Box' && inner.props.borderStyle) {
        const nestedW = typeof inner.props.width === 'number' ? inner.props.width : limit
        forEachTextInBorderedBox(inner, nestedW, visit)
      } else walkInside(inner.props.children)
    }
    walkInside(value.props.children)
    return
  }
  forEachTextInBorderedBox(value.props.children, width, visit)
}

describe('kanban frame width', () => {
  const borderedTexts = (columns: number) => {
    const { ctx } = context({ columns, open: { skip: true } })
    const root = kanban.render(questionFixture(), ctx)
    const found: { text: Node; limit: number }[] = []
    forEachTextInBorderedBox(root, columns, (text, limit) => found.push({ text, limit }))
    return found
  }

  for (const columns of [80, 100, 120]) {
    test(`bordered text stays inside the frame at ${columns} columns`, () => {
      for (const { text, limit } of borderedTexts(columns)) {
        expect(str(text).length).toBeLessThanOrEqual(limit)
      }
    })
  }
})

describe('gmorel frame width', () => {
  const borderedTexts = (columns: number) => {
    const { ctx } = context({ columns, open: { skip: true } })
    const root = gmorel.render(fixture(), ctx)
    const found: { text: Node; limit: number }[] = []
    forEachTextInBorderedBox(root, columns, (text, limit) => found.push({ text, limit }))
    return found
  }

  for (const columns of [80, 100, 120]) {
    test(`bordered text stays inside the frame at ${columns} columns`, () => {
      for (const { text, limit } of borderedTexts(columns)) {
        expect(str(text).length).toBeLessThanOrEqual(limit)
      }
    })
  }
})

describe('receipt frame width', () => {
  const frameNodes = (columns: number) => {
    const { ctx } = context({ columns, open: { skip: true } })
    const nodes = walk(receipt.render(fixture(), ctx))
    const frame = boxes(nodes).find(n => n.props.key === 'msg-1:frame')!
    return walk(frame)
  }

  const leaderTag = (nodes: Node[]) =>
    texts(nodes).filter(n => {
      const s = str(n)
      return /^\s*\[(?:OK|!!|\?\?)\]$/.test(s) || (s.includes('.') && /\[(?:OK|!!|\?\?)\]/.test(s))
    })

  for (const columns of [80, 100, 120]) {
    test(`framed text stays inside the border at ${columns} columns`, () => {
      const limit = columns - 2
      for (const node of texts(frameNodes(columns))) {
        expect(str(node).length).toBeLessThanOrEqual(limit)
      }
    })

    test(`leader rows keep literal tags at ${columns} columns`, () => {
      const nodes = frameNodes(columns)
      const tags = leaderTag(nodes)
      expect(tags.length).toBeGreaterThan(0)
      for (const node of tags) {
        expect(str(node)).toMatch(/\[(?:OK|!!|\?\?)\]$/)
        expect(str(node)).not.toMatch(/\[\|/)
      }
      const drawn = texts(nodes).map(str).join('\n')
      expect(drawn).toContain('[OK]')
      expect(drawn).toContain('[!!]')
      expect(drawn).toContain('[??]')
    })
  }
})

const DEFAULT_FILL = '#F2C14E'

const receiptNumPrefix = (n: number, isDefault: boolean): string => {
  const raw = String(n) + (isDefault ? '*' : '')
  return raw.length >= 3 ? raw.slice(0, 3) : raw + ' '.repeat(3 - raw.length)
}

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

describe('chooser rendering', () => {
  test('no Button label passed by any theme is wrapped in brackets', () => {
    for (const theme of THEMES) {
      const { ctx } = context({ columns: 100 })
      for (const btn of buttons(walk(theme.render(questionFixture(), ctx)))) {
        const label = String(btn.props.label)
        expect(label.startsWith('[')).toBe(false)
        expect(label.endsWith(']')).toBe(false)
      }
    }
  })

  test('receipt table: TIME and RISK columns align with the header on every row', () => {
    const COL_NUM = 3
    const COL_TIME = 8
    const COL_RISK = 7
    const COL_GAP = 2
    const { ctx } = context({ columns: 100 })
    const nodes = walk(receipt.render(questionFixture(), ctx))
    const header = texts(nodes).map(str).find(s => s.includes('ITEM') && s.includes('TIME') && s.includes('RISK'))!
    expect(header).toBeDefined()
    const timeStart = header.length - COL_RISK - COL_GAP - COL_TIME
    const riskStart = header.length - COL_RISK
    expect(header.slice(timeStart, timeStart + COL_TIME).trim()).toBe('TIME')
    expect(header.slice(riskStart, riskStart + COL_RISK).trim()).toBe('RISK')
    for (const [i, option] of CHOOSER_OPTIONS.entries()) {
      const row = texts(nodes).map(str).find(s => s.length === header.length && s.startsWith(receiptNumPrefix(i + 1, option.key === '2')))!
      expect(row).toBeDefined()
      expect(row.slice(COL_NUM, COL_NUM + COL_GAP)).toBe(' '.repeat(COL_GAP))
      if (option.estimate) {
        expect(row.slice(timeStart, timeStart + COL_TIME).trim()).toBe(option.estimate.toUpperCase())
      } else {
        expect(row.slice(timeStart, timeStart + COL_TIME).trim()).toBe('')
      }
      if (option.risk) {
        expect(row.slice(riskStart, riskStart + COL_RISK).trim()).toBe(option.risk.toUpperCase())
      } else {
        expect(row.slice(riskStart, riskStart + COL_RISK).trim()).toBe('')
      }
    }
  })

  for (const columns of [100, 120]) {
    test(`kanban OPTIONS stickies stay within column width at ${columns} columns`, () => {
      const { ctx } = context({ columns })
      const nodes = walk(kanban.render(questionFixture(), ctx))
      const optionsCol = boxes(nodes).find(n => n.props.key === 'msg-1:chooser-col:0')!
      expect(optionsCol).toBeDefined()
      const colW = optionsCol.props.width as number
      const stickies = boxes(nodes).filter(
        b => b.props.backgroundColor === '#F2C14E' && String(b.props.key).includes(':option:'),
      )
      expect(stickies.length).toBeGreaterThanOrEqual(3)
      for (const sticky of stickies) {
        expect(sticky.props.width).toBeLessThanOrEqual(colW)
        expect(sticky.props.flexShrink).toBe(0)
        for (const text of textsInBox(sticky)) {
          if (str(text).length > colW - 2) expect(text.props.wrap).toBe('wrap')
        }
      }
    })
  }
})

describe('themeOf', () => {
  test('unknown or removed ids resolve to gmorel and still render the fixture', () => {
    const theme = themeOf('no-such-theme')
    expect(theme.id).toBe('gmorel')
    const { ctx } = context()
    const nodes = walk(theme.render(fixture(), ctx))
    expect(indexOfText(nodes, 'fences inside a quote')).toBeGreaterThanOrEqual(0)
  })
})
