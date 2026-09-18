import { MARKER_GLYPHS, type CardItem, type CardModel, type Decision, type DecisionOption, type Marker } from './theme.ts'

// The card grammar, SPEC §2: a pure reader of the model's own text. No `$`, no state, no I/O — the render hook calls it once per drawing, so it stays O(lines).

/** up to three spaces then `>` and one optional space: the blockquote wrapper a card may or may not wear */
const QUOTE = /^[ \t]{0,3}>[ \t]?/

/** `**👉 For you**`, bold optional, either language; it opens the card and is not an item */
const HEADER = /^(?:\*\*)?\s*👉\s*(?:for you|pour toi)\s*(?:\*\*)?$/iu

/** the whole text in stars */
const WHOLE_BOLD = /^\*\*([\s\S]+?)\*\*$/

/** a short label, then the rest in stars: `À décider : **…**` */
const LABEL_BOLD = /^([^*]{1,40}?:\s*)\*\*([\s\S]+?)\*\*$/

/** the label a decision line may open with, in either language */
const DECIDE_LABEL = /^(?:à\s+décider|a\s+décider|decide|decision)\s*:\s*/iu

/** what happens if the reader says nothing */
const DEFAULT_CLAUSE = /\b(?:if you say nothing|sans réponse(?:\s+de ta part)?|default|par défaut)\s*:\s*(.+)$/iu

/** interrogative stems stripped before an option is labelled */
const OPTION_STEM = /^(?:should i|do i|shall we|dois-je|faut-il|est-ce que)\s+/iu

const wordCount = (text: string) => text.trim().split(/\s+/u).filter(Boolean).length

/** an `A or B?` / `A ou B ?` question, split at the first conjunction */
const OPTIONS = /^(.+?)\s+(or|ou)\s+(.+?)\s*\?$/u

/** `A, B ou C ?` / `A, B, C or D?` — comma-separated items, the last joined by `ou`/`or` */
const MULTI_OPTIONS = /^([^?,]+),\s*([^?,]+?)(?:,\s*([^?,]+?))?\s+(ou|or)\s+([^?,]+?)\s*\?(?:\s*(.*))?$/iu

/** `A = …`, `B) …`, `1 : …` inline option titles in the decision text */
const INLINE_OPTION = /\b([A-D]|[1-4])\s*(?:=|:|\))\s*([^.;]+)(?:\.\s*)?/gi

/** a ▫️ line keyed to an option: `A — detail` */
const OPTION_DETAIL = /^([A-D]|[1-4])\s*[—\-:=]\s*(.+)$/iu

/** `~2h`, `≈ 45 min`, `1 day` */
const ESTIMATE = /(?:~|≈)?\s*(\d+\s*(?:min|mins|minutes?|h|hrs?|hours?|day|days))/iu

/** `Risk: high` / `risque : élevé` */
const RISK = /\b(?:risk|risque)\s*:\s*(high|medium|low|élevé|moyen|faible)/iu

/** `Cost: …` / `Coût : …` up to the next sentence-ending punctuation */
const COST = /\b(?:cost|coût)\s*:\s*([^.;!?]+)/iu

/** an option longer than this is a sentence, not a button */
const OPTION_MAX = 40

/** longest glyph first, so `⚠️` is read before `⚠` and no variation selector is left in the text */
const GLYPHS: readonly (readonly [string, Marker])[] = (Object.entries(MARKER_GLYPHS) as [Marker, readonly string[]][])
  .flatMap(([marker, glyphs]) => glyphs.map(glyph => [glyph, marker] as const))
  .sort((a, b) => b[0].length - a[0].length)

const fenceOpen = (line: string): { ticks: number; lang: string } | null => {
  const trimmed = line.trimStart()
  const match = /^(`{3,})(.*)$/.exec(trimmed)
  if (!match) return null
  return { ticks: match[1]!.length, lang: match[2]!.trim() }
}

const fenceClose = (line: string, ticks: number): boolean => {
  const trimmed = line.trimStart()
  const match = /^(`+)(.*)$/.exec(trimmed)
  return Boolean(match && match[1]!.length >= ticks && match[2]!.trim() === '')
}

const riskOf = (word: string): DecisionOption['risk'] => {
  const lower = word.toLowerCase()
  if (lower === 'high' || lower === 'élevé') return 'high'
  if (lower === 'medium' || lower === 'moyen') return 'medium'
  return 'low'
}

