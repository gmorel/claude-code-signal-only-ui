import type { RenderElement } from 'claude-code'
import type { CardItem, CardModel, CardState, Decision, DecisionOption, Marker, ThemeCtx } from '../theme.ts'

// What the three themes of v0.1 agree on, so the agreement lives in one file
// and not in three: the order the markers are drawn in, the fold arithmetic,
// the single bold line and the witness mark. Pure: no `$`, no module state.

/** A group of items that can be folded away. `decide` and `blocked` have no fold: they are why the card was drawn. */
export type Section = 'done' | 'read' | 'info' | 'skip'

/**
 * The order SPEC §4 fixes: what you must answer, then what could bite you,
 * then what happened, then the rest. `blocked` is not in §4's list; it rides
 * with the head of the card because it, like `decide`, waits on the reader.
 */
export const ORDER: readonly Marker[] = ['decide', 'blocked', 'read', 'done', 'info', 'skip']

export const sectionOf = (marker: Marker): Section | null =>
  marker === 'done' || marker === 'read' || marker === 'info' || marker === 'skip' ? marker : null

/** The reader's choice when they made one, the theme's default when they did not. */
export const isOpen = (state: CardState, section: Section, byDefault: boolean): boolean =>
  state.open[section] ?? byDefault

/**
 * Every fold must be reversible, but a section that is open because the theme
 * opens it by default needs no line of chrome above it — the mockups show a
 * summary only where something is hidden. So: draw the summary when the
 * section is closed, or when the reader had to open it themselves.
 */
export const needsFoldRow = (open: boolean, byDefault: boolean): boolean => !open || !byDefault

/** How a folded section counts itself. Plural by hand: these are four fixed words, not a grammar. */
export const countLabel = (section: Section, n: number): string => {
  if (section === 'skip') return `${n} skippable line${n === 1 ? '' : 's'}`
  if (section === 'info') return `${n} note${n === 1 ? '' : 's'}`
  if (section === 'read') return `${n} to read`
  return `${n} done`
}

/** One item with the index it has in `model.items`, so a theme can name the verdict by position and not by equality. */
export type Placed = { item: CardItem; index: number }
export type Group = { marker: Marker; items: Placed[] }

/** The card's items in §4's order, grouped by marker; `skipIndex` drops the item a theme draws elsewhere (the decision). */
export const grouped = (model: CardModel, skipIndex: number): Group[] => {
  const placed: Placed[] = model.items.map((item, index) => ({ item, index }))
  return ORDER.map(marker => ({
    marker,
    items: placed.filter(p => p.item.marker === marker && p.index !== skipIndex),
  })).filter(group => group.items.length > 0)
}

/**
 * Where the one bold line sits. `model.verdict` is normally the very object
 * the parser put in `items`; the marker+text fallback is there so a parser
 * that copies instead of aliasing still marks exactly one line, never two.
 */
export const verdictIndex = (model: CardModel): number => {
  const verdict = model.verdict
  if (!verdict) return -1
  const byIdentity = model.items.indexOf(verdict)
  if (byIdentity >= 0) return byIdentity
  return model.items.findIndex(item => item.marker === verdict.marker && item.text === verdict.text)
}

/** The index of the item the decision was parsed from, or -1: the theme draws that one as the decision and not as an ordinary line. */
export const decisionIndex = (model: CardModel): number =>
  model.decision === null ? -1 : model.items.findIndex(item => item.marker === 'decide')

export const WITNESS = '✓'

/** control characters except tab and newline, stripped before Text and Code */
export const cleanText = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

/**
 * The mod's own mark, never the model's (SPEC §3.3). Hidden observer reports
 * show an amber flag; a running observer with none hidden shows dim green ✓.
 */
