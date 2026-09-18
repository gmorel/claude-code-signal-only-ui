import type { RenderElement, TextProps } from 'claude-code'
import type { CardItem, CardModel, Decision, DecisionOption, Marker, Theme, ThemeCtx } from '../theme.ts'
import {
  cleanText,
  codeBlocks,
  decisionIndex,
  grouped,
  isOpen,
  needsFoldRow,
  optionFill,
  preambleLines,
  room,
  sectionOf,
  verdictIndex,
  witnessMark,
  type Group,
  type Section,
} from './_shared.ts'

// Receipt (design/artboards/DirectionF.dc.html, F2 for questions): one colour,
// ASCII only — a classic frame, dotted leaders, the question as an order form.

const INK = 'yellow'
const WIDE = 80
/** classic border (2) + paddingX 1 (2) on the till-roll frame */
const FRAME_SPENT = 4

const ink = (ctx: ThemeCtx, props: TextProps & { children: string }): RenderElement =>
  ctx.el.Text({ color: INK, ...props })

const TAG: Record<Marker, string> = {
  decide: '[??]',
  blocked: '[!!]',
  read: '[!!]',
  done: '[OK]',
  info: '',
  skip: '',
}

/** skip closed (SPEC §4); chooser mode closes done/read/info. */
const DEFAULT_OPEN: Record<Section, boolean> = { done: true, read: true, info: true, skip: false }

const sectionOpen = (ctx: ThemeCtx, section: Section, chooser: boolean): boolean =>
  isOpen(ctx.state, section, chooser && section !== 'skip' ? false : DEFAULT_OPEN[section])

const restFolded = (ctx: ThemeCtx, chooser: boolean): boolean =>
  chooser && !sectionOpen(ctx, 'done', true) && !sectionOpen(ctx, 'read', true) && !sectionOpen(ctx, 'info', true)

const openRest = (ctx: ThemeCtx): void => {
  for (const section of ['done', 'read', 'info'] as const) {
    if (!sectionOpen(ctx, section, true)) ctx.actions.toggle(section)
  }
}

const centred = (text: string, width: number): string => {
  if (text.length >= width) return text.slice(0, width)
  const left = Math.floor((width - text.length) / 2)
  return ' '.repeat(left) + text + ' '.repeat(width - text.length - left)
}

const decisionContext = (item: CardItem | undefined): string | null => {
  if (!item || item.lines.length === 0) return null
  return item.lines.map(cleanText).join(' ')
}

const defaultClause = (decision: Decision): string | null =>
  decision.defaultText === null ? null : `default: ${decision.defaultText}`

const defaultNumber = (decision: Decision): number => {
  if (decision.defaultKey !== null) {
    const i = decision.options.findIndex(o => o.key === decision.defaultKey)
    if (i >= 0) return i + 1
  }
  const i = decision.options.findIndex(o => o.label === decision.defaultText)
  return i >= 0 ? i + 1 : 1
}

const foldFooter = (model: CardModel): string =>
  `below the fold: ${model.counts.done} done [OK] · ${model.counts.read} read [!!] · ${model.counts.info} notes`

const COL_NUM = 3
const COL_GAP = 2
const COL_TIME = 8
const COL_RISK = 7
const TABLE_FIXED = COL_NUM + COL_GAP + COL_GAP + COL_TIME + COL_GAP + COL_RISK

const itemColWidth = (innerW: number): number => innerW - TABLE_FIXED

const padCell = (text: string, width: number, align: 'left' | 'right' = 'left'): string => {
  if (text.length >= width) return text.slice(0, width)
  return align === 'right' ? ' '.repeat(width - text.length) + text : text + ' '.repeat(width - text.length)
}

const numCell = (num: string, isDefault: boolean): string => padCell(num + (isDefault ? '*' : ''), COL_NUM)

const itemCell = (title: string, width: number): string => {
  const upper = title.toUpperCase()
  if (upper.length >= width) return upper.slice(0, width)
  return upper + '.'.repeat(width - upper.length)
}

const tableLine = (
  innerW: number,
  num: string,
  isDefault: boolean,
  item: string,
  time: string,
  risk: string,
): string => {
  const iw = itemColWidth(innerW)
  return (
    numCell(num, isDefault) +
    ' '.repeat(COL_GAP) +
    itemCell(item, iw) +
    ' '.repeat(COL_GAP) +
    padCell(time.toUpperCase(), COL_TIME, 'right') +
    ' '.repeat(COL_GAP) +
    padCell(risk.toUpperCase(), COL_RISK, 'right')
  )
}

const tableHeader = (innerW: number): string => {
  const iw = itemColWidth(innerW)
  return (
    numCell('#', false) +
    ' '.repeat(COL_GAP) +
    padCell('ITEM', iw) +
    ' '.repeat(COL_GAP) +
    padCell('TIME', COL_TIME, 'right') +
    ' '.repeat(COL_GAP) +
    padCell('RISK', COL_RISK, 'right')
  )
}

