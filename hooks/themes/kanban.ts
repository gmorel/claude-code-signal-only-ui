import type { RenderElement } from 'claude-code'
import type { CardItem, CardModel, Decision, DecisionOption, Marker, Theme, ThemeCtx } from '../theme.ts'
import {
  cleanText,
  codeBlocks,
  countLabel,
  decisionIndex,
  defaultLine,
  foldRow,
  grouped,
  isOpen,
  needsFoldRow,
  optionFill,
  preambleLines,
  room,
  sectionOf,
  softBreak,
  verdictIndex,
  witnessMark,
  type Group,
  type Section,
} from './_shared.ts'

// Sticky kanban (design/artboards/DirectionH.dc.html, H2 for questions): three
// columns of filled stickies — to decide, done, to read and notes.

const WIDE = 84
const GAP = 2

const FILL: Record<'decide' | 'done' | 'read' | 'note', string> = {
  decide: '#F2C14E',
  done: '#8EE0A8',
  read: '#F0A050',
  note: '#D9DEE5',
}

const TAPE: Record<'decide' | 'done' | 'read' | 'note', string> = {
  decide: '#C89B2E',
  done: '#5CC48A',
  read: '#D89040',
  note: '#B8BEC8',
}

const MIN_COL = 18
const DECIDE_MIN = 28
const SHADOW = '#0E0E0E'

/** Break text into rows of at most `width` columns on word boundaries, the way Ink would. */
export const wrapRows = (text: string, width: number): string[] => {
  if (width < 1) return text === '' ? [] : [text]
  if (text === '') return []

  const words = text.trim().split(/\s+/).filter(w => w.length > 0)
  if (words.length === 0) return []

  const rows: string[] = []
  let current = ''

  for (const word of words) {
    if (word.length > width) {
      if (current) {
        rows.push(current)
        current = ''
      }
      rows.push(word)
      continue
    }
    if (current === '') {
      current = word
      continue
    }
    const candidate = `${current} ${word}`
    if (candidate.length <= width) current = candidate
    else {
      rows.push(current)
      current = word
    }
  }
  if (current) rows.push(current)
  return rows
}

