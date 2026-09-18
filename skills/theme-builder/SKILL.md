---
name: theme-builder
description: Design a new signal-only-ui theme from a picture, not from code — open the reply-card artboards in /design, pick or sketch a direction, then turn the chosen artboard into hooks/themes/<id>.ts with its test and registry entry. Use when someone says "new theme", "my own layout", "make the card look like…", "theme builder", or wants to change how Claude's reply card is drawn.
---

# Theme builder

A theme is one TypeScript file: `render(model, ctx) → RenderElement`, built from `ctx.el` (Box, Text, Button, Code). Designing one in code first is the slow way. The fast way is to draw the card, agree on the picture, then transcribe it.

## 1. Draw first

1. Open the gallery: the artboards under `design/artboards/` are `.dc.html` files for the `/design` canvas — the same reply drawn 24 ways (directions A–K, including question-centred K variants). Seed them onto a canvas with `/design` ("seed the artboards in design/artboards as a canvas"), or start a blank canvas and describe the look you want.
2. Every artboard draws the SAME fixture reply: one decision with its default, five done items with proofs, one must-read warning, two notes, one skippable line, a folded narration line. Keep that fixture: it is what `tests/unit/themes.test.ts` renders.
3. Sketch 2–4 directions on different axes (colour carrier, glyph vs label, folding, columns), each with a one-line why and its trade-off in a sticky note. Pick one. Iterate on that artboard until it reads in under three seconds at 520 px wide — the width of a Claude Desktop pane at 40 % of the screen, and roughly 80 terminal columns.

## 2. Transcribe

Name the theme (one lowercase word, the file stem) and create `hooks/themes/<id>.ts`:

```ts
import type { Theme } from '../theme.ts'

export const theme: Theme = {
  id: '<id>',
  name: '<Name>',
  tagline: '<one line for /signal themes and the README>',
  render(model, ctx) {
    const { Box, Text, Button, Code } = ctx.el
    // decide → read → done → info → skip; the verdict bold once; ctx.witness.observerRunning → dim green ✓ on the verdict line
    return Box({ flexDirection: 'column', children: [ /* … */ ] })
  },
}
```

Map the artboard to elements, one CSS idea → one element prop:

| in the artboard | in the theme |
|---|---|
| a coloured background row | `Box({ backgroundColor })` |
| a coloured left bar / gutter | a narrow `Box({ width: 1, backgroundColor })` or a coloured `Text` glyph in the first column |
| bold, dim, inverse text | `Text({ bold })`, `Text({ dimColor })`, `Text({ inverse })` |
| a rounded frame | `Box({ borderStyle: 'round', borderColor })` |
| columns | `Box({ flexDirection: 'row', gap })` — and stack them when `ctx.columns < 100` |
| a button `[ show ]` | `Button({ key, label, onPress: () => ctx.actions.toggle('skip') })` |
| an option chip in the decision | `Button({ key, label: option, onPress: () => ctx.actions.fill(option) })` |
| a fenced block | `Code({ source, language })` |
| gradients, rotation, shadows, animation | not available in a terminal — drop them, or emulate with a tint |

Rules that every theme keeps (they are what the tests check): the order decide → read → done → info → skip; exactly one bold Text (the verdict); folds read from `ctx.state.open` with the theme's own defaults; the witness check only when `ctx.witness.observerRunning`, never drawn as the card's own 🟢; nothing wider than `ctx.columns`; ASCII fallbacks if the theme is meant for fonts without box-drawing glyphs.

## 3. Register and test

1. Add the theme to `hooks/themes/index.ts` (import + one line in the map).
2. Add a `describe('<id>')` block to `tests/unit/themes.test.ts`, reusing the shared fixture and assertions; add one assertion for whatever is specific to this theme.
3. Run `bun test tests/unit` and `bunx -p typescript tsc -p .` from the repo root.
4. Try it live: `claude --plugin-dir .` in a terminal with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, then `/signal theme <id>`; ask Claude anything that produces a card. Edits to `hooks/` hot-reload.
5. Add a line to the README's theme table with a real capture (`tmux capture-pane -p -e` in a 100-column pane, or a Desktop screenshot).

## 4. Share it

A theme is one file plus one test block: open a pull request with those two changes and the README line. Keep the fixture reply unchanged so every theme in the gallery stays comparable.
