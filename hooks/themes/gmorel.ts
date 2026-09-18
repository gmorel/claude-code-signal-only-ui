import type { RenderElement } from 'claude-code'
import type { CardItem, CardModel, CardState, Marker, Theme, ThemeCtx } from '../theme.ts'
import { formatCost, formatTokens } from '../cost.ts'
import {
  cleanText,
  codeBlocks,
  decisionIndex,
  defaultLine,
  isOpen,
  needsFoldRow,
  optionButtons,
  optionFill,
  preambleLines,
  room,
  verdictIndex,
  witnessMark,
} from './_shared.ts'
import type { DecisionOption } from '../theme.ts'

// K · gmorel-1.0.0 (design/artboards/DirectionA2, K3–K7): header, counter
// tiles, boxed decision and blocked, plain marker lines, one skip fold, optional
// cost footer. Named colours only — no hex, no gradients.

const WIDE = 80

const RISK_COLOR: Record<NonNullable<DecisionOption['risk']>, string> = {
  low: 'green',
  medium: 'yellow',
  high: 'red',
}

const GLYPH: Record<Marker, string> = {
  done: '☑',
  decide: '🟡',
  blocked: '🔴',
  read: '⚠️',
  info: '▫️',
  skip: 'ℹ️',
}

/** skip closed (same default as the other themes). */
const SKIP_OPEN = false

/** per-item summary/detail folds closed by default. */
const ITEM_FOLD_OPEN = false

/** Runtime toggle keys are `item:N:summary` / `item:N:detail`; cast for the narrow CardState type. */
const itemFoldKey = (index: number, layer: 'summary' | 'detail'): keyof CardState['open'] =>
  `item:${index}:${layer}` as keyof CardState['open']

const itemFoldOpen = (ctx: ThemeCtx, index: number, layer: 'summary' | 'detail'): boolean =>
  ctx.state.open[itemFoldKey(index, layer)] ?? ITEM_FOLD_OPEN

const itemFoldRow = (
  ctx: ThemeCtx,
  index: number,
  layer: 'summary' | 'detail',
  open: boolean,
  width: number,
): RenderElement => {
  const { Box, Text, Button } = ctx.el
  const key = itemFoldKey(index, layer)
  return Box({
    key: `${ctx.id}:fold:${key}`,
    flexDirection: 'row',
    gap: 1,
    width,
    paddingLeft: 2,
    children: [
      Text({ dimColor: true, wrap: 'truncate', children: open ? layer : `+ ${layer}` }),
      Button({
        key: `${ctx.id}:toggle:${key}`,
        label: open ? 'hide' : 'show',
        dimColor: true,
        onPress: () => ctx.actions.toggle(key),
      }),
    ],
  })
}

const isPureAnswer = (model: CardModel): boolean =>
  model.items.every(item => item.marker === 'info' || item.marker === 'read' || item.marker === 'skip')

const isOneLine = (model: CardModel): boolean => {
  if (model.items.length !== 1) return false
  const marker = model.items[0]!.marker
  return marker === 'done' || marker === 'read' || marker === 'info' || marker === 'skip'
}

const skipFoldLabel = (n: number): string => `ℹ️ ${n} skippable detail${n === 1 ? '' : 's'} hidden`

const skipFoldRow = (ctx: ThemeCtx, count: number, open: boolean): RenderElement => {
  const { Box, Text, Button } = ctx.el
  return Box({
    key: `${ctx.id}:fold:skip`,
    flexDirection: 'row',
    gap: 1,
    children: [
      Text({ dimColor: true, wrap: 'truncate', children: skipFoldLabel(count) }),
      Button({
        key: `${ctx.id}:toggle:skip`,
        label: open ? 'hide' : 'show',
        dimColor: true,
        onPress: () => ctx.actions.toggle('skip'),
      }),
    ],
  })
}

const costLine = (ctx: ThemeCtx): RenderElement | null => {
  if (!ctx.usage) return null
  if (ctx.usage.inputTokens === 0 && ctx.usage.outputTokens === 0) return null
  const total = ctx.usage.inputTokens + ctx.usage.outputTokens
  return ctx.el.Text({
    dimColor: true,
    children: `≈ ${formatCost(ctx.usage.costUsd)} · ${formatTokens(total)} · API price`,
  })
}

