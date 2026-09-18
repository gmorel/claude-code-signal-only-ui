// Records an animated demo of the mod in a real Claude Code session and saves
// an asciicast and a GIF for the README.
//
// The pipeline is: aimock answers scripted prompts → a real `claude` in a
// detached tmux pane → `asciinema` records a client attached to that pane →
// `agg` renders the cast to a GIF. Nothing is drawn by hand: what lands in
// docs/ is what the terminal showed.
//
// The recording never touches the reader's own ~/.claude: it runs under the
// mirror's throwaway CLAUDE_CONFIG_DIR, exactly as the e2e suite does.
//
//   node scripts/demo.mjs                  full tour, into docs/
//   node scripts/demo.mjs --theme gmorel   one theme only
//   node scripts/demo.mjs --cast-only      skip the GIF
//   node scripts/demo.mjs --out /tmp/demo  somewhere else

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)

const argv = process.argv.slice(2)
const flag = name => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const hasFlag = name => argv.includes(`--${name}`)

const THEMES = ['receipt', 'kanban', 'gmorel']
const COLUMNS = 100
// 32 = tallest tour card (kanban plain, 24 rows) + prompt echo + footer/composer/hint (~6).
const ROWS = 32
const ATTACH_SETTLE = 400
const BEAT = 2_000
const CARD_BEAT = 3_000
const TURN_MS = 60_000

const PROMPT_MARKER = 'demo marker token'
const PROMPT_DECISION = 'demo decision token'

/** one 🟢 item carries continuation lines so gmorel draws + summary and + detail */
const MARKER_CARD = `> **👉 For you**
> 🟢 **README demo records a real Claude Code session — API mocked, not a mock-up.**
> 🟢 Plugin loads from the $TMPDIR mirror; throwaway CLAUDE_CONFIG_DIR, same as e2e.
> The mirror re-execs demo.mjs so node_modules never lands next to the source.
> aimock answers scripted prompts; asciinema attaches to the harness tmux pane.
> Same pattern as capture.mjs: install once in scratch, write artifacts back to docs/.
> 🟢 Unit suite covers parser, folding, themes and pricing — no runtime deps.
> 🟢 Eight e2e tests in tmux; E2E_CLICK proves fold buttons under fullscreen renderer.
> ⚠️ Regenerate docs/demo.gif after any hooks/ change — a stale GIF misleads readers.
> ▫️ npm run demo needs asciinema, agg and tmux on PATH.
> ℹ️ The recording never opens your ~/.claude.
> ℹ️ Only gmorel draws per-item + summary and + detail fold rows.`

const DECISION_CARD = `> **👉 For you**
> 🟡 **Decide: A, B or C? How should the README demo stay honest once hooks/ change. A = hand-drawn GIF. B = record real sessions. C = ship both. If you say nothing: B**
> ▫️ A — hand-drawn GIF. ~2h. Risk: high.
> ▫️ B — record real sessions. ≈ 45 min. Risk: low. Cost: ~$1.
> ▫️ C — ship both. 1 day. Risk: medium.
> 🟢 204/204 unit tests pass.
> ⚠️ The README demo will lie without re-running npm run demo after hooks/ edits.`

// ---------------------------------------------------------------- preflight

const onPath = name => spawnSync('which', [name], { encoding: 'utf8' }).status === 0
if (process.env.SOU_DEMO_IN_MIRROR !== '1') {
  for (const [tool, install] of [
    ['asciinema', 'brew install asciinema'],
    ['agg', 'brew install agg'],
    ['tmux', 'brew install tmux'],
    ['bun', 'brew install oven-sh/bun/bun'],
  ]) {
    if (!onPath(tool)) {
      console.error(`${tool} is required to record the demo — ${install}`)
      process.exit(1)
    }
  }
}

// A throwaway tmux server started from a non-interactive runner often inherits
// TERM=dumb; without FORCE_COLOR, Claude Code paints monochrome on that socket.
// Without a UTF-8 locale (LC_CTYPE=C is common), Claude Code draws the card in
// ASCII and the recording loses ✻, ☑, ⚠, ≈ and ←.
process.env.FORCE_COLOR = '3'
process.env.LANG = 'en_US.UTF-8'
process.env.LC_ALL = 'en_US.UTF-8'
if (!process.env.TERM || process.env.TERM === 'dumb') process.env.TERM = 'xterm-256color'

// ---------------------------------------------------------------- the mirror

