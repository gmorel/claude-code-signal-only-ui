// Draws each theme in a real Claude Code, in a real terminal, and saves the
// screen as a PNG for the README.
//
// The pipeline is: aimock answers two scripted prompts (marker card, question card) →
// a tmux pane 100 columns wide runs `claude --plugin-dir .` → `capture-pane -e`
// reads the screen with its SGR codes → the codes become HTML on a dark ground
// → headless Chrome shoots it. No image is drawn by hand: what lands in docs/
// is what the terminal showed.
//
// It runs from the same scratch mirror as the e2e suite, because it needs the
// same node_modules and the same throwaway CLAUDE_CONFIG_DIR — a node_modules
// directory next to the plugin changes what --plugin-dir loads. Called from the
// repository it re-execs itself there and writes the PNGs back here.
//
//   node scripts/capture.mjs                  every theme, into docs/
//   node scripts/capture.mjs --theme receipt  just one
//   node scripts/capture.mjs --out /tmp/shots somewhere else

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)

const argv = process.argv.slice(2)
const flag = name => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const chromePath = () => {
  const fromEnv = process.env.CHROME || process.env.PUPPETEER_EXECUTABLE_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (existsSync(mac)) return mac
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' }).stdout?.trim().split('\n')[0]
    if (found) return found
  }
  throw new Error('no Chrome/Chromium found — set CHROME or PUPPETEER_EXECUTABLE_PATH')
}
// 100 columns for every theme, because that is the width the README claims.
// Rows are not part of that claim and only have to be enough for the whole card
// to stand on one screen: `kanban` stacks its three columns at this width and is
// three times the height of the others.
const COLUMNS = 100
const PROMPT_MARKER = 'card capture token'
const PROMPT_QUESTION = 'card question token'
const FOOTER_DONE = /·\s*done\s+\d{1,2}:\d{2}/
const BG_SGR = /\x1b\[(?:48;[25];[0-9;:]+m|4[0-7]m|10[0-7]m)/

/** pane height per theme — only rows differ; card bounds come from the composer echo and the footer */
const THEMES = {
  receipt: { rows: 44 },
  kanban: { rows: 80 },
  gmorel: { rows: 48 },
}

// ---------------------------------------------------------------- the mirror

// Same rule as the e2e suite: the repository folder is the real Mac filesystem
// and never grows a node_modules, so the work happens in $TMPDIR.
if (process.env.SOU_CAPTURE_IN_MIRROR !== '1') {
  const mirror = execFileSync('bash', [join(HERE, 'e2e.sh'), '--prepare'], { encoding: 'utf8' }).trim()
  const out = resolve(flag('out') ?? join(REPO, 'docs'))
  console.error(`mirror  ${mirror}`)
  console.error(`out     ${out}`)
  const run = spawnSync('node', [join(mirror, 'scripts', 'capture.mjs'), ...argv, '--out', out], {
    stdio: 'inherit',
    env: { ...process.env, SOU_CAPTURE_IN_MIRROR: '1', CLAUDE_CONFIG_DIR: join(mirror, 'e2e-config') },
  })
  process.exit(run.status ?? 1)
}

const { LLMock } = await import('@copilotkit/aimock')

const OUT = resolve(flag('out') ?? join(REPO, 'docs'))
const WANTED = flag('theme') ? [flag('theme')] : Object.keys(THEMES)
const MARKER_CARD = readFileSync(join(REPO, 'tests', 'e2e', 'marker-card.txt'), 'utf8').trimEnd()
const QUESTION_CARD = readFileSync(join(REPO, 'tests', 'e2e', 'question-card.txt'), 'utf8').trimEnd()

// ------------------------------------------------------------------- the pane

const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const stripAnsi = text => text.replace(/\x1b\[[0-9;:?]*[a-zA-Z]/g, '').replace(/\u00a0/g, ' ')

const claudeBin = () => spawnSync('which', ['claude'], { encoding: 'utf8' }).stdout?.trim().split('\n')[0] || 'claude'

/**
 * One mock for the whole run. Stopping it between themes would hang: an
 * interactive `claude` holds its HTTP connection open, and a Node server's
 * close() waits for the last socket.
 */
const mock = new LLMock({ port: 0 })
mock.on({ userMessage: PROMPT_MARKER }, { content: MARKER_CARD })
mock.on({ userMessage: PROMPT_QUESTION }, { content: QUESTION_CARD })
await mock.start()

const startPane = async rows => {
  const name = `signal-capture-${process.pid}-${Date.now().toString(36)}`
  const debugDir = mkdtempSync(join(tmpdir(), 'signal-capture-'))
  const env = [
    `CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR}`,
    `ANTHROPIC_BASE_URL=${mock.url}`,
    'ANTHROPIC_API_KEY=mock',
    'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'DISABLE_AUTOUPDATER=1',
    'CLAUDE_CODE_NO_FLICKER=0',
  ].join(' ')
  tmux(
    'new-session', '-d', '-s', name,
    '-x', String(COLUMNS), '-y', String(rows), '-c', REPO,
    `${env} ${claudeBin()} --plugin-dir ${REPO} --model claude-sonnet-5 --debug-file ${join(debugDir, 'debug.log')}`,
  )

  const screen = (color = false) => tmux('capture-pane', '-t', name, '-p', ...(color ? ['-e'] : []))
  const waitFor = async (needle, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const plain = stripAnsi(screen())
      if (typeof needle === 'string' ? plain.includes(needle) : needle.test(plain)) return
      await sleep(250)
    }
    throw new Error(`waited ${timeoutMs}ms for ${needle} · screen:\n${screen()}`)
  }
  const send = text => {
    tmux('send-keys', '-t', name, '-l', text)
    spawnSync('sleep', ['0.15'])
    tmux('send-keys', '-t', name, 'Enter')
  }
  const stop = () => {
    try {
      tmux('kill-session', '-t', name)
    } catch {}
    rmSync(debugDir, { recursive: true, force: true })
  }

  // the composer's empty prompt marks a ready session
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !/^❯\s*$/m.test(stripAnsi(screen()))) await sleep(250)
  const clearScreen = async () => {
    send('/clear')
    await waitFor(/^❯\s*$/m)
  }

  return { screen, waitFor, send, clearScreen, stop }
}