/** A row of the bill: item on the left, dotted leaders, stamp on the right. */
const row = (ctx: ThemeCtx, item: CardItem, verdict: boolean, index: number, innerW: number): RenderElement => {
  const { Box } = ctx.el
  const tag = TAG[item.marker]
  const witness = verdict ? witnessMark(ctx) : []
  const width = room(innerW, (tag ? tag.length + 1 : 0) + (witness.length > 0 ? 2 : 0))
  const text = item.text
  const head: RenderElement[] =
    tag && text.length + 3 <= width
      ? [
          ink(ctx, { bold: verdict, children: cleanText(text) }),
          ink(ctx, { dimColor: true, children: ' ' + '.'.repeat(width - text.length - 1) }),
          ...witness,
          ink(ctx, { children: ' ' + tag }),
        ]
      : [
          Box({ width, children: ink(ctx, { bold: verdict, wrap: 'wrap', children: cleanText(text) }) }),
          ...witness,
          ...(tag ? [ink(ctx, { children: ' ' + tag })] : []),
        ]
  return Box({
    key: `${ctx.id}:row:${index}`,
    flexDirection: 'column',
    width: innerW,
    children: [
      Box({ flexDirection: 'row', children: head }),
      ...item.lines.map((line, i) =>
        Box({
          key: `${ctx.id}:row:${index}:line:${i}`,
          width: innerW,
          paddingLeft: 2,
          children: ink(ctx, { dimColor: true, wrap: 'wrap', children: cleanText(line) }),
        }),
      ),
      ...codeBlocks(ctx, item),
    ],
  })
}

const decisionTwo = (ctx: ThemeCtx, model: CardModel, index: number, verdict: boolean, innerW: number): RenderElement[] => {
  const { Box } = ctx.el
  const decision = model.decision!
  const item = model.items[index]
  const witness = verdict ? witnessMark(ctx) : []
  const tag = TAG.decide
  const width = room(innerW, tag.length + 1 + (witness.length > 0 ? 2 : 0))
  const clause = defaultClause(decision)
  return [
    Box({
      key: `${ctx.id}:decision`,
      flexDirection: 'row',
      width: innerW,
      children: [
        Box({ width, children: ink(ctx, { bold: verdict, wrap: 'wrap', children: cleanText(decision.question).toUpperCase() }) }),
        ...witness,
        ink(ctx, { children: ' ' + tag }),
      ],
    }),
    ...(clause ? [Box({ key: `${ctx.id}:decision:default`, width: innerW, children: ink(ctx, { dimColor: true, wrap: 'wrap', children: clause }) })] : []),
    ...(decision.options.length > 0
      ? [
          Box({
            key: `${ctx.id}:decision:options`,
            flexDirection: 'row',
            gap: 1,
            children: decision.options.map((option, i) =>
              ctx.el.Button({
                key: `${ctx.id}:option:${i}`,
                label: option.label,
                onPress: () => ctx.actions.fill(optionFill(option)),
              }),
            ),
          }),
        ]
      : []),
    ...(item ? codeBlocks(ctx, item) : []),
  ]
}

const tableRow = (
  ctx: ThemeCtx,
  option: DecisionOption,
  index: number,
  isDefault: boolean,
  wide: boolean,
  innerW: number,
): RenderElement[] => {
  const { Box } = ctx.el
  const num = String(index + 1)
  const title = cleanText(option.label)
  const estimate = option.estimate?.toUpperCase() ?? ''
  const risk = option.risk?.toUpperCase() ?? ''
  const rows: RenderElement[] = []
  if (wide) {
    rows.push(
      Box({
        key: `${ctx.id}:table:${index}`,
        width: innerW,
        children: ink(ctx, {
          bold: true,
          children: tableLine(innerW, num, isDefault, title, estimate, risk),
        }),
      }),
    )
  } else {
    rows.push(
      Box({
        key: `${ctx.id}:table:${index}`,
        flexDirection: 'column',
        width: innerW,
        children: [
          ink(ctx, { bold: true, children: `${num}${isDefault ? '*' : ''} ${title.toUpperCase()}` }),
          ...(estimate || risk
            ? [ink(ctx, { dimColor: true, children: [estimate, risk].filter(Boolean).join(' · ') })]
            : []),
        ],
      }),
    )
  }
  if (option.detail) {
    rows.push(
      Box({
        key: `${ctx.id}:table:${index}:detail`,
        width: innerW,
        paddingLeft: wide ? 4 : 2,
        children: ink(ctx, { dimColor: true, wrap: 'wrap', children: cleanText(option.detail) }),
      }),
    )
  }
  return rows
}

