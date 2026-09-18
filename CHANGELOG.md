# Changelog

All user-visible changes, newest first. Versions are the `version` of `.claude-plugin/plugin.json`.

## Unreleased

- The vector kanban is removed. `hooks/themes/kanban-svg.ts`, its unit test, `scripts/svg-preview.mjs`, the `svg:preview` script, the Playwright dev dependency and `docs/kanban-desktop.png` are gone, and `hooks/themes/kanban.ts` no longer branches on an `Svg` element. Reason: no client the reader uses could reach it — the terminal has no `Svg` in its element table and Claude Desktop runs an engine where no function hook loads at all. The code and the last render stay recoverable at `297fdbe`.
- The `bands` theme is removed, with its stills and its tests. Three themes remain — `gmorel`, `receipt`, `kanban` — and the default for a reader who sets nothing is now `gmorel`. A stored preference naming a theme that no longer exists falls back to the default instead of failing to draw.
- `gmorel` no longer fills the recommended option with a yellow background. It wears a thin yellow rule in the left column, its number bold and the word `default` dim; every other row pays the same two columns in blank so the labels stay on one grid. A fill forces the theme to set a text colour too, which is exactly what makes a card unreadable on a terminal whose colours it does not know.
- `gmorel` reads answer-first. The verdict is drawn in its own round box, bordered in the colour of its marker (green for a done line or a plain answer, orange for ⚠️, yellow for a decision, red for blocked) and placed above the counters — the old fixed cyan bar is gone. A counter reading 0 is no longer drawn, and a single tile is capped at 28 columns so it reads as a chip. Fenced blocks are indented under the line they belong to.
- `/signal audit on|off` (off by default): after a turn, the raw reply and the text the theme actually drew are handed to a `claude -p --model haiku` child, which lists anything present in the reply and absent from the card. Findings arrive as `$.ui.log` lines; the turn never waits for them. The child runs with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=0` so it cannot load this plugin and recurse. It costs a model call and about 30 seconds per turn, which is why it ships off.

## 0.8.0 — 2026-09-17

- kanban draws a real vector board on the surfaces that have one. `hooks/themes/kanban-svg.ts` turns the card model into an SVG: sticky notes with rounded corners, a tape band, a soft drop shadow, a slight deterministic rotation, and a `<title>` on each note so `isInteractive` gives a tooltip. The terminal is untouched — `Svg` does not exist there — and the element is feature-detected, never assumed from the surface name.
- `npm run svg:preview` (`scripts/svg-preview.mjs`) renders that SVG with Playwright to `docs/kanban-desktop.png`, so the drawing can be checked without a surface that draws it.
- Card text is XML-escaped before it reaches the document, and a unit test proves the viewBox contains every note including its rotation, shadow offset and blur — the first render clipped both edges because a rotated, shadowed rectangle extends past its own box.

## 0.7.0 — 2026-09-17

- kanban: a column with nothing in it is no longer drawn, and the surviving columns share the width in proportion to how much text they hold — a decision column never below 28 columns, the others never below 18, none above 55% of the card.
- kanban: every note now reads as paper — its first line sits on a darker band of its own fill and the rest on the lighter one, with a shadow row offset one column right and one narrower underneath. Nothing drawn on a note's fill is dim any more; grey on a light fill was unreadable.
- kanban: option buttons stack one per row inside their column instead of spilling into the next one.
- `npm run demo` records eight cards instead of two — the plain card and the question for all four themes — in a 32-row pane, and sets `LANG`/`LC_ALL` to UTF-8. Without that the recording inherits the shell's `C` locale and every `☑`, `⚠️` and `✻` silently degrades to ASCII. A guard now counts those glyphs and refuses a recording that lost them.
- `scripts/capture.mjs` waited for wording only the gmorel theme prints, so `docs/kanban.png` could not be regenerated. The wait is theme-independent and all eight stills are re-drawn.

## 0.6.0 — 2026-09-17

- The README leads with an animated demo, `docs/demo.gif`: a real Claude Code session with the API mocked, recorded by `npm run demo` from `scripts/demo.mjs`. It types a card, opens both fold layers, asks a three-option question and tours the four themes. The asciicast it renders from is committed beside it as `docs/demo.cast`, so the recording can be replayed and diffed rather than trusted.
- New skill `demo-sync`: re-record the demo after a change under `hooks/`, look at the GIF, and a one-line staleness check that lists any hook file newer than the GIF.
- No cost footer when a turn used no tokens — `≈ $0.00 · 0 tokens · API price` was noise in every theme.
- `tests/e2e/harness.ts` gained optional `name`, `debug`, `tmuxSocket` and `tmuxConfig`, all defaulting to the previous behaviour, so the demo can attach to the pane it creates.

## 0.5.1 — 2026-09-17

- gmorel: a marker item now folds as an inverted pyramid — the hook line is always visible, its first continuation line is a folded `+ summary`, and the rest plus any code blocks are a folded `+ detail` reachable once the summary is open. An item with nothing under it draws no fold row, and two items fold independently.

## 0.5.0 — 2026-09-17

- gmorel: the default option is shown by a light yellow block (`#F7E9A8`) with dark text instead of a `default if you say nothing: …` sentence in the DECISION header; the `[ default ]` badge stays as the fallback signal on terminals without colour. A decision with no options still writes the sentence, since there is nothing to highlight.
- gmorel: the `👉 For you` label is gone; the header row now carries only the witness mark, and disappears entirely when there is none.
- gmorel: a `⚠️` line is drawn in its own round box with an orange border (`#D98324`), text in the terminal's normal colour — a border reads on a screen with reflections where orange text does not.
- gmorel: the `🟢` marker is drawn as a green `☑`. The parser still accepts `🟢` from the model; only the drawing changed.

