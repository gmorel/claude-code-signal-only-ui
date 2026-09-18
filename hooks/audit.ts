import type { ProcessRunInit, RenderElement, RenderNode } from 'claude-code'

const CAP = 4000
const ELLIPSIS = ' …'
const SYSTEM =
  'Compare RAW and RENDERED. For each fact, number, name, warning or default present in RAW but absent from RENDERED, print one line starting with MISSING: . If nothing is missing print OK. Print nothing else.'

const trimLine = (line: string) => line.trim()

const collapse = (lines: string[]) => {
  const out: string[] = []
  for (const line of lines.map(trimLine)) {
    if (line === '' && out[out.length - 1] === '') continue
    out.push(line)
  }
  while (out[0] === '') out.shift()
  while (out[out.length - 1] === '') out.pop()
  return out
}

const walkChild = (child: unknown, lines: string[]): void => {
  if (child === undefined || child === null || typeof child === 'boolean' || typeof child === 'number') return
  walk(child as RenderElement | RenderNode | readonly RenderNode[], lines)
}

const walk = (el: RenderElement | RenderNode | readonly RenderNode[] | undefined, lines: string[]): void => {
  if (el === undefined) return
  if (typeof el === 'string') {
    lines.push(el)
    return
  }
  if (Array.isArray(el)) {
    for (const child of el) walkChild(child, lines)
    return
  }
  if (typeof el !== 'object' || el === null || !('type' in el) || !('props' in el)) return
  const props = el.props
  if (!props || typeof props !== 'object') return
  if (el.type === 'Text') {
    walkChild('children' in props ? props.children : undefined, lines)
    return
  }
  if (el.type === 'Button' && 'label' in props && typeof props.label === 'string') {
    lines.push(`[ ${props.label} ]`)
    return
  }
  if (el.type === 'Box') walkChild('children' in props ? props.children : undefined, lines)
}

export const renderedText = (el: RenderElement | RenderNode | readonly RenderNode[] | undefined): string => {
  const lines: string[] = []
  walk(el, lines)
  return collapse(lines).join('\n')
}

const cap = (text: string) => (text.length <= CAP ? text : text.slice(0, CAP) + ELLIPSIS)

export const auditPrompt = (raw: string, rendered: string): string =>
  `RAW:\n${cap(raw)}\n\nRENDERED:\n${cap(rendered)}`

const stripLine = (line: string) =>
  line
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\*\*/g, '')
    .trim()

const markerOnly = /^[-*•·▪▫️ℹ️🔍✅❌⚠️🟢🟡🔴👉▫\s]+$/u

export const parseAuditAnswer = (stdout: string): string[] => {
  const surviving = stdout
    .split('\n')
    .map(stripLine)
    .filter(line => line !== '' && !markerOnly.test(line))

  const missing = surviving
    .filter(line => /^missing:/i.test(line))
    .map(line => line.replace(/^missing:\s*/i, '').trim())
    .filter(line => line !== '')

  if (missing.length > 0) return missing

  if (/\bOK\b/.test(stdout) && !/missing:/i.test(stdout)) return []

  return surviving.slice(0, 3).map(line => (line.length <= 200 ? line : line.slice(0, 200)))
}

export const auditArgv = (raw: string, rendered: string) => [
  'claude',
  '-p',
  '--model',
  'haiku',
  '--settings',
  '{"outputStyle":"default","hooks":{}}',
  '--system-prompt',
  SYSTEM,
  auditPrompt(raw, rendered),
]

export const auditRunInit = (cwd: string): ProcessRunInit => ({
  cwd: cwd || '/tmp',
  timeoutMs: 120000,
  stdin: '',
  env: {
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0',
    CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS: '0',
  },
})