export const witnessMark = (ctx: ThemeCtx): RenderElement[] => {
  const { hiddenReports, observerRunning } = ctx.witness
  if (hiddenReports > 0) {
    const label = `⚑ ${hiddenReports} observer report${hiddenReports === 1 ? '' : 's'}`
    return [ctx.el.Text({ dimColor: true, color: 'yellow', children: label })]
  }
  if (observerRunning) return [ctx.el.Text({ dimColor: true, color: 'green', children: WITNESS })]
  return []
}

/** plain preamble lines above the card */
export const preambleLines = (ctx: ThemeCtx, model: CardModel): RenderElement[] =>
  model.preamble.map((line, i) =>
    ctx.el.Box({
      key: `${ctx.id}:preamble:${i}`,
      width: ctx.columns,
      children: ctx.el.Text({ wrap: 'wrap', children: cleanText(line) }),
    }),
  )

/** The fold's summary line: a count and the one control that reverses the fold. */
export const foldRow = (
  ctx: ThemeCtx,
  section: Section,
  count: number,
  open: boolean,
  style: { color?: string } = {},
): RenderElement => {
  const { Box, Text, Button } = ctx.el
  return Box({
    key: `${ctx.id}:fold:${section}`,
    flexDirection: 'row',
    gap: 1,
    children: [
      // truncate here and only here: a summary is chrome, and chrome that
      // wraps onto a second line costs more than the line it hides
      Text({ dimColor: true, ...style, wrap: 'truncate', children: countLabel(section, count) }),
      Button({
        key: `${ctx.id}:toggle:${section}`,
        label: open ? 'hide' : 'show',
        dimColor: true,
        onPress: () => ctx.actions.toggle(section),
      }),
    ],
  })
}

/** CodeProps caps `source`; a longer fence is cut rather than failing the whole tree's validation. */
const MAX_CODE = 10000

/** The fences that followed an item, drawn by the engine's own highlighter. */
export const codeBlocks = (ctx: ThemeCtx, item: CardItem): RenderElement[] =>
  item.code.map(block => {
    const source = cleanText(block.source.length > MAX_CODE ? block.source.slice(0, MAX_CODE) : block.source)
    return ctx.el.Code({ source, ...(block.lang ? { language: block.lang } : {}) })
  })

/** what a decision button puts in the prompt box */
export const optionFill = (option: DecisionOption): string =>
  option.label.length <= 40 ? option.label : (option.key ?? option.label)

/**
 * The decision's answers, one Button each. A press fills the prompt box and
 * stops there: nothing is ever sent on the reader's behalf (SPEC §1).
 */
export const optionButtons = (ctx: ThemeCtx, decision: Decision): RenderElement[] =>
  decision.options.map((option, i) =>
    ctx.el.Button({
      key: `${ctx.id}:option:${i}`,
      label: option.label,
      onPress: () => ctx.actions.fill(optionFill(option)),
    }),
  )

/** The default clause, said the same way in all three themes. */
export const defaultLine = (decision: Decision): string | null =>
  decision.defaultText === null ? null : `if you say nothing: ${decision.defaultText}`

/** Room for a text column once the fixed chrome around it is paid for; never below 8, never above what the site gave us. */
export const room = (columns: number, spent: number): number => Math.max(8, columns - spent)

/** inserts a space after the last separator at or before width inside long runs so Ink can wrap with minimal breaks */
export const softBreak = (text: string, width: number): string => {
  if (width < 1 || text.length <= width) return text
  return text.replace(/\S+/g, run => {
    if (run.length <= width) return run
    let out = ''
    let segStart = 0
    let lastSep = -1
    for (let i = 0; i < run.length; i++) {
      if (/[/.\-_]/.test(run[i]!)) lastSep = i
      const segLen = i - segStart + 1
      if (segLen >= width) {
        if (lastSep >= segStart && lastSep !== run.length - 1) {
          out += run.slice(segStart, lastSep + 1) + ' '
          segStart = lastSep + 1
          lastSep = -1
          i = segStart - 1
        }
      }
    }
    out += run.slice(segStart)
    return out
  })
}
