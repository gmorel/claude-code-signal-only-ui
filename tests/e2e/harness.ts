import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LLMock } from '@copilotkit/aimock'

// Drives a real interactive Claude Code in a tmux pane, its model answered by
// aimock from fixtures, this plugin loaded with --plugin-dir. Screens are read
// with capture-pane; `-e` keeps the SGR codes so a test can see colour.
// Adapted from galElmalah/claude-mods (claude-mermaid, claude-queue), MIT.
//
// Two things are this repository's own. The session runs under an isolated
// CLAUDE_CONFIG_DIR seeded by scripts/e2e.sh, because the reader's real config
// must never be opened by a test; and `claude` is resolved to an absolute path,
// because a tmux server started long ago carries its own PATH.

/** tests/e2e → tests → the repository root, where hooks/hooks.json lives */
export const REPO = dirname(dirname(import.meta.dir))

/** the model's reply for the card tests and for scripts/capture.mjs — one file, so the two cannot drift */
export const MARKER_CARD = readFileSync(join(import.meta.dir, 'marker-card.txt'), 'utf8').trimEnd()

export type Fixture = {
  prompt: string
  reply: string
  /** a tool the model calls first; `reply` is what it says once the result is back */
  tool?: { name: string; arguments: Record<string, unknown> }
  /** streamed before the tool call, so the block has a tool call after it and becomes narration */
  lead?: string
  /** a further condition on the request `reply` answers: the whole body, whatever its shape */
  when?: (request: unknown) => boolean
}

export type Session = {
  /** the tmux session the pane runs in, for a client that wants to attach */
  name: string
  send: (text: string) => void
  keys: (...keys: string[]) => void
  /** types text one key at a time (a burst reads as a paste) */
  type: (text: string) => Promise<void>
  /** a mouse report at a 1-based terminal cell: `down` and `up` make a click */
  mouse: (kind: 'down' | 'up' | 'drag', column: number, row: number) => Promise<void>
  /** clicks the middle of the first `[ label ]` button on screen; false when no such button is drawn */
  click: (label: string) => Promise<boolean>
  screen: (withColor?: boolean) => string
  /** the plain screen as lines, no SGR, no no-break spaces */
  rows: () => string[]
  waitFor: (pattern: RegExp | string, timeoutMs?: number) => Promise<string>
  waitForGone: (pattern: RegExp | string, timeoutMs?: number) => Promise<string>
  /** Claude Code's --debug-file for the session; gone after `stop` */
  debugLog: string
  stop: () => Promise<void>
}

const tmuxCmd = (socket: string | undefined, args: string[]) =>
  execFileSync('tmux', socket ? ['-L', socket, ...args] : args, { encoding: 'utf8' })

export const hasTmux = () => spawnSync('tmux', ['-V']).status === 0
export const hasClaude = () => spawnSync('claude', ['--version']).status === 0

/** the binary this process would run, spelled out: the tmux server's PATH is not ours */
const claudeBin = () => {
  const found = spawnSync('which', ['claude'], { encoding: 'utf8' })
  const path = found.stdout?.trim().split('\n')[0]
  return path && path.length > 0 ? path : 'claude'
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// patterns read the plain screen; what is returned keeps the colour
const matches = (screen: string, pattern: RegExp | string) => {
  const plain = stripAnsi(screen)
  return typeof pattern === 'string' ? plain.includes(pattern) : pattern.test(plain)
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((block: any) => block?.type === 'text').map((block: any) => block.text ?? '').join('')
      : ''

// Claude Code hands a tool.call hook's `context` to the model as a `system`
// message trailing the tool result, and aimock's Anthropic conversion keeps
// only the user and assistant ones: a fixture's `when` would never see it.
// Folding that text into the tool result it belongs to puts it where the model
// reads it and where a predicate can look.
const foldHookContext = (raw: string) => {
  let body: any
  try {
    body = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!Array.isArray(body?.messages)) return raw
  const messages: any[] = []
  let folded = false
  for (const message of body.messages) {
    const previous = messages[messages.length - 1]
    const result =
      message?.role === 'system' && Array.isArray(previous?.content)
        ? [...previous.content].reverse().find((block: any) => block?.type === 'tool_result')
        : undefined
    if (!result) {
      messages.push(message)
      continue
    }
    const text = textOf(message.content)
    if (Array.isArray(result.content)) result.content.push({ type: 'text', text })
    else result.content = `${textOf(result.content)}\n${text}`
    folded = true
  }
  return folded ? JSON.stringify({ ...body, messages }) : raw
}

/** the mock behind a proxy that folds hook context in on the way through */
const startProxy = async (target: string) => {
  const proxy = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', async () => {
      const sent = Buffer.concat(chunks).toString('utf8')
      const headers = Object.fromEntries(
        Object.entries(request.headers).filter(
          ([key, value]) => typeof value === 'string' && key !== 'content-length' && key !== 'host',
        ),
      ) as Record<string, string>
      try {
        const upstream = await fetch(new URL(request.url ?? '/', target), {
          method: request.method,
          headers,
          body: sent === '' ? undefined : foldHookContext(sent),
        })
        response.writeHead(
          upstream.status,
          Object.fromEntries([...upstream.headers].filter(([key]) => key !== 'content-length' && key !== 'content-encoding')),
        )
        // written chunk by chunk: the mock's pacing is what makes a turn long
        if (upstream.body) for await (const chunk of upstream.body as any) response.write(Buffer.from(chunk))
        response.end()
      } catch {
        response.destroy()
      }
    })
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  return {
    url,
    stop: () =>
      new Promise<void>(resolve => {
        proxy.closeAllConnections?.()
        proxy.close(() => resolve())
      }),
  }
}