const headerRow = (ctx: ThemeCtx, pure: boolean): RenderElement | null => {
  const { Box, Text } = ctx.el
  if (pure) {
    return Box({
      key: `${ctx.id}:header`,
      flexDirection: 'row',
      justifyContent: 'space-between',
      width: ctx.columns,
      children: [Text({ bold: true, children: '▫️ Answer' }), Text({ dimColor: true, children: 'nothing to do' })],
    })
  }
  const witness = witnessMark(ctx)
  if (witness.length === 0) return null
  return Box({
    key: `${ctx.id}:header`,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    width: ctx.columns,
    children: witness,
  })
}

const counterTile = (
  ctx: ThemeCtx,
  value: string,
  label: string,
  color: string,
  active: boolean,
  key: string,
  width?: number,
): RenderElement => {
  const { Box, Text } = ctx.el
  return Box({
    key,
    flexDirection: 'column',
    borderStyle: 'round',
    ...(active ? { borderColor: color } : { borderDimColor: true }),
    ...(width ? { width } : {}),
    paddingX: 1,
    paddingY: 1,
    children: [
      Text({ bold: true, ...(active ? { color } : { dimColor: true }), children: value }),
      Text({ dimColor: true, children: label }),
    ],
  })
}

const countersRow = (ctx: ThemeCtx, model: CardModel): RenderElement | null => {
  const { Box, Text } = ctx.el
  const { counts } = model
  const tiles = [
    { value: counts.decide, label: 'decision', color: 'yellow', key: `${ctx.id}:count:decide` },
    { value: counts.done, label: 'done', color: 'green', key: `${ctx.id}:count:done` },
    { value: counts.read, label: 'to read', color: 'yellow', key: `${ctx.id}:count:read` },
    { value: counts.blocked, label: 'blocked', color: 'red', key: `${ctx.id}:count:blocked` },
  ].filter(t => t.value > 0)
  if (tiles.length === 0) return null
  if (ctx.columns < WIDE) {
    const narrow = tiles.map(t => `${t.value} ${t.label}`).join(' · ')
    return Box({ key: `${ctx.id}:counters`, children: Text({ dimColor: true, wrap: 'wrap', children: narrow }) })
  }
  const n = tiles.length
  const tileW = Math.min(28, Math.max(8, Math.floor((ctx.columns - (n - 1) * 2) / n)))
  return Box({
    key: `${ctx.id}:counters`,
    flexDirection: 'row',
    gap: 2,
    width: ctx.columns,
    children: tiles.map(t => counterTile(ctx, String(t.value), t.label, t.color, true, t.key, tileW)),
  })
}

const META_W = 22
const WARN_COLOR = '#D98324'

/** the verdict sits in a round box like the ⚠️ one, bordered in the colour of its own marker. */
const VERDICT_BORDER: Record<Marker, string> = {
  done: 'green',
  decide: 'yellow',
  blocked: 'red',
  read: WARN_COLOR,
  info: 'green',
  skip: 'green',
}

/** the recommended option wears a thin yellow rule, never a fill: a background makes the text fight the terminal's own colours. */
const RULE = '▌'
const RULE_COLOR = 'yellow'

const optionSeparator = (ctx: ThemeCtx, width: number): RenderElement =>
  ctx.el.Text({ dimColor: true, children: '─'.repeat(Math.max(8, width)) })

const chooserRow = (ctx: ThemeCtx, option: DecisionOption, index: number, isDefault: boolean): RenderElement => {
  const { Box, Text, Button } = ctx.el
  const wide = ctx.columns >= WIDE
  const inner = room(ctx.columns, 4)
  const leftW = wide ? room(inner, META_W + 1) : inner
  const onFill = isDefault ? {} : { dimColor: true as const }

  const titleRow = Box({
    flexDirection: 'row',
    gap: 1,
    children: [
      Text({ ...onFill, bold: isDefault, children: `${index + 1} ·` }),
      Button({
        key: `${ctx.id}:option:${index}`,
        label: option.label,
        onPress: () => ctx.actions.fill(optionFill(option)),
      }),
      ...(isDefault ? [Text({ dimColor: true, children: 'default' })] : []),
    ],
  })

  const leftCol: RenderElement[] = [
    titleRow,
    ...(option.detail
      ? [
          Box({
            width: leftW,
            children: Text({ wrap: 'wrap', children: cleanText(option.detail) }),
          }),
        ]
      : []),
  ]

  const meta: RenderElement[] = []
  if (option.estimate) meta.push(Text({ ...onFill, children: `≈ ${option.estimate}` }))
  if (option.risk) {
    meta.push(
      Text({
        ...(isDefault ? { color: RISK_COLOR[option.risk] } : { dimColor: true, color: RISK_COLOR[option.risk] }),
        children: `risk: ${option.risk}`,
      }),
    )
  }
  if (option.cost) meta.push(Text({ ...onFill, children: option.cost }))

  const rowProps = { key: `${ctx.id}:option-row:${index}` }
  // one column of rule, one of air: every row pays for them so the labels stay on one grid
  const rule = Text({ ...(isDefault ? { color: RULE_COLOR } : {}), children: isDefault ? RULE : ' ' })

  if (wide) {
    return Box({
      ...rowProps,
      flexDirection: 'row',
      gap: 1,
      width: inner,
      children: [
        rule,
        Box({ flexDirection: 'column', width: leftW - 2, children: leftCol }),
        ...(meta.length > 0 ? [Box({ flexDirection: 'column', width: META_W, alignItems: 'flex-end', children: meta })] : []),
      ],
    })
  }

  return Box({
    ...rowProps,
    flexDirection: 'row',
    gap: 1,
    width: inner,
    children: [rule, Box({ flexDirection: 'column', width: inner - 2, children: [...leftCol, ...meta] })],
  })
}

