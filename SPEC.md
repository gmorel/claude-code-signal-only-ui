# signal-only-ui — specification v0.3

A Claude Code mod (function-hooks plugin, TypeScript running inside Claude Code's process). The model writes the substance of a reply — verdict, decision, done, to read — as marker lines. The mod draws the form: a themed card, folded details, hidden observer reports, a witness mark, folded narration, optional cost footer. Display only: the stored transcript is never rewritten.

Ground truth for the API is `.claude/types/claude-code.d.ts` (Claude Code 2.1.273, written by `/plugin-types`). Read it before assuming a prop or an event exists. Reference implementations of the same API: `galElmalah/claude-mods` (`claude-mermaid/hooks/register.ts` rewrites `AssistantMessage` text; `claude-queue/hooks/register.ts` draws Box/Text/Button/Input trees and uses `$.ui.invalidate`, `$.ui.log`, `$.prompt.fill`, `$.clock.after`, `$.store`, `$.agent.list`).

## 1. Principle

- Substance stays in the prompt: which marker a fact deserves, one decision with its default, ranking by consequence. The mod never judges content and never invents verification.
- Form moves to the renderer: framing, colour, bold, folding, hiding, the witness mark. The model's text is read as data.
- Nothing is sent on the reader's behalf. A button may fill the prompt box (`$.prompt.fill`), never submit it.
- Two surfaces: `terminal` and `desktop` (`RenderSurface`). `AbovePrompt` and `Pane` are terminal-only and are NOT used in v0.3.

## 2. Input: the card grammar

An `AssistantMessage` block (`ui.render`, props `{ text, isFirstOfReply }`) is a **card** when, after stripping one level of `> ` from every line:

- it opens with `**👉 For you**` / `**👉 Pour toi**`, **or**
- at least two **distinct** marker glyphs appear, **or**
- marker lines are the majority of its non-empty lines.

Lines before the first marker are kept in `CardModel.preamble` and drawn above the card as plain text. Cards without the `>` wrapper are accepted on purpose: the wrapper rule is a presentation rule the mod makes unnecessary.

Parsing rules (`hooks/card.ts`, pure, unit-tested):

1. Strip a leading `>` and one optional space from each line. `quoted` = every non-empty line had one.
2. A line equal to `**👉 For you**` or `**👉 Pour toi**` (bold optional, trailing spaces ignored) sets `header = true` and is not an item.
3. A line whose first token is a marker glyph opens an item. Text after the glyph is the item text. A line is bold only when it is exactly `**…**` with no other `**` inside (`text.split('**').length === 3`); otherwise inline `**` pairs are stripped and `bold` is false. A label before stars (`À décider : **…**`) may still mark bold.
4. A line without a marker attaches to the previous item as a continuation (`lines`), or to `preamble` before any item.
5. A fenced block opens on a line of ≥3 backticks; it closes only on a closing fence of at least the same backtick length (nested shorter fences do not close early). Fences attach to the previous item as `code` verbatim, language kept.
6. Control characters except tab and newline are stripped from text handed to `Text` and `Code`.
7. `verdict` = the first bold `decide` item if any, else the first bold item, else null.
8. `decision` = parsed from the first `decide` item and its continuation lines: remove a leading decide label; split off the default clause matched case-insensitively by `/\b(?:if you say nothing|sans réponse(?: de ta part)?|default|par défaut)\s*:\s*(.+)$/iu` → `defaultText`; `options` from `A or B?` / `A ou B ?` when both sides ≤ 40 chars after stripping interrogative stems (`should I`, `dois-je`, …) and neither side is more than 2× the other's word count; also `A, B ou C ?` with inline `A = …` titles and `▫️ A — detail` lines.
9. `counts` per marker. `raw` = the original text.

A block that is not a card is passed through: `return next(e)`.

## 3. Behaviours

### 3.1 Card render
`on('ui.render', { component: 'AssistantMessage' })`: parse; if card, `theme.render(model, ctx)` where `theme` is the configured one; else `next(e)`. `ctx.el = $.ui.resolve(e)`; `ctx.columns = (e.viewport?.columns ?? 80) - 4`; `ctx.id` = `e.requestId`; `ctx.usage` = priced usage from the last completed turn when available. Per-id `CardState` lives in a module Map; a Button's `onPress` flips a fold and calls `$.ui.invalidate('ui.render')`.

### 3.2 Narration folding (config `foldNarration`, default on)
An assistant text block followed by a tool call in the same main-loop turn is narration. Tracking uses `turn.step` (not `tool.call` alone): text chunks accumulate per block index; when a tool chunk arrives, earlier non-empty text blocks in that step are recorded in `narrationByText` and `narrated`. At render time, `narrationMarkedOf` matches by message id or by text. Only message ids drawn in the **current** turn's stream are added to `waiting` (id paired with `turnId`); redraws of previous turns' messages are not marked. `narrationByText` is cleared on `turn.start` so a repeated phrase in a later turn does not fold that turn's real answer. When `tool.call` still beats the render hook, `narrationPending` + `narrationFallbackOnBlock` apply the final-block rule. A narration block renders as one dim line: `· narration · n lines  [show]`. The final block of a turn is never marked.

### 3.3 Observer reports hidden + witness mark (config `observerMark`, default on)
- `on('ui.render', { component: 'UserMessage' })`: if `e.props.origin.kind === 'observer'` → return `Box({ display: 'none' })` and count it for the current turn (dedupe on text).
- Witness: on `turn.start` and on `turn.complete`, and mid-turn when stale, `$.agent.list()` → `observerRunning`. `ctx.witness.hiddenReports` counts reports hidden this turn.
- The shared `witnessMark` draws: `hiddenReports > 0` → amber `⚑ N observer reports`; `hiddenReports === 0 && observerRunning` → dim green `✓`; otherwise nothing. Themes must not draw the witness as the card's own 🟢.
- Terminal: hidden reports are listed by `/signal observers` (text answer).

### 3.4 Notifications folded (config `foldNotifications`, default on)
`UserMessage` with `origin.kind` in `task-notification | peer | peer-send-message | scheduled-trigger | projects-relay` → one dim line `· <kind label> · [show]`; `[show]` toggles `next(e)`. `composer`, `bridge`, `sdk`, `channel` and unknown kinds pass through untouched.

### 3.5 `/signal` command
Registered on `session.start` (`immediate: true`). Words: `theme <id>` (switch, persist in `$.store`, `$.ui.invalidate`), `themes` (list ids + taglines), `observer on|off`, `fold on|off`, `reset` (restore plugin defaults), `observers` (hidden reports, newest first, capped at 20), `agents` (what `$.agent.list()` reports, marking configured observer types), no word → status line. Prefs in `$.store` key `prefs`; userConfig values are the defaults, store overrides them.

### 3.6 Cost footer
When the engine reports `usage` on `turn.complete`, the last assistant message of that turn may show `≈ $X · N tokens · API price` in themes that draw it (e.g. `gmorel`). Prices come from the built-in table or the `prices` userConfig option (USD per million tokens, `family:input/output`).

### 3.7 Budget
Every hook must return in well under the 10 s budget; parsing is O(lines). No network, no fs, no process: hooks run without Node.

## 4. Themes (`hooks/themes/<id>.ts`, each exporting `theme: Theme`)

All four share: preamble as plain lines above the card; verdict line drawn bold once (and only once, apart from gmorel counter chrome); `decide` first when present, then `read`, then `done`, then `info`, then `skip`; every `decide` after the first and every `blocked` drawn (never dropped); the shared `witnessMark`; folds via `ctx.state.open` with the defaults listed per theme; fenced code via `el.Code({ source, language })`.

| id | name | what it draws | folds default |
|---|---|---|---|
| `receipt` | Receipt | one colour (yellow), `borderStyle: classic` frame: header `FOR YOU` inverse, dotted leaders to `[OK]` `[!!]` `[??]`; three-option chooser as an order form (`YOUR ORDER, PLEASE`). No invented verification footer. Mirrors `DirectionF.dc.html` / `DirectionF2.dc.html`. | skip closed |
| `kanban` | Sticky kanban | three filled sticky columns when `columns ≥ 84` (TO DECIDE · DONE · TO READ + NOTES); three-option chooser uses OPTIONS / DECIDED / WHY I ASK. Mirrors `DirectionH.dc.html` / `DirectionH2.dc.html`. | skip closed |
| `gmorel` | gmorel | counter tiles (decision · done · to read · blocked), boxed decision and blocked, plain marker lines, ℹ️ fold, API-price footer. `done` tile shows count `N`, not `N/N` or "proven". Mirrors `DirectionA2` / K variants. | skip closed |

Themes must not: call `$`, keep module state, fetch, or assume a column count > `ctx.columns`. Text wider than `ctx.columns` is wrapped by Text (`wrap: 'wrap'`), never truncated except fold summary lines.

The registry in `hooks/themes/index.ts` maps id → theme and is the only place a theme is listed.

## 5. Tests

- `tests/unit/card.test.ts` (bun): grammar — English and French labels; quoted and unquoted cards; preamble; card threshold; header detection; continuation lines; nested fences; options parsing; `unbold`; counts; non-cards return null.
- `tests/unit/themes.test.ts`: each theme renders a fixture model; exactly one narrative bold line; decision first; folds honoured; witness mark rules; every item text appears in the tree.
- `tests/unit/register.test.ts`: witness refresh, observer hiding, `/signal observers`, narration turn boundaries.
- `tests/unit/fold.test.ts`: narration and notification decisions as pure functions.
- `tests/e2e/`: real Claude Code in tmux, API mocked via aimock; skipped when `tmux` or `claude` is missing. Click test gated behind `E2E_CLICK=1`.

Run: `bun test tests/unit` from the repo root; `bunx -p typescript tsc -p .` for types (`.claude/types` is present locally, git-ignored, regenerated with `/plugin-types`).

## 6. Non-goals

Rewriting the stored transcript (`turn.step`); changing the user's prompt or Stop hook; drawing ```mermaid fences inside a card (claude-mermaid handles top-level fences); panes and the above-prompt band; inventing verification the model did not write.