if (process.env.SOU_DEMO_IN_MIRROR !== '1') {
  const mirror = execFileSync('bash', [join(HERE, 'e2e.sh'), '--prepare'], { encoding: 'utf8' }).trim()
  const out = resolve(flag('out') ?? join(REPO, 'docs'))
  console.error(`mirror  ${mirror}`)
  console.error(`out     ${out}`)
  const run = spawnSync('bun', [join(mirror, 'scripts', 'demo.mjs'), ...argv, '--out', out], {
    stdio: 'inherit',
    env: { ...process.env, SOU_DEMO_IN_MIRROR: '1', CLAUDE_CONFIG_DIR: join(mirror, 'e2e-config') },
  })
  process.exit(run.status ?? 1)
}

const { startSession } = await import(join(REPO, 'tests', 'e2e', 'harness.ts'))

const OUT = resolve(flag('out') ?? join(REPO, 'docs'))
const THEME = flag('theme') ?? 'gmorel'
const CAST_ONLY = hasFlag('cast-only')
const TOUR = !flag('theme')

if (!THEMES.includes(THEME)) throw new Error(`no theme ${THEME} · ${THEMES.join(', ')}`)

mkdirSync(OUT, { recursive: true })

const demoDir = mkdtempSync(join(tmpdir(), 'sou-demo-'))
const tmuxSocket = `sou-demo-${process.pid}`
const tmuxConfig = join(demoDir, 'tmux.conf')
writeFileSync(
  tmuxConfig,
  [
    'set -g default-terminal "tmux-256color"',
    'set -as terminal-features ",*:RGB"',
    'set -g focus-events on',
    'set -g mouse on',
    'set -g status off',
  ].join('\n') + '\n',
)
const tmux = (...args) => execFileSync('tmux', ['-L', tmuxSocket, ...args], { encoding: 'utf8' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

const clearScreen = async session => {
  session.send('/clear')
  await session.waitFor(/^❯\s*$/m, TURN_MS)
  tmux('clear-history', '-t', session.name)
  session.keys('C-l')
  await sleep(500)
}

const prime = async (session, theme) => {
  for (const [args, answer] of [
    [`theme ${theme}`, `signal: theme ${theme} ·`],
    ['fold on', 'signal: fold on ·'],
    ['observer on', 'signal: observer on ·'],
  ]) {
    session.send(`/signal ${args}`)
    await session.waitFor(answer, TURN_MS)
  }
  await clearScreen(session)
  await session.type(PROMPT_MARKER)
  await session.waitFor(PROMPT_MARKER, TURN_MS)
}

const clickShow = async (session, label = 'show') => {
  for (let waited = 0; waited < 5_000; waited += 1_000) {
    if (await session.click(label)) return
    await sleep(1_000)
  }
  throw new Error(`no [ ${label} ] button on screen:\n${session.screen()}`)
}

const fixtures = [
  { prompt: PROMPT_MARKER, reply: MARKER_CARD },
  { prompt: PROMPT_DECISION, reply: DECISION_CARD },
]

const session = await startSession(fixtures, {
  columns: COLUMNS,
  rows: ROWS,
  fullscreen: true,
  debug: false,
  tmuxSocket,
  tmuxConfig,
})
await prime(session, THEME)

const castPath = join(OUT, 'demo.cast')
const gifPath = join(OUT, 'demo.gif')

const recorder = spawn(
  'asciinema',
  [
    'rec',
    '--overwrite',
    '-f',
    'asciicast-v2',
    '--headless',
    '-q',
    '--window-size',
    `${COLUMNS}x${ROWS}`,
    '--idle-time-limit',
    '3',
    '-c',
    `tmux -L ${tmuxSocket} -u attach -t ${session.name}`,
    castPath,
  ],
  { env: { ...process.env, TERM: 'xterm-256color' }, stdio: 'pipe' },
)

// let the attach settle — not long enough to fill the GIF's first frame
await sleep(ATTACH_SETTLE)

try {
  session.keys('Enter')
  await session.waitFor('2 skippable details hidden', TURN_MS)
  await sleep(CARD_BEAT)

  if (THEME === 'gmorel') {
    await clickShow(session)
    await sleep(BEAT)
    await clickShow(session)
    await session.waitFor('aimock answers scripted prompts', TURN_MS)
    await sleep(CARD_BEAT)
  } else {
    console.error(`note    only gmorel draws per-item + summary / + detail folds — step skipped for ${THEME}`)
  }

  session.send(PROMPT_DECISION)
  // gmorel marks the recommended option with a rule and the dim word `default`, not a badge
  await session.waitFor('▌', TURN_MS)
  await sleep(CARD_BEAT)

  if (TOUR) {
    for (const id of ['receipt', 'kanban', 'gmorel']) {
      session.send(`/signal theme ${id}`)
      await session.waitFor(`signal: theme ${id} ·`, TURN_MS)

      await clearScreen(session)
      session.send(PROMPT_MARKER)
      await session.waitFor(/README demo records a real Claude Code session/i, TURN_MS)
      await sleep(CARD_BEAT)

      await clearScreen(session)
      session.send(PROMPT_DECISION)
      await session.waitFor(/how should the README demo stay honest/i, TURN_MS)
      await sleep(CARD_BEAT)
    }
  }
} finally {
  await session.stop()
  rmSync(demoDir, { recursive: true, force: true })
}

const recorderDeadline = Date.now() + 30_000
while (recorder.exitCode === null && Date.now() < recorderDeadline) {
  await sleep(250)
}
if (recorder.exitCode === null) {
  recorder.kill('SIGKILL')
  throw new Error('asciinema did not exit within 30s after the tmux session ended')
}
if (recorder.exitCode !== 0) {
  const err = recorder.stderr?.read?.()?.toString() ?? ''
  throw new Error(`asciinema exited ${recorder.exitCode}${err ? ` · ${err}` : ''}`)
}

const castRaw = readFileSync(castPath, 'utf8')
const castLines = castRaw.split('\n')
const headerLine = castLines[0]
const castVersion = JSON.parse(headerLine)
if (castVersion.version !== 2) throw new Error(`demo.cast is not asciicast v2 (got ${castVersion.version})`)

const parseCastEvents = lines =>
  lines
    .slice(1)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)

const castEvents = parseCastEvents(castLines)

const PROMPT_ON_SCREEN = new RegExp(`❯[\\s\\u00a0]+${PROMPT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)

const ESC = '\x1b'
const hasTeardownEscapes = data =>
  typeof data === 'string' && (data.includes(`${ESC}[2J`) || data.includes(`${ESC}[?1049l`))

const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const stripCharsetSelect = s => s.replace(/\x1b\([0-9A-Za-z]/g, '')

const promptOnScreen = data => {
  if (typeof data !== 'string' || !data.includes(PROMPT_MARKER)) return false
  const tail = stripAnsi(data).split(/\r?\n/).slice(-5).join('\n')
  return PROMPT_ON_SCREEN.test(tail)
}

const trimCastLeadingDeadAir = () => {
  const first = castEvents.findIndex(([, , data]) => promptOnScreen(data))
  if (first < 0) return

  const leading = castEvents.slice(0, first).map(([, , data]) => (typeof data === 'string' ? data : '')).join('')
  const [tFirst, kindFirst, dataFirst] = castEvents[first]
  const shift = -tFirst
  const trimmed = [
    [0, kindFirst, leading + (typeof dataFirst === 'string' ? dataFirst : '')],
    ...castEvents.slice(first + 1).map(([t, kind, data]) => [t + shift, kind, data]),
  ]
  writeFileSync(castPath, [headerLine, ...trimmed.map(ev => JSON.stringify(ev))].join('\n') + '\n')
  castEvents.length = 0
  castEvents.push(...trimmed)
}

trimCastLeadingDeadAir()

// Teardown spills across several trailing events: clear-screen escapes, then [exited], then exit code.
const isTrailingTeardown = data => {
  if (hasTeardownEscapes(data)) return true
  if (typeof data === 'string' && data.includes('[exited]')) return true
  const plain = stripAnsi(typeof data === 'string' ? data : '').trim()
  return plain === '' || /^[0-9]+$/.test(plain)
}

const trimCastTrailingTeardown = () => {
  let end = castEvents.length
  while (end > 0 && isTrailingTeardown(castEvents[end - 1][2])) end--
  if (end === 0) {
    throw new Error(
      'demo.cast is nothing but session teardown — trimCastTrailingTeardown() dropped every event. ' +
        'Re-run the recording.',
    )
  }

  const trimmed = castEvents.slice(0, end)
  const lastKeptTime = trimmed[trimmed.length - 1][0]
  trimmed.push([lastKeptTime + 2.0, 'o', ''])
  writeFileSync(castPath, [headerLine, ...trimmed.map(ev => JSON.stringify(ev))].join('\n') + '\n')
  castEvents.length = 0
  castEvents.push(...trimmed)
}

trimCastTrailingTeardown()

// The recording runs out of a mirror under $TMPDIR, so the pane prints this machine's own
// temp path. That path is per user and per machine: it must not reach a published cast.
const scrubCastMachinePaths = () => {
  const raw = readFileSync(castPath, 'utf8')
  const clean = raw
    .replace(/\/(?:private\/)?var\/folders\/[A-Za-z0-9+]+\/[A-Za-z0-9+]+\/T/g, '/tmp')
    .replace(/\/private\/tmp\/claude-[0-9]+\/[^\s"'\\]*/g, '/tmp')
  if (clean !== raw) writeFileSync(castPath, clean)
  const leaks = clean.match(/\/var\/folders\/[A-Za-z0-9+]+|\/Users\/[A-Za-z0-9._-]+/g)
  if (leaks) {
    throw new Error(
      `demo.cast still carries a machine path (${[...new Set(leaks)].slice(0, 3).join(', ')}). ` +
        'Widen scrubCastMachinePaths() in scripts/demo.mjs before publishing this recording.',
    )
  }
  castEvents.length = 0
  castEvents.push(...clean.split('\n').slice(1).filter(Boolean).map(line => JSON.parse(line)))
}

scrubCastMachinePaths()

const [, , lastContentData] = castEvents[castEvents.length - 2]
if (hasTeardownEscapes(lastContentData)) {
  throw new Error(
    'demo.cast still ends on session teardown — the last content event carries ESC[2J or ESC[?1049l. ' +
      'Check trimCastTrailingTeardown() in scripts/demo.mjs before re-running.',
  )
}

const castOutput = castEvents.flatMap(([, , data]) => (typeof data === 'string' ? [data] : [])).join('')

const bgEscapes = castOutput.match(/\x1b\[(?:48;[25];[0-9;:]+m|4[0-7]m|10[0-7]m)/g)?.length ?? 0
if (bgEscapes === 0) {
  throw new Error(
    'demo.cast came out monochrome — zero background-colour escapes in the recording. ' +
      'Check the demo tmux config (default-terminal, terminal-features RGB) before re-running.',
  )
}

if (castOutput.includes('~/.tmux.conf')) {
  const tip = castOutput.match(/[^\n]*~\/\.tmux\.conf[^\n]*/)?.[0]?.trim() ?? 'tmux ~/.tmux.conf tip'
  throw new Error(
    `demo.cast still carries a tmux tip (${tip}) — Claude Code noticed a tmux option the demo server lacks. ` +
      'Silence it in the throwaway tmux config scripts/demo.mjs writes before re-running.',
  )
}

const earlyLimit = Math.max(1, Math.ceil(castEvents.length * 0.1))
const earlyOutput = castEvents
  .slice(0, earlyLimit)
  .flatMap(([, , data]) => (typeof data === 'string' ? [data] : []))
  .join('')
if (!earlyOutput.includes(PROMPT_MARKER)) {
  throw new Error(
    'demo.cast opens on dead air — the first prompt does not appear in the first 10% of events. ' +
      'Check the trim step in scripts/demo.mjs before re-running.',
  )
}

if (castOutput.includes('[exited]')) {
  throw new Error(
    'demo.cast still ends on session teardown — [exited] is in the recording. ' +
      'Check trimCastTrailingTeardown() in scripts/demo.mjs before re-running.',
  )
}

const castPlain = stripCharsetSelect(stripAnsi(castOutput))
if (
  !/\bDONE\b/.test(castPlain) ||
  !/\bNOTES\b/.test(castPlain) ||
  !/TO READ\b/.test(castPlain)
) {
  throw new Error(
    'demo.cast never recorded the kanban plain card — DONE · and NOTES · are missing. ' +
      'Check the theme tour in scripts/demo.mjs: it must draw the marker card as well as the decision card for every theme.',
  )
}

const checkedGlyphCount = (castPlain.match(/☑/g) ?? []).length
const warnGlyphCount = (castPlain.match(/⚠/g) ?? []).length
if (checkedGlyphCount === 0 || warnGlyphCount === 0) {
  throw new Error(
    'demo.cast came out in ASCII — ☑ and ⚠ glyphs are missing from the recording. ' +
      'The tmux server needs a UTF-8 LANG/LC_ALL; check the top of scripts/demo.mjs before re-running.',
  )
}

/** share of frame pixels in the most common RGB triple — blank ≈ 1, content ≪ 1 */
const gifFrameDominantShare = (gif, frameIndex) => {
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', gif],
    { encoding: 'utf8' },
  )
  if (probe.status !== 0) throw new Error(probe.stderr || `ffprobe failed on ${gif}`)
  const [width, height] = probe.stdout.trim().split('x').map(Number)
  const raw = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      gif,
      '-vf',
      `select=eq(n\\,${frameIndex})`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: width * height * 3 + 1024 },
  )
  if (raw.status !== 0) throw new Error(raw.stderr?.toString() || `ffmpeg failed on ${gif}`)
  const buf = raw.stdout
  const counts = new Map()
  for (let i = 0; i < buf.length; i += 3) {
    const key = `${buf[i]},${buf[i + 1]},${buf[i + 2]}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best = 0
  for (const n of counts.values()) if (n > best) best = n
  return best / (buf.length / 3)
}

const gifFrameCount = gif => {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'default=nw=1:nk=1',
      gif,
    ],
    { encoding: 'utf8' },
  )
  if (probe.status !== 0) throw new Error(probe.stderr || `ffprobe failed on ${gif}`)
  const n = Number(probe.stdout.trim())
  if (!Number.isFinite(n) || n < 1) throw new Error(`ffprobe reported no frames in ${gif}`)
  return n
}

const gifDurationSecs = gif => {
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', gif],
    { encoding: 'utf8' },
  )
  if (probe.status !== 0) throw new Error(probe.stderr || `ffprobe failed on ${gif}`)
  const n = Number(probe.stdout.trim())
  if (!Number.isFinite(n) || n <= 0) throw new Error(`ffprobe reported no duration in ${gif}`)
  return n
}

