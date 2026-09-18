import type { EngineInterface, RenderElement, RenderInput, RenderSurface } from 'claude-code'

// The contract between the core (hooks/register.ts, hooks/card.ts) and a theme
// (hooks/themes/*.ts). A theme is a pure function from a parsed card and a
// small context to a render tree. It never touches `$` directly: everything it
// may do is on `ctx`.

/** The six markers of a card line, named by what the reader does with them. */
export type Marker = 'done' | 'decide' | 'blocked' | 'read' | 'info' | 'skip'

/** The glyph each marker is written with in the model's text. */
export const MARKER_GLYPHS: Readonly<Record<Marker, readonly string[]>> = {
  done: ['🟢'],
  decide: ['🟡'],
  blocked: ['🔴'],
  read: ['⚠️', '⚠'],
  info: ['▫️', '▫'],
  skip: ['ℹ️', 'ℹ'],
}

export type CodeBlock = { lang: string; source: string }

export type CardItem = {
  marker: Marker
  /** the line's text, marker removed, `**bold**` stripped (see `bold`) */
  text: string
  /** true when the line was the card's bold line */
  bold: boolean
  /** continuation lines that followed without a marker, prefix stripped */
  lines: string[]
  /** fenced code that followed the line inside the card, verbatim */
  code: CodeBlock[]
}

export type DecisionOption = {
  key?: string
  label: string
  detail?: string
  estimate?: string
  risk?: 'low' | 'medium' | 'high'
  cost?: string
}

export type Decision = {
  /** the question, without its leading label (`À décider :`, `Decide:`) and without the default clause */
  question: string
  /** what happens if the reader says nothing; null when the line has no default clause */
  defaultText: string | null
  /** when the default clause names an option key (`Sans réponse de ta part : B`), the matching key */
  defaultKey: string | null
  /** short answers parsed from the question; empty when none could be read */
  options: DecisionOption[]
}

export type CardModel = {
  /** plain lines before the first marker; every theme draws them above the card */
  preamble: string[]
  /** the card opened with `👉 For you` / `👉 Pour toi` */
  header: boolean
  /** the bold line: the 🟡 when there is one, else the first bold line */
  verdict: CardItem | null
  /** the first 🟡 line, parsed */
  decision: Decision | null
  /** every marker line, in order, the verdict included */
  items: CardItem[]
  counts: Record<Marker, number>
  /** true when every non-empty line started with `>` */
  quoted: boolean
  raw: string
}

/** Which folds are open for one drawn card; the theme reads it, the core owns it. */
export type CardState = {
  open: Partial<Record<'done' | 'read' | 'info' | 'skip' | 'narration', boolean>>
  /** the answer a decision button put in the prompt box, if any */
  answered: string | null
}

export type Witness = {
  /** an agent listed by `$.agent.list()` matches the configured observer types and is running */
  observerRunning: boolean
  /** observer reports hidden since the last card was drawn */
  hiddenReports: number
}

export type ThemeActions = {
  /** flip a fold and redraw */
  toggle(section: keyof CardState['open']): void
  /** put text in the prompt box for the reader to send (never sends) */
  fill(text: string): void
}

/** The element table for this render, from `$.ui.resolve(e)`. */
export type Elements = ReturnType<EngineInterface['ui']['resolve']>

export type ThemeCtx = {
  el: Elements
  /** columns available to the card, gutter already removed */
  columns: number
  surface: RenderSurface
  state: CardState
  actions: ThemeActions
  witness: Witness
  /** the message's stable id, for `key`s */
  id: string
  /** last completed turn's API usage, when the engine reported it for this message */
  usage?: { inputTokens: number; outputTokens: number; costUsd: number }
}

export type Theme = {
  /** file stem under hooks/themes/, also the `/signal theme <id>` word */
  id: string
  name: string
  /** one line for `/signal` and the README */
  tagline: string
  render(model: CardModel, ctx: ThemeCtx): RenderElement
}

export type AssistantRender = RenderInput<'AssistantMessage'>