// ------------------------------------------------------- SGR text to HTML

// A dark terminal's sixteen, plus the xterm cube: tmux -e writes whichever the
// pane's palette resolved to, so both have to be read.
const NAMED = [
  '#1c2530', '#e5534b', '#3fb950', '#d2a24c', '#4c8eda', '#bc8cff', '#39c5cf', '#b1bac4',
  '#6e7681', '#ff7b72', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc',
]
const GROUND = '#0F1620'
const INK = '#d5dee8'

const hex = n => n.toString(16).padStart(2, '0')

const xterm = index => {
  if (index < 16) return NAMED[index]
  if (index < 232) {
    const i = index - 16
    const step = v => (v === 0 ? 0 : 55 + v * 40)
    return `#${hex(step(Math.floor(i / 36)))}${hex(step(Math.floor(i / 6) % 6))}${hex(step(i % 6))}`
  }
  const grey = 8 + (index - 232) * 10
  return `#${hex(grey)}${hex(grey)}${hex(grey)}`
}

const blank = () => ({ fg: null, bg: null, bold: false, dim: false, underline: false, inverse: false, italic: false })

/** one SGR parameter list applied to the running style */
const apply = (style, params) => {
  for (let i = 0; i < params.length; i++) {
    const n = params[i]
    if (n === 0) Object.assign(style, blank())
    else if (n === 1) style.bold = true
    else if (n === 2) style.dim = true
    else if (n === 3) style.italic = true
    else if (n === 4) style.underline = true
    else if (n === 7) style.inverse = true
    else if (n === 22) (style.bold = false), (style.dim = false)
    else if (n === 23) style.italic = false
    else if (n === 24) style.underline = false
    else if (n === 27) style.inverse = false
    else if (n >= 30 && n <= 37) style.fg = NAMED[n - 30]
    else if (n === 39) style.fg = null
    else if (n >= 40 && n <= 47) style.bg = NAMED[n - 40]
    else if (n === 49) style.bg = null
    else if (n >= 90 && n <= 97) style.fg = NAMED[n - 90 + 8]
    else if (n >= 100 && n <= 107) style.bg = NAMED[n - 100 + 8]
    else if (n === 38 || n === 48) {
      const key = n === 38 ? 'fg' : 'bg'
      if (params[i + 1] === 5) (style[key] = xterm(params[i + 2] ?? 0)), (i += 2)
      else if (params[i + 1] === 2) (style[key] = `#${hex(params[i + 2] ?? 0)}${hex(params[i + 3] ?? 0)}${hex(params[i + 4] ?? 0)}`), (i += 4)
    }
  }
  return style
}