const chooserBlock = (ctx: ThemeCtx, decision: NonNullable<CardModel['decision']>): RenderElement => {
  const { Box } = ctx.el
  const inner = room(ctx.columns, 4)
  const rows: RenderElement[] = []
  for (let i = 0; i < decision.options.length; i++) {
    if (i > 0) rows.push(optionSeparator(ctx, inner))
    rows.push(chooserRow(ctx, decision.options[i]!, i, decision.defaultKey === decision.options[i]!.key))
  }
  return Box({ key: `${ctx.id}:options`, flexDirection: 'column', children: rows })
}

const decisionBox = (ctx: ThemeCtx, model: CardModel, index: number, verdict: boolean): RenderElement => {
  const { Box, Text } = ctx.el
  const decision = model.decision!
  const item = model.items[index]
  const clause = decision.options.length === 0 ? defaultLine(decision) : null
  const inner = room(ctx.columns, 4)

  const options: RenderElement[] =
    decision.options.length >= 3
      ? [chooserBlock(ctx, decision)]
      : decision.options.length > 0
        ? [Box({ flexDirection: 'row', gap: 1, children: optionButtons(ctx, decision) })]
        : []

  return Box({
    key: `${ctx.id}:decision`,
    flexDirection: 'column',
    width: ctx.columns,
    borderStyle: 'round',
    borderColor: 'yellow',
    paddingX: 1,
    paddingY: 1,
    gap: 1,
    children: [
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 1,
        children: [
          Text({ color: 'yellow', children: '🟡 DECISION' }),
          ...(clause ? [Text({ dimColor: true, wrap: 'truncate', children: `default ${clause}` })] : []),
        ],
      }),
      Text({ bold: verdict, wrap: 'wrap', children: cleanText(decision.question) }),
      ...options,
      ...(item ? itemTail(ctx, item, index, inner) : []),
    ],
  })
}

const blockedBox = (ctx: ThemeCtx, item: CardItem, index: number): RenderElement => {
  const { Box, Text } = ctx.el
  const inner = room(ctx.columns, 4)
  return Box({
    key: `${ctx.id}:blocked:${index}`,
    flexDirection: 'column',
    width: ctx.columns,
    borderStyle: 'round',
    borderColor: 'red',
    paddingX: 1,
    paddingY: 1,
    gap: 1,
    children: [
      Box({
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 1,
        children: [Text({ color: 'red', children: '🔴 BLOCKED' }), Text({ dimColor: true, children: 'only you can unblock' })],
      }),
      Text({ bold: true, wrap: 'wrap', children: cleanText(item.text) }),
      ...itemTail(ctx, item, index, inner),
    ],
  })
}

/** Continuations and fences under a marker line; `index` only for keys. */
const itemTail = (ctx: ThemeCtx, item: CardItem, index: number, width: number): RenderElement[] => {
  const blocks = codeBlocks(ctx, item)
  return [
    ...item.lines.map((line, i) =>
      ctx.el.Box({
        key: `${ctx.id}:item:${index}:line:${i}`,
        width,
        paddingLeft: 2,
        children: ctx.el.Text({ dimColor: true, wrap: 'wrap', children: cleanText(line) }),
      }),
    ),
    ...(blocks.length > 0
      ? [ctx.el.Box({ key: `${ctx.id}:item:${index}:code`, paddingLeft: 2, width, children: blocks })]
      : []),
  ]
}