## 0.4.3 — 2026-09-17

- A folded notification whose text names a failure (`fail`, `error`, `blocked`, `exception`, `timeout`, a non-zero exit code) is drawn whole instead of collapsed to its dim line — a background task that failed can no longer look like one that succeeded.
- Long paths and URLs are soft-broken at their own separators before they are drawn, so a narrow column wraps them instead of overflowing its filled background; the break count is minimal and a token that fits is untouched.
- kanban: the `DEFAULT` badge sits after the option title when there is room and on its own line when there is not; it never wraps mid-word.
- receipt: the header band is drawn on the plain card too, not only on the question card.
- README: install a released tag rather than `main` and do not symlink a clone you are editing; themes assume a dark truecolor terminal (`receipt` is the monochrome fallback); the price table is hardcoded, dated 2026-09 and overridable with the `prices` option.

## 0.4.2 — 2026-09-16

- Chooser buttons: themes no longer wrap Button labels in brackets; the engine already draws `[ label ]`.
- bands: filled default option row uses dark text throughout (detail, meta, default badge); nothing dim on yellow.
- receipt: order table uses fixed `#`, ITEM, TIME and RISK columns with aligned headers and rows.
- kanban: chooser columns have fixed widths; OPTIONS stickies do not shrink or overflow into DECIDED.
- All themes: option detail text wraps within its row or column width.

## 0.4.1 — 2026-09-16

- Witness ⚑ count: hidden observer reports are counted since the previous card was drawn, not since turn start; a report between turns redraws the last card and the next turn’s first card carries the flag.
- Card threshold: continuation lines count as part of their marker item when judging whether markers are the majority of lines.
- Earlier rename: `board` is now `kanban`.

## 0.4.0 — 2026-09-16

- Themes `bands`, `receipt` and `kanban` rewritten to match their design artboards (Direction E/F/H): rounded frame and tinted rows for bands, classic ASCII till roll for receipt, filled sticky-note columns for kanban.
- Each shipped theme draws decisions with three or four options as a chooser (estimate, risk, cost when present, default badge, numbered buttons); two-option cards keep the simpler layout.
- README: pain-point section up front; theme table shows normal and question captures per theme.
- `scripts/shoot-cmux.sh`: crop offsets overridable via `SHOOT_X`, `SHOOT_Y`, `SHOOT_W`, `SHOOT_H`.

## 0.3.0 — 2026-09-16

- Card threshold: a reply is a card only with the `👉 For you` header, at least two distinct markers, or markers as the majority of lines; prose before the first marker is kept in `preamble` and drawn above every theme.
- Parser: case-insensitive default clauses (`Default:`, `Par défaut :`, `Sans réponse :`) read from continuation lines; interrogative stems stripped from option labels; lopsided `A or B` pairs dropped; nested fences close only on a fence of equal or greater backtick length; control characters stripped from `Text` and `Code`; `unbold` only when the line is exactly `**…**`.
- Witness mark: hidden observer reports show amber `⚑ N observer reports`; running observer with none hidden shows dim green `✓`; receipt drops the invented `VERIFIED IN THIS SESSION` footer; gmorel `done` tile shows `N`, not `N/N` or "proven".
- gmorel draws every `decide` and `blocked` item (extras as marker lines or boxes), never skipping past the first.
- Narration folding: `waiting` ids paired with `turnId`; `narrationByText` cleared on `turn.start`; redraws of previous turns no longer marked as narration.
- 155 unit tests (register, invariant item-text coverage for all themes); e2e click test gated behind `E2E_CLICK=1`.
- Docs: SPEC v0.3, README validate command and Claude Code 2.1.273+, fixture text unified, theme-builder artboard count corrected; `capture.mjs` resolves Chrome from env; `e2e.sh` preflight for required tools.

## 0.2.0 — 2026-09-16

- Theme `gmorel` 1.1.0: witness ✓ redrawn when an observer starts after the card was drawn; decisions with three or four options (`A, B ou C ?`, `A = …` titles, `▫️ A — detail` lines) drawn as a numbered chooser with estimate, risk and cost per option; option buttons fill the prompt with the option's key.
- Cost footer prices cache reads at 10 % and cache writes at 125 % of the input rate (was: full input rate, up to 10× over-stated on long sessions).

## 0.1.0 — 2026-09-16

- First release: marker-card parser (`hooks/card.ts`), narration and notification folding, observer reports hidden behind a witness ✓, `/signal` command (`theme`, `themes`, `observer`, `fold`, `reset`, `observers`, `agents`).
- Themes `bands`, `receipt`, `kanban`, `gmorel` 1.0.0 (K layout: counter tiles, boxed decision and blocked, marker lines, ℹ️ fold, API-price footer).
- Options `theme`, `observerMark`, `observerTypes`, `foldNarration`, `foldNotifications`, `prices`.
- 123 unit tests, 9 e2e tests (real Claude Code in tmux, mocked API), real captures in `docs/`, theme-builder skill, design artboards.
