import { describe, expect, test } from 'bun:test'
import type { RenderElement } from 'claude-code'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditPrompt, parseAuditAnswer, renderedText } from '../../hooks/audit.ts'
import { parseCard } from '../../hooks/card.ts'
import type { ThemeCtx } from '../../hooks/theme.ts'
import { theme as gmorel } from '../../hooks/themes/gmorel.ts'

const table = {
  Box: (props: Record<string, unknown>) => ({ type: 'Box', props }),
  Text: (props: Record<string, unknown>) => ({ type: 'Text', props }),
  Button: (props: Record<string, unknown>) => ({ type: 'Button', props }),
  Code: (props: Record<string, unknown>) => ({ type: 'Code', props }),
}

const context = (): ThemeCtx =>
  ({
    el: table as unknown as ThemeCtx['el'],
    columns: 100,
    surface: 'terminal',
    state: { open: {}, answered: null },
    actions: { toggle: () => {}, fill: () => {} },
    witness: { observerRunning: false, hiddenReports: 0 },
    id: 'msg-1',
  }) as unknown as ThemeCtx

describe('renderedText', () => {
  test('walks Box, Text and Button nodes', () => {
    const tree = table.Box({
      children: [
        table.Text({ children: 'hello' }),
        table.Button({ key: 'b1', label: 'yes' }),
        table.Box({ children: table.Text({ children: 'nested' }) }),
      ],
    })
    expect(renderedText(tree as RenderElement)).toBe('hello\n[ yes ]\nnested')
  })

  test('gmorel drops default clause when options are present (keep it)', () => {
    const raw = readFileSync(join(import.meta.dir, '../e2e/marker-card.txt'), 'utf8').trimEnd()
    const model = parseCard(raw)
    expect(model).not.toBeNull()
    const drawn = gmorel.render(model!, context())
    const rendered = renderedText(drawn)
    expect(raw.toLowerCase()).toContain('keep it')
    expect(rendered.toLowerCase()).not.toContain('keep it')
  })
})

describe('parseAuditAnswer', () => {
  test('returns stripped MISSING lines', () => {
    expect(parseAuditAnswer('MISSING: default clause\nMISSING: witness check')).toEqual([
      'default clause',
      'witness check',
    ])
  })

  test('returns empty on OK', () => {
    expect(parseAuditAnswer('OK')).toEqual([])
    expect(parseAuditAnswer('Nothing missing. OK.')).toEqual([])
  })

  test('parses a French blockquote verdict', () => {
    const answer = '> 🔍 **VERDICT: MANQUANT** — La phrase « keep it » est absente en RENDERED.'
    expect(parseAuditAnswer(answer)).toEqual([
      '🔍 VERDICT: MANQUANT — La phrase « keep it » est absente en RENDERED.',
    ])
  })
})

describe('auditPrompt', () => {
  test('caps raw at 4000 characters plus ellipsis', () => {
    const raw = 'x'.repeat(9000)
    const prompt = auditPrompt(raw, 'rendered')
    expect(prompt.startsWith('RAW:\n' + 'x'.repeat(4000))).toBe(true)
    expect(prompt).toContain(' …\n\nRENDERED:\nrendered')
  })
})
