---
name: demo-sync
description: Re-record the README animated demo after hooks/ changes and confirm the GIF still shows all four themes and both per-item folds. Use when someone edits hooks/, says "refresh the demo", "demo is stale", "re-record demo.gif", "sync the README demo", or before pushing a hooks/ change that should land with an up-to-date docs/demo.gif.
---

# Demo sync

`npm run demo` records a real Claude Code session (API mocked) into `docs/demo.cast` and `docs/demo.gif`. A recording that ran is not a recording that is right — look at the GIF before you commit.

## 1. Record

```sh
npm run demo
```

Needs `asciinema`, `agg` and `tmux` on PATH (same preflight as the script).

## 2. Look

Open `docs/demo.gif` and confirm, by eye:

- all three themes appear in the tour (`receipt`, `kanban`, `gmorel`)
- both per-item folds are visible (`+ summary` opened, then `+ detail`)

If a fold or a theme is missing, fix `hooks/` or `scripts/demo.mjs` and record again.

## 3. Staleness

The demo must be newer than every file under `hooks/`:

```sh
stale=$(find hooks -type f -newer docs/demo.gif 2>/dev/null); if [ ! -f docs/demo.gif ]; then echo 'docs/demo.gif missing — run npm run demo'; elif [ -n "$stale" ]; then echo 'demo is stale:'; echo "$stale"; else echo 'demo is fresh'; fi
```

When `docs/demo.gif` does not exist, the one-liner says so. When the list is not empty, the demo is stale.