/**
 * Inverted-pyramid fold for marker lines and the read box. With no `lines`, code
 * blocks stay visible (themes.test.ts); folds appear only once `lines` is non-empty.
 */
const foldingItemTail = (ctx: ThemeCtx, item: CardItem, index: number, width: number): RenderElement[] => {
  const hasCode = item.code.length > 0
  const hasLines = item.lines.length > 0
  if (!hasLines && !hasCode) return []
  if (!hasLines) {
    const blocks = codeBlocks(ctx, item)
    return blocks.length > 0
      ? [ctx.el.Box({ key: `${ctx.id}:item:${index}:code`, paddingLeft: 2, width, children: blocks })]
      : []
  }

  const summaryOpen = itemFoldOpen(ctx, index, 'summary')
  const detailOpen = itemFoldOpen(ctx, index, 'detail')
  const rows: RenderElement[] = []

  if (needsFoldRow(summaryOpen, ITEM_FOLD_OPEN)) rows.push(itemFoldRow(ctx, index, 'summary', summaryOpen, width))
  if (summaryOpen) {
    rows.push(
      ctx.el.Box({
        key: `${ctx.id}:item:${index}:line:0`,
        width,
        paddingLeft: 2,
        children: ctx.el.Text({ dimColor: true, wrap: 'wrap', children: cleanText(item.lines[0]!) }),
      }),
    )
    const hasDetail = item.lines.length > 1 || hasCode
    if (hasDetail) {
      if (needsFoldRow(detailOpen, ITEM_FOLD_OPEN)) rows.push(itemFoldRow(ctx, index, 'detail', detailOpen, width))
      if (detailOpen) {
        for (let i = 1; i < item.lines.length; i++) {
          rows.push(
            ctx.el.Box({
              key: `${ctx.id}:item:${index}:line:${i}`,
              width,
              paddingLeft: 2,
              children: ctx.el.Text({ dimColor: true, wrap: 'wrap', children: cleanText(item.lines[i]!) }),
            }),
          )
        }
        const blocks = codeBlocks(ctx, item)
        if (blocks.length > 0) {
          rows.push(ctx.el.Box({ key: `${ctx.id}:item:${index}:code`, paddingLeft: 2, width, children: blocks }))
        }
      }
    }
  }
  return rows
}

const readBox = (ctx: ThemeCtx, item: CardItem, verdict: boolean, index: number): RenderElement => {
  const { Box, Text } = ctx.el
  const width = room(ctx.columns, 4)
  return Box({
    key: `${ctx.id}:read:${index}`,
    flexDirection: 'column',
    width: ctx.columns,
    borderStyle: 'round',
    borderColor: WARN_COLOR,
    paddingX: 1,
    children: [
      Box({
        flexDirection: 'row',
        gap: 1,
        children: [
          Text({ children: GLYPH.read }),
          Box({ width, children: Text({ bold: verdict, wrap: 'wrap', children: cleanText(item.text) }) }),
        ],
      }),
      ...foldingItemTail(ctx, item, index, width),
    ],
  })
}

const markerLine = (ctx: ThemeCtx, item: CardItem, verdict: boolean, index: number): RenderElement => {
  const { Box, Text } = ctx.el
  const width = room(ctx.columns, 4)
  const glyphProps = item.marker === 'done' ? { color: 'green' as const } : {}
  return Box({
    key: `${ctx.id}:marker:${index}`,
    flexDirection: 'column',
    width: ctx.columns,
    children: [
      Box({
        flexDirection: 'row',
        gap: 1,
        children: [
          Text({ children: GLYPH[item.marker], ...glyphProps }),
          Box({ width, children: Text({ bold: verdict, wrap: 'wrap', children: cleanText(item.text) }) }),
        ],
      }),
      ...foldingItemTail(ctx, item, index, width),
    ],
  })
}

const verdictBox = (ctx: ThemeCtx, item: CardItem, index: number): RenderElement => {
  const { Box, Text } = ctx.el
  const inner = room(ctx.columns, 3)
  return Box({
    key: `${ctx.id}:verdict`,
    flexDirection: 'row',
    width: ctx.columns,
    borderStyle: 'round',
    borderColor: VERDICT_BORDER[item.marker],
    paddingX: 1,
    children: [
      Box({
        flexDirection: 'column',
        width: inner,
        gap: 1,
        children: [
          Text({ bold: true, wrap: 'wrap', children: `${GLYPH[item.marker]} ${cleanText(item.text)}` }),
          ...item.lines.map((line, i) =>
            Box({ key: `${ctx.id}:verdict:line:${i}`, children: Text({ wrap: 'wrap', children: line }) }),
          ),
          ...codeBlocks(ctx, item),
        ],
      }),
    ],
  })
}

