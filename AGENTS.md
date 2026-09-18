# Working in this repo as an agent

Keep this file short. The durable knowledge lives in inert Markdown that nothing auto-loads; read what the task needs, nothing more.

- [SPEC.md](SPEC.md) — what the mod does and does not do (§1 is the constitution: the mod never judges content, display only).
- [README.md](README.md) — the public contract: install paths, themes, `/signal` words, options, limits. Every claim in it must match the code.
- [skills/theme-builder/SKILL.md](skills/theme-builder/SKILL.md) — how to design a theme on a canvas and transcribe it into `hooks/themes/<id>.ts`.
- [design/artboards/](design/artboards/) — the source of truth for the look of each theme (`canvas.json` lays them out).
- [CHANGELOG.md](CHANGELOG.md) — one line per user-visible change, newest first; add yours in the same commit.
- `.claude/types/claude-code.d.ts` — the authoritative function-hooks API (git-ignored; regenerate with `/plugin-types` in Claude Code).

Rules that are not obvious from the code:

- `hooks/register.ts` is the only file that may touch `$`; every `$` call must be statically visible (no aliasing) or the engine refuses it at load. Run `claude plugin validate .claude-plugin/plugin.json` after touching it.
- `$` may not be passed into another module: the static scan only sees calls written in `register.ts` itself. A helper module may build the arguments (`hooks/audit.ts` builds the argv and the run options); `register.ts` makes the call.
- Anything that starts a `claude` child must set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=0` in its env. Without that guard the child loads this plugin, whose hook starts another child, and the session spends money until it is killed. The `audit` switch is off by default for the same reason.
- No vector path exists and none should be added back on spec alone: the terminal's element table has no `Svg`, and Desktop builds before Claude Code 2.1.273 run no function hook. The SVG kanban was built, proven with a screenshot, then removed on 2026-09-17 — it is at `297fdbe` if a surface ever appears.
- Themes are pure functions from `CardModel` to a Box/Text/Button/Code tree. Named colours only. Nothing an item said may disappear: fold it, never drop it.
- Tests first: `bun test tests/unit` (no dependencies), then `npm run test:e2e` (real Claude Code in tmux, API mocked, runs from a mirror under `$TMPDIR` — never write `node_modules` next to the source).
- Do not commit generated captures without re-running `npm run capture`; the PNGs in `docs/` must stay real sessions.
- No push without a real card seen in a live terminal session (tmux, or the reader's own terminal) on the commit being pushed; unit and e2e are necessary, not sufficient.
- A running session holds the old code. After editing `hooks/`, reload with `/reload-plugins` (or start a new session) before judging what you see.