if (!CAST_ONLY) {
  // Hold comes from the appended no-op (+2.0 s in the cast); agg 1.9.0 accepts 0 here.
  const agg = spawnSync(
    'agg',
    ['--font-size', '20', '--idle-time-limit', '3', '--last-frame-duration', '0', castPath, gifPath],
    { encoding: 'utf8' },
  )
  if (agg.status !== 0) throw new Error(agg.stderr || agg.stdout || `agg exited ${agg.status}`)

  // Calibrated to ROWS — re-measure whenever ROWS moves. At 44 rows the prompt-on-composer
  // opening measured 0.9962; 38 rows measured 0.9952; 32 rows sits below that, so 0.997 still holds.
  const GIF_FRAME_DOMINANT_MAX = 0.997
  // gmorel decision card measured 0.8838; blank terminal measured 0.9978 — informational only
  const GIF_LAST_FRAME_DOMINANT_NOTE = 0.95
  const frame1Share = gifFrameDominantShare(gifPath, 0)
  const lastFrameIndex = gifFrameCount(gifPath) - 1
  const lastFrameShare = gifFrameDominantShare(gifPath, lastFrameIndex)
  const frameCount = lastFrameIndex + 1
  const durationSecs = gifDurationSecs(gifPath)
  console.log(`gif frames                         ${frameCount}`)
  console.log(`gif duration                       ${durationSecs.toFixed(2)}s`)
  console.log(`gif frame1 dominant colour share   ${frame1Share.toFixed(4)} (max ${GIF_FRAME_DOMINANT_MAX})`)
  console.log(
    `gif last frame dominant colour share ${lastFrameShare.toFixed(4)} (card ≪ ${GIF_LAST_FRAME_DOMINANT_NOTE})`,
  )
  if (frame1Share > GIF_FRAME_DOMINANT_MAX) {
    throw new Error(
      'demo.gif opens on a blank terminal — frame 1 is overwhelmingly one colour. ' +
        'Check prime() in scripts/demo.mjs (type the first prompt before asciinema attaches) before re-running.',
    )
  }
}

console.log(`demo.cast  ${statSync(castPath).size} bytes`)
console.log(`demo.cast ☑                         ${checkedGlyphCount}`)
console.log(`demo.cast ⚠                         ${warnGlyphCount}`)
console.log(`demo.cast last timestamp  ${castEvents[castEvents.length - 1][0]}`)
if (!CAST_ONLY && existsSync(gifPath)) console.log(`demo.gif   ${statSync(gifPath).size} bytes`)
