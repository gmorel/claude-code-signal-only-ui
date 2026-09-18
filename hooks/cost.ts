import type { TurnUsage } from 'claude-code'

/** USD per million tokens, input and output, by model family. */
export type PriceTier = { input: number; output: number }

export const DEFAULT_PRICES: Record<string, PriceTier> = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.8, output: 4 },
}

export type UsageSummary = { inputTokens: number; outputTokens: number; costUsd: number }

/** Anthropic's published cache pricing: cache reads cost 10% of base input. */
const CACHE_READ_MULTIPLIER = 0.1
/** Anthropic's published cache pricing: cache writes cost 125% of base input. */
const CACHE_CREATION_MULTIPLIER = 1.25

/** `opus:15/75,sonnet:3/15` — only listed families override the defaults. */
export const parsePrices = (config?: string): Record<string, PriceTier> => {
  const prices = { ...DEFAULT_PRICES }
  if (!config) return prices
  for (const part of config.split(',')) {
    const [family, rates] = part.trim().split(':')
    if (!family || !rates) continue
    const [rawIn, rawOut] = rates.split('/')
    const input = Number(rawIn)
    const output = Number(rawOut)
    if (Number.isFinite(input) && Number.isFinite(output)) prices[family.toLowerCase()] = { input, output }
  }
  return prices
}

/** Substring match on the API model id; unknown families fall back to sonnet pricing. */
export const modelFamily = (model: string): string => {
  const lower = model.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  return 'sonnet'
}

/**
 * Regular input at the tier rate; cache reads at 10% and cache writes at 125%
 * of that input rate (Anthropic's published cache multipliers).
 */
export const computeUsage = (usage: TurnUsage, prices: Record<string, PriceTier> = DEFAULT_PRICES): UsageSummary => {
  const tier = prices[modelFamily(usage.model)] ?? { input: 3, output: 15 }
  const inputTokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const outputTokens = usage.output_tokens
  const costUsd =
    (usage.input_tokens * tier.input +
      usage.cache_read_input_tokens * tier.input * CACHE_READ_MULTIPLIER +
      usage.cache_creation_input_tokens * tier.input * CACHE_CREATION_MULTIPLIER +
      outputTokens * tier.output) /
    1_000_000
  return { inputTokens, outputTokens, costUsd }
}

/** `≈ $0.09` — `< $0.01` when nonzero but rounds to zero; `$0.00` only when truly free. */
export const formatCost = (costUsd: number): string => {
  if (costUsd === 0) return '$0.00'
  if (costUsd > 0 && costUsd < 0.005) return '< $0.01'
  return `$${costUsd.toFixed(2)}`
}

/** `22k tokens` below 1M; `1.2m tokens` above; exact count below 1000. */
export const formatTokens = (total: number): string => {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}m tokens`
  if (total >= 1000) return `${Math.round(total / 1000)}k tokens`
  return `${total} tokens`
}
