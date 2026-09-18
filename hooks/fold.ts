// The folding decisions of SPEC §3.2–3.4, pure so they can be read and tested without an engine. The hooks in register.ts hold the state; these functions hold the rules.

/** the origin kinds a notification fold collapses; every other kind is the reader's own traffic and passes through */
export const FOLDED_KINDS = ['task-notification', 'peer', 'peer-send-message', 'scheduled-trigger', 'projects-relay'] as const

/** what each folded kind is called on its one dim line */
const KIND_LABELS: Readonly<Record<string, string>> = {
  'task-notification': 'background task',
  peer: 'another session',
  'peer-send-message': 'message from a session',
  'scheduled-trigger': 'scheduled trigger',
  'projects-relay': 'relayed message',
  observer: 'observer report',
}

export type NarrationInput = {
  /** the `foldNarration` preference */
  fold: boolean
  /** a tool call of this main-loop turn followed the block */
  marked: boolean
  /** the reader pressed `[show]` on it */
  open: boolean
  /** the block parsed as a card */
  isCard: boolean
}

/** whether an assistant block draws whole or as one dim line; a card is the signal, so a tool call after it never makes it noise */
export const narrationOf = ({ fold, marked, open, isCard }: NarrationInput): 'full' | 'folded' =>
  fold && marked && !open && !isCard ? 'folded' : 'full'

/** a `turn.step` chunk narrowed to the kinds narration tracking reads */
export type StepChunk =
  | { kind: 'text'; index: number; text: string }
  | { kind: 'tool'; index: number }
  | { kind: string; index?: number; text?: string }

/** whether a drawn block was marked narration by id or by its text (TurnStepChunk has no requestId) */
export const narrationMarkedOf = (id: string, text: string, narrated: ReadonlySet<string>, byText: ReadonlySet<string>): boolean =>
  narrated.has(id) || byText.has(text)

/**
 * One `turn.step` chunk: accumulate text per block index; when a tool chunk arrives, every
 * earlier non-empty text block in this step was narration. Chunks carry no message id, so
 * the render hook matches on text (and stableIdOf(undefined, text) in narrated).
 */
export const narrationTextsOfChunk = (
  blocks: ReadonlyMap<number, string>,
  chunk: StepChunk,
): { blocks: Map<number, string>; texts: string[] } => {
  if (chunk.kind === 'text' && typeof chunk.index === 'number' && typeof chunk.text === 'string') {
    const next = new Map(blocks)
    next.set(chunk.index, (next.get(chunk.index) ?? '') + chunk.text)
    return { blocks: next, texts: [] }
  }
  if (chunk.kind === 'tool' && typeof chunk.index === 'number') {
    const texts: string[] = []
    for (const [idx, text] of blocks) {
      if (idx < chunk.index && text.trim() !== '') texts.push(text)
    }
    return { blocks: new Map(blocks), texts }
  }
  return { blocks: new Map(blocks), texts: [] }
}

/**
 * When `tool.call` ran before any AssistantMessage drew: the next non-card block becomes a
 * candidate; it is marked only if another block follows before `turn.complete` (final block rule).
 */
export const narrationFallbackOnBlock = (
  candidate: string | undefined,
  id: string,
  isCard: boolean,
): { candidate: string | undefined; confirmed: string[] } => {
  if (isCard) return { candidate, confirmed: [] }
  const confirmed: string[] = []
  if (candidate !== undefined && candidate !== id) confirmed.push(candidate)
  return { candidate: id, confirmed }
}

/** the one dim line a folded block draws in place of its text */
export const narrationSummary = (text: string): string => {
  const n = text.split('\n').filter(line => line.trim() !== '').length
  return `· narration · ${n} ${n === 1 ? 'line' : 'lines'}`
}

export const foldsNotification = (kind: string): boolean => (FOLDED_KINDS as readonly string[]).includes(kind)

const FAIL_WORD = /\b(?:fail(?:ed|ing)?|error|blocked|exception|timed?\s*out|timeout)\b/i
const FAIL_EXIT = /\bexit\s+(?:code|status)\s+(\d+)\b/i
const FAIL_EXITED = /\bexited\s+with\s+(\d+)\b/i

/** a folded notification whose text smells like a failure stays whole so the reader sees it */
export const notificationLooksFailed = (text: string): boolean => {
  if (FAIL_WORD.test(text)) return true
  const code = FAIL_EXIT.exec(text)
  if (code && code[1] !== '0') return true
  const exited = FAIL_EXITED.exec(text)
  return exited !== null && exited[1] !== '0'
}

/** the kind in the reader's words; an unknown kind keeps its own name rather than being guessed at */
export const notificationKindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind

/** the one dim line a folded notification draws */
export const notificationSummary = (kind: string): string => `· ${notificationKindLabel(kind)} ·`

/** a background observer's report to the agent it watches: hidden, never folded */
export const isObserverOrigin = (kind: string): boolean => kind === 'observer'

/** FNV-1a, base36: short, stable across a session, and enough to tell two texts apart */
export const hashOf = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/**
 * One drawing of one message: the engine's instance id where there is one, the
 * text where there is not. The `requestId` path is what the render hook always
 * gets (`RenderInputOf.requestId` is a non-empty string); the text-hash fallback
 * is dead at render time and exists only for turn.step narration matching.
 */
export const stableIdOf = (requestId: string | undefined, text: string): string => requestId ?? `t${hashOf(text)}`

/** a report is redrawn on every frame, so it is counted once under a key that ignores its spacing */
export const reportKey = (text: string): string => {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return `${normalized.length}:${hashOf(normalized)}`
}