const oneLineCard = (ctx: ThemeCtx, item: CardItem): RenderElement => {
  const { Box, Text } = ctx.el
  const width = room(ctx.columns, 6)
  return Box({
    key: `${ctx.id}:oneline`,
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: ctx.columns,
    borderStyle: 'round',
    paddingX: 1,
    children: [
      Box({
        flexDirection: 'row',
        gap: 1,
        children: [
          Text({ children: GLYPH[item.marker], ...(item.marker === 'done' ? { color: 'green' } : {}) }),
          Box({ width, children: Text({ wrap: 'wrap', children: cleanText(item.text) }) }),
        ],
      }),
      ...witnessMark(ctx),
    ],
  })
}

const skipSection = (ctx: ThemeCtx, model: CardModel): RenderElement[] => {
  const skipItems = model.items.filter(item => item.marker === 'skip')
  if (skipItems.length === 0) return []
  const open = isOpen(ctx.state, 'skip', SKIP_OPEN)
  const rows: RenderElement[] = []
  if (needsFoldRow(open, SKIP_OPEN)) rows.push(skipFoldRow(ctx, skipItems.length, open))
  if (!open) return rows
  for (const item of skipItems) {
    const index = model.items.indexOf(item)
    rows.push(markerLine(ctx, item, false, index))
  }
  return rows
}

const render = (model: CardModel, ctx: ThemeCtx): RenderElement => {
  const { Box } = ctx.el
  const rows: RenderElement[] = []

  if (isOneLine(model)) {
    rows.push(oneLineCard(ctx, model.items[0]!))
    const cost = costLine(ctx)
    if (cost) rows.push(cost)
    return Box({
      key: `${ctx.id}:card`,
      flexDirection: 'column',
      width: ctx.columns,
      gap: 1,
      children: [...preambleLines(ctx, model), ...rows],
    })
  }

  const pure = isPureAnswer(model)
  const verdict = verdictIndex(model)
  const decision = decisionIndex(model)

  const header = headerRow(ctx, pure)
  if (header) rows.push(header)

  const skipDrawn = new Set<number>()
  if (decision >= 0) skipDrawn.add(decision)
  for (let i = 0; i < model.items.length; i++) {
    if (model.items[i]!.marker === 'blocked') skipDrawn.add(i)
  }
  if (verdict >= 0 && !pure && model.items[verdict]!.marker === 'read') skipDrawn.add(verdict)
  if (verdict >= 0 && !skipDrawn.has(verdict)) {
    rows.push(verdictBox(ctx, model.items[verdict]!, verdict))
    skipDrawn.add(verdict)
  }
  if (!pure) {
    const counters = countersRow(ctx, model)
    if (counters) rows.push(counters)
  }

  if (decision >= 0) {
    rows.push(decisionBox(ctx, model, decision, verdict === decision))
    skipDrawn.add(decision)
  }
  for (let i = 0; i < model.items.length; i++) {
    const item = model.items[i]!
    if (item.marker === 'blocked') {
      rows.push(blockedBox(ctx, item, i))
      skipDrawn.add(i)
    } else if (item.marker === 'decide' && i !== decision) {
      rows.push(markerLine(ctx, item, i === verdict, i))
      skipDrawn.add(i)
    }
  }

  for (let i = 0; i < model.items.length; i++) {
    const item = model.items[i]!
    if (item.marker !== 'done' && item.marker !== 'read' && item.marker !== 'info') continue
    if (skipDrawn.has(i)) continue
    if (item.marker === 'read') rows.push(readBox(ctx, item, i === verdict, i))
    else rows.push(markerLine(ctx, item, i === verdict, i))
  }

  rows.push(...skipSection(ctx, model))
  const cost = costLine(ctx)
  if (cost) rows.push(cost)

  return Box({
    key: `${ctx.id}:card`,
    flexDirection: 'column',
    width: ctx.columns,
    gap: 1,
    children: [...preambleLines(ctx, model), ...rows],
  })
}

export const theme: Theme = {
  id: 'gmorel',
  name: 'gmorel 1.1.0',
  tagline: 'K layout: counters, boxed decision, plain lines, cost footer',
  render,
}