const decisionChooser = (ctx: ThemeCtx, model: CardModel, index: number, verdict: boolean, innerW: number): RenderElement[] => {
  const { Box, Button } = ctx.el
  const decision = model.decision!
  const item = model.items[index]
  const defNum = defaultNumber(decision)
  const rows: RenderElement[] = [
    ink(ctx, { inverse: true, children: centred('YOUR ORDER, PLEASE', innerW) }),
    ink(ctx, { dimColor: true, children: centred(`1 question · pick one · default #${defNum}`, innerW) }),
    Box({ width: innerW, children: ink(ctx, { bold: verdict, wrap: 'wrap', children: cleanText(decision.question).toUpperCase() }) }),
    ...(() => {
      const context = decisionContext(item)
      return context ? [Box({ width: innerW, children: ink(ctx, { dimColor: true, wrap: 'wrap', children: context }) })] : []
    })(),
    ink(ctx, { dimColor: true, children: tableHeader(innerW) }),
    ...decision.options.flatMap((option, i) => tableRow(ctx, option, i, decision.defaultKey === option.key, ctx.columns >= WIDE, innerW)),
    ink(ctx, { dimColor: true, children: '* = default if you say nothing' }),
    Box({
      key: `${ctx.id}:decision:options`,
      flexDirection: 'row',
      gap: 1,
      children: decision.options.map((option, i) =>
        ctx.el.Button({
          key: `${ctx.id}:option:${i}`,
          label: String(i + 1),
          onPress: () => ctx.actions.fill(optionFill(option)),
        }),
      ),
    }),
    Box({
      key: `${ctx.id}:rest-fold`,
      flexDirection: 'row',
      gap: 1,
      children: [
        ink(ctx, { dimColor: true, wrap: 'truncate', children: foldFooter(model) }),
        Button({ key: `${ctx.id}:rest:show`, label: 'show', dimColor: true, onPress: () => openRest(ctx) }),
      ],
    }),
    ...(item ? codeBlocks(ctx, item) : []),
  ]
  return rows
}

const renderGroups = (ctx: ThemeCtx, groups: Group[], verdict: number, chooser: boolean, innerW: number): RenderElement[] => {
  const { Box, Button } = ctx.el
  const rows: RenderElement[] = []
  for (const group of groups) {
    const section = sectionOf(group.marker)
    const open = section === null ? true : sectionOpen(ctx, section, chooser)
    if (section !== null && needsFoldRow(open, chooser && section !== 'skip' ? false : DEFAULT_OPEN[section])) {
      rows.push(
        Box({
          key: `${ctx.id}:fold:${section}`,
          flexDirection: 'row',
          gap: 1,
          children: [
            ink(ctx, {
              dimColor: true,
              wrap: 'truncate',
              children: section === 'skip' ? `${group.items.length} skippable line${group.items.length === 1 ? '' : 's'}` : `${group.items.length} ${section}`,
            }),
            Button({
              key: `${ctx.id}:toggle:${section}`,
              label: open ? 'hide' : 'show',
              dimColor: true,
              onPress: () => ctx.actions.toggle(section),
            }),
          ],
        }),
      )
    }
    if (!open) continue
    for (const placed of group.items) rows.push(row(ctx, placed.item, placed.index === verdict, placed.index, innerW))
  }
  return rows
}

const render = (model: CardModel, ctx: ThemeCtx): RenderElement => {
  const { Box } = ctx.el
  const verdict = verdictIndex(model)
  const decision = decisionIndex(model)
  const chooser = decision >= 0 && model.decision!.options.length >= 3
  const groups = grouped(model, decision)
  const innerW = room(ctx.columns, FRAME_SPENT)
  const inner: RenderElement[] = []

  if (chooser) {
    inner.push(...decisionChooser(ctx, model, decision, verdict === decision, innerW))
  } else {
    inner.push(ink(ctx, { inverse: true, children: centred('FOR YOU', innerW) }))
    const tally = [
      model.counts.decide > 0 ? `${model.counts.decide} decision` : '',
      model.counts.done > 0 ? `${model.counts.done} done` : '',
      model.counts.read + model.counts.blocked > 0 ? `${model.counts.read + model.counts.blocked} read` : '',
    ].filter(Boolean)
    if (tally.length > 0) inner.push(ink(ctx, { dimColor: true, children: centred(tally.join(' · '), innerW) }))
    if (decision >= 0) inner.push(...decisionTwo(ctx, model, decision, verdict === decision, innerW))
  }

  if (!chooser || !restFolded(ctx, chooser)) {
    inner.push(...renderGroups(ctx, groups, verdict, chooser, innerW))
  }

  return Box({
    key: `${ctx.id}:card`,
    flexDirection: 'column',
    width: ctx.columns,
    children: [
      ...preambleLines(ctx, model),
      Box({
        key: `${ctx.id}:frame`,
        flexDirection: 'column',
        width: ctx.columns,
        borderStyle: 'classic',
        borderDimColor: true,
        paddingX: 1,
        children: inner,
      }),
    ],
  })
}

export const theme: Theme = {
  id: 'receipt',
  name: 'Receipt',
  tagline: 'framed till roll, ASCII, the question as an order form',
  render,
}
