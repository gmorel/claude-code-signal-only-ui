import { describe, expect, test } from 'bun:test'
import { computeUsage, formatCost, formatTokens, modelFamily, parsePrices } from '../../hooks/cost.ts'

describe('parsePrices', () => {
  test('keeps defaults when config is empty', () => {
    const prices = parsePrices()
    expect(prices.sonnet).toEqual({ input: 3, output: 15 })
    expect(prices.opus).toEqual({ input: 15, output: 75 })
  })

  test('overrides only listed families', () => {
    const prices = parsePrices('sonnet:5/25')
    expect(prices.sonnet).toEqual({ input: 5, output: 25 })
    expect(prices.haiku).toEqual({ input: 0.8, output: 4 })
  })
})

describe('modelFamily', () => {
  test('matches on substring, case-insensitive', () => {
    expect(modelFamily('claude-sonnet-4-20250514')).toBe('sonnet')
    expect(modelFamily('CLAUDE-OPUS-4')).toBe('opus')
  })

  test('unknown models fall back to sonnet', () => {
    expect(modelFamily('some-future-model')).toBe('sonnet')
  })
})

describe('computeUsage', () => {
  test('sums all input-shaped tokens for the count and prices output separately', () => {
    const summary = computeUsage({
      model: 'claude-sonnet-5',
      input_tokens: 10_000,
      output_tokens: 2_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
    expect(summary.inputTokens).toBe(10_000)
    expect(summary.outputTokens).toBe(2_000)
    // (10000 * 3 + 2000 * 15) / 1e6 = 0.06
    expect(summary.costUsd).toBeCloseTo(0.06, 5)
  })

  test('prices cache reads at 10% and cache writes at 125% of input', () => {
    const summary = computeUsage({
      model: 'claude-sonnet-5',
      input_tokens: 10_000,
      output_tokens: 2_000,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 500,
    })
    expect(summary.inputTokens).toBe(11_500)
    expect(summary.outputTokens).toBe(2_000)
    // (10000*3 + 1000*3*0.1 + 500*3*1.25 + 2000*15) / 1e6 = 0.062175
    expect(summary.costUsd).toBeCloseTo(0.062175, 5)
  })
})

describe('formatCost', () => {
  test('shows the sub-cent floor for nonzero costs that round to zero', () => {
    expect(formatCost(0.004)).toBe('< $0.01')
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCost(0.09)).toBe('$0.09')
  })
})

describe('formatTokens', () => {
  test('formats below 1k, thousands, and millions', () => {
    expect(formatTokens(900)).toBe('900 tokens')
    expect(formatTokens(22_000)).toBe('22k tokens')
    expect(formatTokens(1_200_000)).toBe('1.2m tokens')
  })
})