/** estimate, risk and cost, all optional */
export const parseOptionDetail = (detail: string): Pick<DecisionOption, 'estimate' | 'risk' | 'cost'> => {
  const estimate = ESTIMATE.exec(detail)?.[1]?.trim()
  const riskMatch = RISK.exec(detail)
  const risk = riskMatch ? riskOf(riskMatch[1]!) : undefined
  const cost = COST.exec(detail)?.[1]?.trim()
  return { ...(estimate ? { estimate } : {}), ...(risk ? { risk } : {}), ...(cost ? { cost } : {}) }
}

const inlineLabels = (text: string): Map<string, string> => {
  const labels = new Map<string, string>()
  for (const match of text.matchAll(INLINE_OPTION)) labels.set(match[1]!.toUpperCase(), match[2]!.trim())
  return labels
}

const stripInlineDefs = (text: string): string =>
  text
    .replace(/\b([A-D]|[1-4])\s*(?:=|:|\))\s*[^.;]+(?:\.\s*)?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+\./g, '.')
    .trim()

const optionFromKeys = (keys: string[], labels: Map<string, string>): DecisionOption[] =>
  keys.map(key => {
    const upper = key.toUpperCase()
    const label = labels.get(upper) ?? key
    return label.length <= OPTION_MAX ? { key: upper, label } : { key: upper, label }
  })

const optionLabel = (side: string): string => side.replace(OPTION_STEM, '').trim()

const twoOptions = (left: string, right: string): DecisionOption[] => {
  const a = optionLabel(left)
  const b = optionLabel(right)
  const wa = wordCount(a)
  const wb = wordCount(b)
  if (wa === 0 || wb === 0) return []
  if (wa > wb * 2 || wb > wa * 2) return []
  const short = a.length <= OPTION_MAX && b.length <= OPTION_MAX
  return short ? [{ label: a }, { label: b }] : []
}