export type SessionOptions = {
  columns?: number
  rows?: number
  /** the plugin folder to load; this repository by default (hooks/hooks.json sits at its root) */
  pluginDir?: string
  /** the session's working directory; the repository by default, which the seeded config trusts */
  cwd?: string
  /** the fullscreen renderer (CLAUDE_CODE_NO_FLICKER=1), the only one mouse reports reach */
  fullscreen?: boolean
  /** ms between streamed chunks of `chunkSize` characters; instant by default */
  latency?: number
  chunkSize?: number
  /** a settings.json for the session (`--settings`), e.g. a plugin's `pluginConfigs` options */
  settings?: string
  /** write Claude Code's --debug-file; off for recordings that must not show the banner */
  debug?: boolean
  /** isolate tmux on this server socket (`-L`); unset keeps the default server */
  tmuxSocket?: string
  /** tmux config read at server creation (`-f` on `new-session` only) */
  tmuxConfig?: string
}

export async function startSession(fixtures: Fixture[], options: SessionOptions = {}): Promise<Session> {
  const {
    columns = 170,
    rows = 80,
    fullscreen = false,
    latency,
    chunkSize,
    pluginDir = REPO,
    cwd = REPO,
    settings,
    debug = true,
    tmuxSocket,
    tmuxConfig,
  } = options
  const tmux = (...args: string[]) => tmuxCmd(tmuxSocket, args)
  const mock = new LLMock({ port: 0, latency, chunkSize })
  for (const { prompt, reply, tool, lead, when } of fixtures) {
    const also = when ? { predicate: when } : {}
    if (!tool) {
      mock.on({ userMessage: prompt, ...also }, { content: reply })
      continue
    }
    // the first request of the prompt gets the call; the one carrying its result, the reply
    const call = { toolCalls: [{ name: tool.name, arguments: JSON.stringify(tool.arguments) }] }
    mock.on({ userMessage: prompt, hasToolResult: false }, lead ? { content: lead, ...call } : call)
    mock.on({ userMessage: prompt, hasToolResult: true, ...also }, { content: reply })
  }
  await mock.start()
  const proxy = await startProxy(mock.url)

  const name = `signal-e2e-${process.pid}-${Date.now().toString(36)}`
  const debugLog = join(mkdtempSync(join(tmpdir(), 'signal-e2e-')), 'debug.log')
  // scripts/e2e.sh seeds this; without it the run would open the reader's own config, which it must never do
  const configDir = process.env.CLAUDE_CONFIG_DIR
  const env = [
    ...(configDir ? [`CLAUDE_CONFIG_DIR=${configDir}`] : []),
    `ANTHROPIC_BASE_URL=${proxy.url}`,
    'ANTHROPIC_API_KEY=mock',
    'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'DISABLE_AUTOUPDATER=1',
    `CLAUDE_CODE_NO_FLICKER=${fullscreen ? '1' : '0'}`,
  ].join(' ')
  const command = `${env} ${claudeBin()} --plugin-dir ${pluginDir} --model claude-sonnet-5${debug ? ` --debug-file ${debugLog}` : ''}${settings ? ` --settings ${settings}` : ''}`
  // the mirror is the cwd and the seeded config trusts it, so no dialog stands in front of the card
  const newSession = ['new-session', '-d', '-s', name, '-x', String(columns), '-y', String(rows), '-c', cwd, command]
  if (tmuxConfig) tmuxCmd(tmuxSocket, ['-f', tmuxConfig, ...newSession])
  else tmux(...newSession)

  const screen = (withColor = false) => tmux('capture-pane', '-t', name, '-p', ...(withColor ? ['-e'] : []))
  const plainRows = () => stripAnsi(screen()).split('\n')

  const waitFor = async (pattern: RegExp | string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
      last = screen(true)
      if (matches(last, pattern)) return last
      await sleep(250)
    }
    throw new Error(`waited ${timeoutMs}ms for ${pattern} · debug log ${debugLog} · screen:\n${screen()}`)
  }

  const waitForGone = async (pattern: RegExp | string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
      last = screen(true)
      if (!matches(last, pattern)) return last
      await sleep(250)
    }
    throw new Error(`waited ${timeoutMs}ms for ${pattern} to go · screen:\n${last}`)
  }

  const mouse = async (kind: 'down' | 'up' | 'drag', column: number, row: number) => {
    // SGR mouse reports, 1-based cells; Claude Code turns mouse tracking on itself
    const code = kind === 'drag' ? 32 : 0
    tmux('send-keys', '-t', name, '-l', `\x1b[<${code};${column};${row}${kind === 'up' ? 'm' : 'M'}`)
    // events in one frame collapse into the last: give each its own
    await sleep(120)
  }

  const session: Session = {
    name,
    // typed literally so a long prompt never lands as several lines
    send: text => {
      tmux('send-keys', '-t', name, '-l', text)
      // a beat for the composer (and a slash command's typeahead) to settle before Enter
      spawnSync('sleep', ['0.15'])
      tmux('send-keys', '-t', name, 'Enter')
    },
    keys: (...keys) => void tmux('send-keys', '-t', name, ...keys),
    type: async text => {
      // one key at a time: a burst reads as a paste, which a focused pane drops
      for (const ch of text) {
        tmux('send-keys', '-t', name, '-l', ch)
        await sleep(30)
      }
    },
    mouse,
    click: async label => {
      const drawn = `[ ${label} ]`
      const lines = plainRows()
      const row = lines.findIndex(line => line.includes(drawn))
      if (row < 0) return false
      // the middle of the label, not its bracket: a border cell is not the target
      const column = lines[row]!.indexOf(drawn) + 2 + Math.floor(label.length / 2)
      await mouse('down', column + 1, row + 1)
      await mouse('up', column + 1, row + 1)
      return true
    },
    screen,
    rows: plainRows,
    waitFor,
    waitForGone,
    debugLog,
    stop: async () => {
      try {
        tmux('kill-session', '-t', name)
      } catch {}
      await proxy.stop()
      await mock.stop()
      rmSync(dirname(debugLog), { recursive: true, force: true })
    },
  }

  // the composer's empty prompt marks a ready session
  try {
    await waitFor(/^❯\s*$/m, 60_000)
  } catch (error) {
    await session.stop()
    throw error
  }
  return session
}

/** the plain screen: no SGR codes (tmux -e keeps them), no-break spaces as spaces */
export const stripAnsi = (text: string) =>
  text.replace(/\x1b\[[0-9;:?]*[a-zA-Z]/g, '').replace(/\u00a0/g, ' ')

/**
 * The card's own rows, from the line carrying `first` to the line carrying
 * `last`. Every "the card contains no X" assertion needs this: the composer
 * draws its own box at the bottom of every screen, so a whole-screen search
 * for a box glyph would answer about the prompt, not about the card.
 */
export const block = (screen: string, first: RegExp | string, last: RegExp | string): string => {
  const lines = stripAnsi(screen).split('\n')
  const hit = (line: string, what: RegExp | string) => (typeof what === 'string' ? line.includes(what) : what.test(line))
  const from = lines.findIndex(line => hit(line, first))
  if (from < 0) throw new Error(`no line matching ${first} on:\n${lines.join('\n')}`)
  const to = lines.findIndex((line, i) => i >= from && hit(line, last))
  if (to < 0) throw new Error(`no line matching ${last} after ${first} on:\n${lines.join('\n')}`)
  return lines.slice(from, to + 1).join('\n')
}