const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** two hex colours, `t` of the way from the first to the second */
const mix = (from, to, t) => {
  const part = (hex, at) => parseInt(hex.slice(at, at + 2), 16)
  const blend = at => hex(Math.round(part(from, at) * (1 - t) + part(to, at) * t))
  return `#${blend(1)}${blend(3)}${blend(5)}`
}

const css = style => {
  // inverse swaps the two, which is how the receipt header is drawn
  let fg = style.inverse ? (style.bg ?? GROUND) : (style.fg ?? INK)
  const bg = style.inverse ? (style.fg ?? INK) : style.bg
  // dim fades the ink toward whatever is behind it; an opacity on the span
  // would fade the band's background with it and a filled band would go grey
  if (style.dim) fg = mix(fg, bg ?? GROUND, 0.42)
  const rules = [`color:${fg}`]
  if (bg) rules.push(`background:${bg}`)
  if (style.bold) rules.push('font-weight:700')
  if (style.italic) rules.push('font-style:italic')
  if (style.underline) rules.push('text-decoration:underline')
  return rules.join(';')
}

/**
 * One captured line to HTML. tmux writes a line's attributes on that line, so
 * the style starts clean on each: carrying it over would paint a whole capture
 * in the colour of whatever the trim cut off above it.
 */
const lineToHtml = line => {
  const style = blank()
  let html = ''
  let i = 0
  while (i < line.length) {
    const esc = line.indexOf('\x1b[', i)
    if (esc < 0) {
      html += `<span style="${css(style)}">${escape(line.slice(i))}</span>`
      break
    }
    if (esc > i) html += `<span style="${css(style)}">${escape(line.slice(i, esc))}</span>`
    const end = line.indexOf('m', esc)
    if (end < 0) break
    const params = line
      .slice(esc + 2, end)
      .split(';')
      .map(part => (part === '' ? 0 : Number(part.split(':')[0])))
      .filter(n => Number.isFinite(n))
    apply(style, params)
    i = end + 1
  }
  return html || '<span></span>'
}

const page = (lines, columns) => `<!doctype html>
<meta charset="utf-8">
<title>signal-only-ui capture</title>
<style>
  html, body { margin: 0; background: ${GROUND}; }
  pre {
    margin: 0; padding: 16px;
    font: 14px/20px "IBM Plex Mono", Menlo, "DejaVu Sans Mono", monospace;
    color: ${INK}; background: ${GROUND};
    width: ${columns}ch; white-space: pre; tab-size: 8;
  }
  span { white-space: pre; }
</style>
<pre>${lines.map(lineToHtml).join('\n')}</pre>
`

// ------------------------------------------------------------------ the shot

/** Menlo and IBM Plex Mono both advance 0.6em, so 14px text is 8.4px a column. */
const CELL = 8.4
const LINE = 20
const PAD = 16

/**
 * Chrome 152's `--headless=new --screenshot` writes the PNG and then does not
 * exit on this machine, so the file is the signal: once it has stopped growing
 * the shot is taken and the process is killed. Waiting on the exit code would
 * hang the run for ever.
 */