/** the question, its default clause and its short answers, read off a 🟡 line and its continuations */
export const parseDecision = (raw: string, lines: readonly string[] = []): Decision => {
  const body = [raw, ...lines].join(' ').replace(DECIDE_LABEL, '').trim()
  const clause = DEFAULT_CLAUSE.exec(body)
  const withoutDefault = (clause ? body.slice(0, clause.index) : body).trim()
  const defaultText = clause ? clause[1]!.trim() : null

  const labels = inlineLabels(withoutDefault)
  const multi = MULTI_OPTIONS.exec(withoutDefault)
  if (multi) {
    const keys = [multi[1]!, multi[2]!, multi[3], multi[5]!].filter((part): part is string => Boolean(part?.trim())).map(part => part.trim())
    if (keys.length >= 2 && keys.length <= 4) {
      const rest = multi[6]?.trim() ?? ''
      const question = stripInlineDefs([keys.join(', ') + '?', rest].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
      const options = optionFromKeys(keys, labels)
      const defaultKey = defaultText && options.some(option => option.key === defaultText.toUpperCase()) ? defaultText.toUpperCase() : null
      return { question, defaultText, defaultKey, options }
    }
  }

  const parts = OPTIONS.exec(withoutDefault)
  const left = parts?.[1]?.trim() ?? ''
  const right = parts?.[3]?.trim() ?? ''
  const question = stripInlineDefs(withoutDefault)
  const options = twoOptions(left, right)
  const defaultKey =
    defaultText && options.some(option => option.label === defaultText || option.key === defaultText.toUpperCase())
      ? (options.find(option => option.label === defaultText)?.key ?? defaultText.toUpperCase())
      : null
  return { question, defaultText, defaultKey, options }
}

const attachOptionDetails = (decision: Decision, items: CardItem[]): CardItem[] => {
  if (decision.options.length === 0 || !decision.options.some(option => option.key)) return items
  const keyed = new Map(decision.options.filter(option => option.key).map(option => [option.key!, option]))
  const kept: CardItem[] = []
  for (const item of items) {
    if (item.marker !== 'info') {
      kept.push(item)
      continue
    }
    const match = OPTION_DETAIL.exec(item.text.trim())
    if (!match) {
      kept.push(item)
      continue
    }
    const option = keyed.get(match[1]!.toUpperCase())
    if (!option) {
      kept.push(item)
      continue
    }
    const detail = match[2]!.trim()
    option.detail = detail
    Object.assign(option, parseOptionDetail(detail))
  }
  return kept.filter(item => {
    if (item.marker !== 'info') return true
    const match = OPTION_DETAIL.exec(item.text.trim())
    return !match || !keyed.has(match[1]!.toUpperCase())
  })
}

/** a reply is a card when it has the header, two distinct markers, or markers are the majority of its lines */
const isCard = (header: boolean, items: CardItem[], lines: readonly string[]): boolean => {
  if (header) return items.length > 0
  const markers = new Set(items.map(item => item.marker))
  if (markers.size >= 2) return true
  const nonEmpty = lines.filter(line => line.trim() !== '').length
  const marked = items.reduce((n, item) => n + 1 + item.lines.length, 0)
  const unmarked = nonEmpty - marked - (header ? 1 : 0)
  return marked > 0 && marked > unmarked
}

/** a block is a card when it passes the threshold; anything else is passed through untouched */
export const parseCard = (text: string): CardModel | null => {
  const { lines, quoted } = unquote(text)
  const preamble: string[] = []
  const items: CardItem[] = []
  let header = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const open = fenceOpen(line)
    if (open) {
      const body: string[] = []
      i++
      while (i < lines.length && !fenceClose(lines[i]!, open.ticks)) {
        body.push(lines[i]!)
        i++
      }
      if (i < lines.length) i++
      if (items.length > 0) items[items.length - 1]!.code.push({ lang: open.lang, source: body.join('\n') })
      else preamble.push(line.trim())
      continue
    }
    i++
    if (line.trim() === '') continue
    if (isHeader(line)) {
      header = true
      continue
    }
    const marker = markerOf(line)
    if (marker) {
      const { text: body, bold } = unbold(marker.text)
      items.push({ marker: marker.marker, text: body, bold, lines: [], code: [] })
      continue
    }
    if (items.length > 0) items[items.length - 1]!.lines.push(line.trim())
    else preamble.push(line.trim())
  }
  if (!isCard(header, items, lines)) return null
  const decide = items.find(item => item.marker === 'decide')
  const decision = decide ? parseDecision(decide.text, decide.lines) : null
  const finalItems = decision ? attachOptionDetails(decision, items) : items
  const counts: Record<Marker, number> = { done: 0, decide: 0, blocked: 0, read: 0, info: 0, skip: 0 }
  for (const item of finalItems) counts[item.marker]++
  return {
    preamble,
    header,
    verdict: finalItems.find(item => item.marker === 'decide' && item.bold) ?? finalItems.find(item => item.bold) ?? null,
    decision,
    items: finalItems,
    counts,
    quoted,
    raw: text,
  }
}

/** the lines with one level of `>` off them, and whether every non-empty line wore one */
export const unquote = (text: string): { lines: string[]; quoted: boolean } => {
  let seen = 0
  let stripped = 0
  const lines = text.split('\n').map(line => {
    if (line.trim() === '') return ''
    seen++
    const match = QUOTE.exec(line)
    if (!match) return line
    stripped++
    return line.slice(match[0].length)
  })
  return { lines, quoted: seen > 0 && stripped === seen }
}

/** the marker a line opens with, and the text after it; null when the line opens an item of no kind */
export const markerOf = (line: string): { marker: Marker; text: string } | null => {
  const trimmed = line.trimStart()
  for (const [glyph, marker] of GLYPHS) {
    if (trimmed.startsWith(glyph)) return { marker, text: trimmed.slice(glyph.length).trim() }
  }
  return null
}

export const isHeader = (line: string): boolean => HEADER.test(line.trim())

/** the text with its stars removed, and whether they were there; a label before them is kept */
export const unbold = (text: string): { text: string; bold: boolean } => {
  if (text.split('**').length === 3) {
    const whole = WHOLE_BOLD.exec(text)
    if (whole) return { text: whole[1]!.trim(), bold: true }
    const labelled = LABEL_BOLD.exec(text)
    if (labelled) return { text: `${labelled[1]!}${labelled[2]!}`.trim(), bold: true }
  }
  return { text: text.replace(/\*\*([^*]+)\*\*/g, '$1'), bold: false }
}