const HEADER: Record<'decide' | 'done' | 'read' | 'note', string> = {
  decide: 'yellow',
  done: 'green',
  read: 'yellow',
  note: 'gray',
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

const boardSummary = (model: CardModel): string =>
  `Already on the kanban: ${model.counts.done} done, ${model.counts.read} read, ${model.counts.info} notes`

const decisionContext = (item: CardItem | undefined): string | null => {
  if (!item || item.lines.length === 0) return null
  return item.lines.map(cleanText).join(' ')
}

const chooserDefaultLine = (decision: Decision, defNum: number): string | null => {
  if (decision.defaultKey !== null) return `if nothing → note ${decision.defaultKey}`
  if (decision.defaultText !== null) return `if nothing → note ${defNum}`
  return null
}

const defaultNumber = (decision: Decision): number => {
  if (decision.defaultKey !== null) {
    const i = decision.options.findIndex(o => o.key === decision.defaultKey)
    if (i >= 0) return i + 1
  }
  const i = decision.options.findIndex(o => o.label === decision.defaultText)
  return i >= 0 ? i + 1 : 1
}

const itemWeight = (item: CardItem): number => item.text.length + item.lines.reduce((n, line) => n + line.length, 0)

const evenColumnSplit = (available: number, count: number): number =>
  Math.max(8, Math.floor(available / count))

/** Proportional widths with min/max clamps; falls back to even split only when clamps are infeasible. */
export const columnWidths = (weights: number[], available: number, cardColumns: number, mins?: number[]): number[] => {
  const n = weights.length
  if (n === 0) return []
  if (n === 1) return [available]

  const colMins = mins ?? weights.map(() => MIN_COL)
  const maxW = Math.floor(cardColumns * 0.55)
  const sumMins = colMins.reduce((a, b) => a + b, 0)
  if (maxW < Math.min(...colMins) || sumMins > available || n * maxW < available) {
    return weights.map(() => evenColumnSplit(available, n))
  }

  const sumW = weights.reduce((a, b) => a + b, 0) || 1
  const clamp = (w: number, i: number) => Math.min(maxW, Math.max(colMins[i]!, w))
  let widths = weights.map((w, i) => clamp(Math.floor((w / sumW) * available), i))

  for (let pass = 0; pass < 16; pass++) {
    widths = widths.map((w, i) => clamp(w, i))
    const sum = widths.reduce((a, b) => a + b, 0)
    const diff = available - sum
    if (diff === 0) break

    if (diff > 0) {
      const movable = weights
        .map((wt, i) => ({ i, wt, room: maxW - widths[i]! }))
        .filter(c => c.room > 0)
      if (movable.length === 0) break
      const totalWt = movable.reduce((a, c) => a + c.wt, 0)
      for (const c of movable) {
        widths[c.i]! += Math.min(c.room, Math.floor((diff * c.wt) / totalWt))
      }
    } else {
      const excess = -diff
      const movable = weights
        .map((wt, i) => ({ i, wt, room: widths[i]! - colMins[i]! }))
        .filter(c => c.room > 0)
      if (movable.length === 0) break
      const totalWt = movable.reduce((a, c) => a + c.wt, 0)
      for (const c of movable) {
        widths[c.i]! -= Math.min(c.room, Math.floor((excess * c.wt) / totalWt))
      }
    }
  }

  let left = available - widths.reduce((a, b) => a + b, 0)
  while (left > 0) {
    let best = -1
    let bestWt = -1
    for (let i = 0; i < n; i++) {
      if (widths[i]! < maxW && weights[i]! > bestWt) {
        bestWt = weights[i]!
        best = i
      }
    }
    if (best < 0) break
    widths[best]! += 1
    left -= 1
  }

  while (left < 0) {
    let best = -1
    let bestWt = Infinity
    for (let i = 0; i < n; i++) {
      if (widths[i]! > colMins[i]! && weights[i]! < bestWt) {
        bestWt = weights[i]!
        best = i
      }
    }
    if (best < 0) break
    widths[best]! -= 1
    left += 1
  }

  return widths
}

const stickyShadow = (ctx: ThemeCtx, key: string, width: number): RenderElement => {
  const { Box } = ctx.el
  return Box({
    key: `${key}:shadow-row`,
    flexDirection: 'row',
    width,
    flexShrink: 0,
    children: [
      Box({ key: `${key}:shadow-spacer`, width: 1 }),
      Box({
        key: `${key}:shadow`,
        width: width - 1,
        height: 1,
        flexShrink: 0,
        backgroundColor: SHADOW,
      }),
    ],
  })
}

const stickyTitle = (
  ctx: ThemeCtx,
  inner: number,
  verdict: boolean,
  firstRow: string,
  witness: RenderElement[],
): RenderElement => {
  const { Box, Text } = ctx.el
  return Box({
    flexDirection: 'row',
    gap: 1,
    children: [
      Box({
        width: room(inner, witness.length > 0 ? 2 : 0),
        children: Text({ bold: verdict, color: 'black', wrap: 'truncate', children: firstRow }),
      }),
      ...witness,
    ],
  })
}

/** A sticky: tape, fill + black text, shadow — continuations and fences inside the fill. */
const sticky = (
  ctx: ThemeCtx,
  item: CardItem,
  verdict: boolean,
  index: number,
  width: number,
  fill: string,
  tape: string,
): RenderElement => {
  const { Box, Text } = ctx.el
  const inner = room(width, 4)
  const witness = verdict ? witnessMark(ctx) : []
  const titleRows = wrapRows(softBreak(cleanText(item.text), inner), inner)
  const titleRest = titleRows.slice(1)
  const hasBody = titleRest.length > 0 || item.lines.length > 0 || item.code.length > 0
  const key = `${ctx.id}:sticky:${index}`
  return Box({
    key,
    flexDirection: 'column',
    width,
    marginBottom: 1,
    children: [
      Box({
        key: `${key}:tape`,
        width,
        paddingX: 1,
        backgroundColor: tape,
        children: [stickyTitle(ctx, inner, verdict, titleRows[0] ?? '', witness)],
      }),
      ...(hasBody
        ? [
            Box({
              key: `${key}:body`,
              flexDirection: 'column',
              width,
              paddingX: 1,
              backgroundColor: fill,
              children: [
                ...titleRest.map((line, i) =>
                  Box({
                    key: `${key}:title:${i}`,
                    width: inner,
                    children: Text({ color: 'black', wrap: 'wrap', children: line }),
                  }),
                ),
                ...item.lines.map((line, i) =>
                  Box({
                    key: `${key}:line:${i}`,
                    width: inner,
                    children: Text({ color: 'black', wrap: 'wrap', children: softBreak(cleanText(line), inner) }),
                  }),
                ),
                ...codeBlocks(ctx, item),
              ],
            }),
          ]
        : []),
      stickyShadow(ctx, key, width),
    ],
  })
}

const itemSticky = (ctx: ThemeCtx, item: CardItem, verdict: boolean, index: number, width: number): RenderElement => {
  if (item.marker === 'done') return sticky(ctx, item, verdict, index, width, FILL.done, TAPE.done)
  if (item.marker === 'read') return sticky(ctx, item, verdict, index, width, FILL.read, TAPE.read)
  return sticky(ctx, item, verdict, index, width, FILL.note, TAPE.note)
}

const buttonCells = (label: string): number => label.length + 4

const optionsFitRow = (options: DecisionOption[], width: number): boolean =>
  options.reduce((sum, o) => sum + buttonCells(o.label), 0) + (options.length - 1) <= width

/** Two short options: question on the sticky, buttons below. */
const decisionSticky = (ctx: ThemeCtx, model: CardModel, index: number, verdict: boolean, width: number): RenderElement[] => {
  const { Box, Text, Button } = ctx.el
  const decision = model.decision!
  const item = model.items[index]
  const clause = defaultLine(decision)
  const inner = room(width, 4)
  const witness = verdict ? witnessMark(ctx) : []
  const questionRows = wrapRows(softBreak(cleanText(decision.question), inner), inner)
  const questionRest = questionRows.slice(1)
  const hasBody = questionRest.length > 0 || Boolean(clause) || (item !== undefined && item.code.length > 0)
  const key = `${ctx.id}:decision`
  const rows: RenderElement[] = [
    Box({
      key,
      flexDirection: 'column',
      width,
      marginBottom: 1,
      children: [
        Box({
          key: `${key}:tape`,
          width,
          paddingX: 1,
          backgroundColor: TAPE.decide,
          children: [stickyTitle(ctx, inner, verdict, questionRows[0] ?? '', witness)],
        }),
        ...(hasBody
          ? [
              Box({
                key: `${key}:body`,
                flexDirection: 'column',
                width,
                paddingX: 1,
                backgroundColor: FILL.decide,
                children: [
                  ...questionRest.map((line, i) =>
                    Box({
                      key: `${key}:question:${i}`,
                      width: inner,
                      children: Text({ color: 'black', wrap: 'wrap', children: line }),
                    }),
                  ),
                  ...(clause ? [Text({ color: 'black', wrap: 'wrap', children: clause })] : []),
                  ...(item ? codeBlocks(ctx, item) : []),
                ],
              }),
            ]
          : []),
        stickyShadow(ctx, key, width),
      ],
    }),
  ]
  if (decision.options.length > 0) {
    const fitRow = optionsFitRow(decision.options, width)
    rows.push(
      Box({
        key: `${ctx.id}:decision:options`,
        flexDirection: fitRow ? 'row' : 'column',
        width,
        flexShrink: 0,
        ...(fitRow ? { gap: 1 } : {}),
        children: decision.options.map((option, i) => {
          const label =
            decision.options.length === 1 && buttonCells(option.label) > width
              ? option.label.slice(0, width - 5) + '…'
              : option.label
          return Button({
            key: `${ctx.id}:option:${i}`,
            label,
            onPress: () => ctx.actions.fill(optionFill(option)),
          })
        }),
      }),
    )
  }
  return rows
}

const optionSticky = (ctx: ThemeCtx, option: DecisionOption, index: number, isDefault: boolean, width: number): RenderElement => {
  const { Box, Text } = ctx.el
  const num = index + 1
  const inner = room(width, 2)
  const title = `${num} · ${cleanText(option.label)}`
  const badge = 'DEFAULT'
  const badgeOnTitle = isDefault && title.length + 1 + badge.length <= inner
  const meta: RenderElement[] = []
  if (option.estimate) meta.push(Text({ color: 'black', children: `effort ${option.estimate}` }))
  if (option.risk) meta.push(Text({ color: 'black', children: `risk ${option.risk}` }))
  const titleBlock: RenderElement = badgeOnTitle
    ? Text({ bold: true, color: 'black', wrap: 'wrap', children: `${title}  ${badge}` })
    : Box({
        flexDirection: 'column',
        children: [
          Box({ width: inner, children: Text({ bold: true, color: 'black', wrap: 'wrap', children: title }) }),
          ...(isDefault ? [Box({ width: inner, children: Text({ color: 'black', wrap: 'truncate', children: badge }) })] : []),
        ],
      })
  return Box({
    key: `${ctx.id}:option:${index}`,
    flexDirection: 'column',
    width,
    flexShrink: 0,
    paddingX: 1,
    marginBottom: 1,
    backgroundColor: FILL.decide,
    children: [
      titleBlock,
      ...(option.detail
        ? [Box({ width: inner, children: Text({ color: 'black', wrap: 'wrap', children: softBreak(cleanText(option.detail), inner) }) })]
        : []),
      ...(meta.length > 0 ? [Box({ flexDirection: 'column', children: meta })] : []),
    ],
  })
}

const decisionChooser = (ctx: ThemeCtx, model: CardModel, index: number, verdict: number, width: number): RenderElement => {
  const { Box, Text, Button } = ctx.el
  const decision = model.decision!
  const item = model.items[index]
  const defNum = defaultNumber(decision)
  const clause = chooserDefaultLine(decision, defNum)
  const context = decisionContext(item)
  const hasWhy = Boolean(context)
  const wide = ctx.columns >= WIDE
  const optionsW = wide
    ? hasWhy
      ? Math.max(8, Math.floor((width - GAP * 2) / 3))
      : Math.max(8, Math.floor(((width - GAP) * 2) / 3))
    : width
  const decidedW = wide ? (hasWhy ? optionsW : width - GAP - optionsW) : width
  const whyW = wide && hasWhy ? optionsW : width

  const optionsCol: RenderElement[] = [
    Text({ bold: true, color: HEADER.decide, wrap: 'truncate', children: 'OPTIONS' }),
    ...decision.options.map((option, i) => optionSticky(ctx, option, i, decision.defaultKey === option.key, optionsW)),
  ]

  const summarySticky = (width: number) =>
    Box({
      key: `${ctx.id}:kanban-summary`,
      flexDirection: 'column',
      width,
      paddingX: 1,
      backgroundColor: FILL.note,
      children: [
        Text({ color: 'black', wrap: 'wrap', children: boardSummary(model) }),
        Button({ key: `${ctx.id}:rest:show`, label: 'show', onPress: () => openRest(ctx) }),
      ],
    })

  const decidedCol: RenderElement[] = [
    Text({ bold: true, color: HEADER.done, wrap: 'truncate', children: 'DECIDED' }),
    Box({
      key: `${ctx.id}:decided`,
      flexDirection: 'column',
      width: decidedW,
      flexShrink: 0,
      borderStyle: 'single',
      borderDimColor: true,
      paddingX: 1,
      paddingY: 1,
      gap: 1,
      children: [
        Box({
          flexDirection: 'row',
          gap: 1,
          flexWrap: 'wrap',
          children: decision.options.map((option, i) =>
            Button({
              key: `${ctx.id}:option:${i}`,
              label: String(i + 1),
              onPress: () => ctx.actions.fill(optionFill(option)),
            }),
          ),
        }),
        ...(clause ? [Text({ dimColor: true, wrap: 'wrap', children: clause })] : []),
        ...(!hasWhy ? [summarySticky(room(decidedW, 4))] : []),
      ],
    }),
  ]

  const whyCol: RenderElement[] = hasWhy
    ? [
        Text({ bold: true, color: HEADER.read, wrap: 'truncate', children: 'WHY I ASK' }),
        Box({
          key: `${ctx.id}:why`,
          flexDirection: 'column',
          width: whyW,
          flexShrink: 0,
          paddingX: 1,
          marginBottom: 1,
          backgroundColor: FILL.read,
          children: [Text({ color: 'black', wrap: 'wrap', children: context! })],
        }),
        summarySticky(whyW),
      ]
    : []

  const colWidths = hasWhy ? [optionsW, decidedW, whyW] : [optionsW, decidedW]
  const flatCols = hasWhy ? [optionsCol, decidedCol, whyCol] : [optionsCol, decidedCol]

  return Box({
    key: `${ctx.id}:chooser`,
    flexDirection: 'column',
    width: ctx.columns,
    gap: 1,
    children: [
      Text({ bold: true, wrap: 'wrap', children: cleanText(decision.question) }),
      Box({
        key: `${ctx.id}:chooser-cols`,
        flexDirection: wide ? 'row' : 'column',
        gap: wide ? GAP : 1,
        width: ctx.columns,
        children: flatCols.map((col, i) =>
          Box({
            key: `${ctx.id}:chooser-col:${i}`,
            flexDirection: 'column',
            width: colWidths[i],
            flexShrink: 0,
            children: col,
          }),
        ),
      }),
      ...(item ? codeBlocks(ctx, item) : []),
    ],
  })
}

type Column = { id: string; title: string; tint: string; markers: Marker[] }

const COLUMNS: readonly Column[] = [
  { id: 'decide', title: 'TO DECIDE', tint: 'yellow', markers: ['decide', 'blocked'] },
  { id: 'done', title: 'DONE', tint: 'green', markers: ['done'] },
  { id: 'read', title: 'TO READ', tint: 'yellow', markers: ['read'] },
]

const columnHasContent = (
  column: Column,
  groups: Group[],
  decision: number,
  infoGroup: Group | undefined,
  skipGroup: Group | undefined,
): boolean => {
  if (column.id === 'decide') {
    const mine = groups.filter(group => column.markers.includes(group.marker))
    return mine.some(group => group.items.length > 0) || decision >= 0
  }
  if (column.id === 'done') return groups.some(group => group.marker === 'done' && group.items.length > 0)
  if (column.id === 'read') {
    return (
      groups.some(group => group.marker === 'read' && group.items.length > 0) ||
      (infoGroup !== undefined && infoGroup.items.length > 0) ||
      (skipGroup !== undefined && skipGroup.items.length > 0)
    )
  }
  return false
}

const columnWeight = (
  column: Column,
  groups: Group[],
  model: CardModel,
  decision: number,
  infoGroup: Group | undefined,
  skipGroup: Group | undefined,
): number => {
  let weight = 0
  if (column.id === 'decide') {
    for (const group of groups.filter(g => column.markers.includes(g.marker))) {
      for (const placed of group.items) weight += itemWeight(placed.item)
    }
    if (decision >= 0 && model.decision) weight += model.decision.question.length
  } else if (column.id === 'done') {
    for (const placed of groups.find(g => g.marker === 'done')?.items ?? []) weight += itemWeight(placed.item)
  } else if (column.id === 'read') {
    for (const placed of groups.find(g => g.marker === 'read')?.items ?? []) weight += itemWeight(placed.item)
    if (infoGroup) for (const placed of infoGroup.items) weight += itemWeight(placed.item)
    if (skipGroup) for (const placed of skipGroup.items) weight += itemWeight(placed.item)
  }
  return weight
}

const columnOf = (
  ctx: ThemeCtx,
  model: CardModel,
  column: Column,
  groups: Group[],
  decision: number,
  verdict: number,
  width: number,
  notes: Group | undefined,
): RenderElement => {
  const { Box, Text } = ctx.el
  const mine = groups.filter(group => column.markers.includes(group.marker))
  const count = mine.reduce((n, group) => n + group.items.length, 0) + (column.id === 'decide' && decision >= 0 ? 1 : 0)
  const children: RenderElement[] = [Text({ bold: true, color: column.tint, wrap: 'truncate', children: `${column.title} · ${count}` })]

  if (column.id === 'decide' && decision >= 0) {
    children.push(...decisionSticky(ctx, model, decision, verdict === decision, width))
  }
  for (const group of mine) {
    const section = sectionOf(group.marker)
    const open = section === null ? true : sectionOpen(ctx, section, false)
    if (section !== null && needsFoldRow(open, DEFAULT_OPEN[section])) {
      children.push(foldRow(ctx, section, group.items.length, open))
    }
    if (!open) continue
    for (const placed of group.items) {
      children.push(itemSticky(ctx, placed.item, placed.index === verdict, placed.index, width))
    }
  }

  if (column.id === 'read' && notes) {
    children.push(Text({ bold: true, color: 'gray', wrap: 'truncate', children: `NOTES · ${notes.items.length}` }))
    const infoOpen = sectionOpen(ctx, 'info', false)
    if (needsFoldRow(infoOpen, DEFAULT_OPEN.info)) {
      children.push(foldRow(ctx, 'info', notes.items.length, infoOpen))
    }
    if (infoOpen) {
      for (const placed of notes.items) {
        children.push(itemSticky(ctx, placed.item, placed.index === verdict, placed.index, width))
      }
    }
    const skipGroup = groups.find(g => g.marker === 'skip')
    if (skipGroup && skipGroup.items.length > 0) {
      const skipOpen = sectionOpen(ctx, 'skip', false)
      if (needsFoldRow(skipOpen, DEFAULT_OPEN.skip)) {
        children.push(
          Box({
            key: `${ctx.id}:scrap-fold`,
            flexDirection: 'row',
            gap: 1,
            children: [
              Text({ dimColor: true, wrap: 'truncate', children: `+${skipGroup.items.length} scrap folded` }),
              ctx.el.Button({
                key: `${ctx.id}:toggle:skip`,
                label: skipOpen ? 'hide' : 'show',
                dimColor: true,
                onPress: () => ctx.actions.toggle('skip'),
              }),
            ],
          }),
        )
      }
      if (skipOpen) {
        for (const placed of skipGroup.items) {
          children.push(itemSticky(ctx, placed.item, false, placed.index, width))
        }
      }
    }
  }

  return Box({ key: `${ctx.id}:column:${column.id}`, flexDirection: 'column', width, children })
}

const renderNormal = (model: CardModel, ctx: ThemeCtx, decision: number, verdict: number): RenderElement => {
  const { Box } = ctx.el
  const groups = grouped(model, decision)
  const infoGroup = groups.find(g => g.marker === 'info')
  const skipGroup = groups.find(g => g.marker === 'skip')
  const wide = ctx.columns >= WIDE
  const survivors = COLUMNS.filter(column => columnHasContent(column, groups, decision, infoGroup, skipGroup))
  const weights = survivors.map(column => columnWeight(column, groups, model, decision, infoGroup, skipGroup))
  const available = wide ? ctx.columns - GAP * Math.max(0, survivors.length - 1) : ctx.columns
  const colMins = survivors.map(column => (column.id === 'decide' ? DECIDE_MIN : MIN_COL))
  const widths = wide ? columnWidths(weights, available, ctx.columns, colMins) : survivors.map(() => ctx.columns)
  const columns = survivors.map((column, i) =>
    columnOf(ctx, model, column, groups, decision, verdict, widths[i]!, infoGroup),
  )
  return Box({
    key: `${ctx.id}:columns`,
    flexDirection: wide ? 'row' : 'column',
    gap: wide ? GAP : 1,
    width: ctx.columns,
    children: columns,
  })
}

const renderRest = (model: CardModel, ctx: ThemeCtx, decision: number, verdict: number): RenderElement | null => {
  const groups = grouped(model, decision)
  const rows: RenderElement[] = []
  for (const group of groups) {
    if (group.marker === 'decide' || group.marker === 'blocked') continue
    const section = sectionOf(group.marker)
    const open = section === null ? true : sectionOpen(ctx, section, true)
    if (!open) continue
    const width = ctx.columns
    for (const placed of group.items) {
      rows.push(itemSticky(ctx, placed.item, placed.index === verdict, placed.index, width))
    }
  }
  if (rows.length === 0) return null
  return ctx.el.Box({ key: `${ctx.id}:rest`, flexDirection: 'column', width: ctx.columns, children: rows })
}

const render = (model: CardModel, ctx: ThemeCtx): RenderElement => {
  const { Box, Text } = ctx.el
  const verdict = verdictIndex(model)
  const decision = decisionIndex(model)
  const chooser = decision >= 0 && model.decision!.options.length >= 3
  const children: RenderElement[] = [...preambleLines(ctx, model)]

  if (chooser) {
    children.push(decisionChooser(ctx, model, decision, verdict, ctx.columns))
    if (!restFolded(ctx, chooser)) {
      const rest = renderRest(model, ctx, decision, verdict)
      if (rest) children.push(rest)
    }
  } else {
    if (model.header) children.push(Text({ dimColor: true, wrap: 'truncate', children: 'FOR YOU' }))
    children.push(renderNormal(model, ctx, decision, verdict))
  }

  return Box({ key: `${ctx.id}:card`, flexDirection: 'column', width: ctx.columns, children })
}

export const theme: Theme = {
  id: 'kanban',
  name: 'Sticky kanban',
  tagline: 'sticky notes with real fills, three columns from 84 cols',
  render,
}