const shoot = async (html, out, columns, rows) => {
  const work = mkdtempSync(join(tmpdir(), 'signal-shot-'))
  const file = join(work, 'card.html')
  writeFileSync(file, html)
  rmSync(out, { force: true })
  const width = Math.ceil(columns * CELL) + PAD * 2
  const height = rows * LINE + PAD * 2
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      // a profile of its own: a capture must never touch the reader's Chrome
      `--user-data-dir=${join(work, 'profile')}`,
      // twice the pixels, so the README image survives a retina screen
      '--force-device-scale-factor=2',
      // render, do not wait for a page that never settles
      '--virtual-time-budget=2000',
      `--screenshot=${out}`,
      `--window-size=${width},${height}`,
      `file://${file}`,
    ],
    { stdio: 'ignore' },
  )
  const deadline = Date.now() + 45_000
  let previous = -1
  let done = false
  while (!done && Date.now() < deadline) {
    await sleep(300)
    if (!existsSync(out)) continue
    const size = statSync(out).size
    done = size > 0 && size === previous
    previous = size
  }
  chrome.kill('SIGKILL')
  rmSync(work, { recursive: true, force: true })
  if (!done) throw new Error(`chrome drew nothing in 45s for ${out}`)
  return { width, height }
}

// -------------------------------------------------------------------- the run

const CHROME = chromePath()
mkdirSync(OUT, { recursive: true })

for (const id of WANTED) {
  const theme = THEMES[id]
  if (!theme) throw new Error(`no theme ${id} · ${Object.keys(THEMES).join(', ')}`)
  const pane = await startPane(theme.rows)
  try {
    // the preferences outlive a session, so this one says what it wants
    for (const [args, answer] of [
      [`theme ${id}`, `signal: theme ${id} ·`],
      ['fold on', 'signal: fold on ·'],
      ['observer on', 'signal: observer on ·'],
    ]) {
      pane.send(`/signal ${args}`)
      await pane.waitFor(answer)
    }
    const composerLine = prompt =>
      new RegExp(`❯[\\s\\u00a0]+${prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)

    const take = prompt => {
      const coloured = pane.screen(true).split('\n')
      const plain = coloured.map(stripAnsi)
      const footerIndex = plain.findIndex(line => FOOTER_DONE.test(line))
      if (footerIndex < 0) throw new Error(`${id}: no turn footer on screen:\n${plain.join('\n')}`)
      const composerIndex = plain.findIndex(line => composerLine(prompt).test(line))
      if (composerIndex < 0) throw new Error(`${id}: no composer line on screen:\n${plain.join('\n')}`)
      let from = composerIndex + 1
      while (from < footerIndex && plain[from].trim() === '') from++
      if (from >= footerIndex) throw new Error(`${id}: no card between composer and the footer:\n${plain.join('\n')}`)
      const cardLine = i => plain[i].trim() !== '' || BG_SGR.test(coloured[i])
      let to = footerIndex - 1
      while (to > from && !cardLine(to)) to--
      if (to < from) throw new Error(`${id}: no card between composer and the footer:\n${plain.join('\n')}`)
      return coloured.slice(from, to + 1)
    }

    const shootCard = async (prompt, outName) => {
      await pane.clearScreen()
      pane.send(prompt)
      await pane.waitFor(FOOTER_DONE)
      await sleep(700)
      const lines = take(prompt)
      const { width, height } = await shoot(page(lines, COLUMNS), join(OUT, outName), COLUMNS, lines.length)
      console.log(`${outName}  ${lines.length} rows  ${width * 2}x${height * 2}px`)
    }

    await shootCard(PROMPT_MARKER, `${id}.png`)
    await shootCard(PROMPT_QUESTION, `${id}-question.png`)
  } finally {
    pane.stop()
  }
}

// the mock holds the last socket the pane just dropped; give close() a moment
// and leave anyway, rather than let the script hang on a dead connection
await Promise.race([mock.stop().catch(() => {}), sleep(2_000)])
process.exit(0)
