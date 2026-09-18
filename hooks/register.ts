import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'
import { parseCard } from './card.ts'
import {
  foldsNotification,
  isObserverOrigin,
  notificationLooksFailed,
  narrationFallbackOnBlock,
  narrationMarkedOf,
  narrationOf,
  narrationSummary,
  narrationTextsOfChunk,
  notificationSummary,
  reportKey,
  stableIdOf,
} from './fold.ts'
import { auditArgv, auditRunInit, parseAuditAnswer, renderedText } from './audit.ts'
import { computeUsage, parsePrices, type UsageSummary } from './cost.ts'
import { themeOf, themes } from './themes/index.ts'
import type { CardState, ThemeCtx, Witness } from './theme.ts'

// The model writes the substance as marker lines; this draws the form. A card goes through the configured theme, narration and notifications fold to one dim line, an observer's report is hidden and leaves a witness check behind. Display only: the stored transcript is never rewritten.

const COMMAND = 'signal'
const PREFS_KEY = 'prefs'
/** the transcript's gutter and margins, off the width a card may draw into */
const GUTTER = 4
/** narrow enough that a card still reads; below it the terminal is unusable anyway */
const MIN_COLUMNS = 24
/** how many hidden reports `/signal observers` lists */
const LISTED = 20
/** the session's caps: a transcript is long and only the drawn messages matter */
const KEPT_REPORTS = 200
const KEPT_STATES = 400

type Prefs = { theme: string; observerMark: boolean; foldNarration: boolean; foldNotifications: boolean; audit: boolean }

const DEFAULT_PREFS: Prefs = { theme: 'gmorel', observerMark: true, foldNarration: true, foldNotifications: true, audit: false }
const DEFAULT_OBSERVER_TYPES = ['claim-sentinel']

/** the two message drawings this module hooks; both resolve an element table */
type MessageRender = RenderInput<'AssistantMessage'> | RenderInput<'UserMessage'>

/** userConfig as `register(on, options)` received it: the defaults the store layers over */
let base: Prefs = DEFAULT_PREFS
let prefs: Prefs = DEFAULT_PREFS
let observerTypes: readonly string[] = DEFAULT_OBSERVER_TYPES

/** one fold state per drawn message */
const states = new Map<string, CardState>()
/** blocks drawn in the running turn: id → turnId; only the current turn's ids are marked narration */
let waiting = new Map<string, string>()
/** the turn a message id was first drawn in, so a redraw of an old block is not narration */
const drawnInTurn = new Map<string, string>()
/** blocks a tool call turned into narration */
const narrated = new Set<string>()
/** texts turn.step saw before a tool chunk; chunks carry no requestId matching the render hook */
const narrationByText = new Set<string>()
/** tool.call ran with nothing in waiting yet: the next non-card block is decided when a later one draws */
let narrationPending = false
let narrationCandidate: string | undefined
/** the running main-loop turn, so a redraw of old blocks while idle marks nothing */
let turnId: string | undefined
const witness: Witness = { observerRunning: false, hiddenReports: 0 }
/** the observer reports hidden this session, oldest first, deduped on text */
const reports = new Map<string, string>()
/** report keys counted since the last card was drawn, so a redraw does not count twice */
let turnReports = new Set<string>()
/** the last assistant card drawn; kept across turn.complete for between-turn witness redraws */
let lastDrawnCardId: string | undefined
/** whether a card has been drawn in the running turn yet */
let cardDrawnThisTurn = false
/** USD per million tokens, keyed by model family; overridable via userConfig `prices` */
let prices = parsePrices()
/** the last assistant message drawn in the running turn: `turn.complete`'s usage attaches here */
let lastAssistantId: string | undefined
/** the last card of the running turn, for the post-turn haiku audit */
let lastCardForAudit: { raw: string; rendered: string } | undefined
let auditInFlight = false
/** per-message usage from the last completed turn, for the cost footer */
const usageById = new Map<string, UsageSummary>()
/** when `refresh` last called `$.agent.list()` */
let witnessRefreshedAt = 0
/** at most one `$.agent.list()` per turn step's render passes */
let witnessRefreshedThisStep = false
const WITNESS_STALE_MS = 2000

const isPrefs = (value: unknown): value is Partial<Prefs> => typeof value === 'object' && value !== null

const boolOf = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)

const onOff = (word: string): boolean | undefined => (word === 'on' || word === 'true' ? true : word === 'off' || word === 'false' ? false : undefined)

const trim = (store: { size: number; keys: () => IterableIterator<string>; delete: (key: string) => boolean }, max: number) => {
  while (store.size > max) {
    const oldest = store.keys().next().value
    if (oldest === undefined) return
    store.delete(oldest)
  }
}

const stateOf = (id: string): CardState => {
  const known = states.get(id)
  if (known) return known
  const fresh: CardState = { open: {}, answered: null }
  states.set(id, fresh)
  trim(states, KEPT_STATES)
  return fresh
}

/** one dim line and the way in */
const summary = ($: EngineInterface, e: MessageRender, key: string, text: string, onPress: () => void): RenderElement => {
  const { Box, Text, Button } = $.ui.resolve(e)
  return Box({
    key,
    flexDirection: 'row',
    gap: 1,
    children: [Text({ dimColor: true, wrap: 'truncate', children: text }), Button({ key: `${key}:show`, label: 'show', dimColor: true, onPress })],
  })
}

/** the block as the engine draws it, and the way back */
const opened = ($: EngineInterface, e: MessageRender, body: RenderElement, key: string, onPress: () => void): RenderElement => {
  const { Box, Button } = $.ui.resolve(e)
  return Box({ key, flexDirection: 'column', children: [body, Button({ key: `${key}:hide`, label: 'hide', dimColor: true, onPress })] })
}

const ctxOf = ($: EngineInterface, e: RenderInput<'AssistantMessage'>, id: string, state: CardState): ThemeCtx => ({
  el: $.ui.resolve(e),
  columns: Math.max(MIN_COLUMNS, (e.viewport?.columns ?? 80) - GUTTER),
  surface: e.surface,
  state,
  witness,
  id,
  usage: usageById.get(id),
  actions: {
    toggle: section => {
      state.open[section] = state.open[section] !== true
      $.ui.invalidate('ui.render')
    },
    fill: text => {
      // the prompt box, never the send: nothing leaves on the reader's behalf
      state.answered = text
      $.ui.invalidate('ui.render')
      void $.prompt
        .fill({ text })
        .then(({ isFilled }) => {
          if (isFilled) return
          // a dialog held the keys: the card must not claim an answer the box never took
          state.answered = null
          $.ui.log('signal: the prompt box is busy · the answer was not filled in')
          $.ui.invalidate('ui.render')
        })
        .catch(err => $.ui.log(`signal: fill failed: ${err}`))
    },
  },
})

// `$.agent.list()` is a host call: memoise per turn step so a render pass with many cards asks once.
const refresh = async ($: EngineInterface) => {
  witnessRefreshedAt = Date.now()
  witnessRefreshedThisStep = true
  const agents = await $.agent.list().catch(() => [])
  const running = agents.some(agent => agent.status === 'running' && observerTypes.includes(agent.type))
  if (running === witness.observerRunning) return
  witness.observerRunning = running
  $.ui.invalidate('ui.render')
}

const ids = () => Object.keys(themes)

const status = () =>
  `signal: theme ${prefs.theme} · observer ${prefs.observerMark ? 'on' : 'off'} · fold ${prefs.foldNarration || prefs.foldNotifications ? 'on' : 'off'} · audit ${prefs.audit ? 'on' : 'off'} · ${reports.size} report${reports.size === 1 ? '' : 's'} hidden · ${witness.observerRunning ? 'an observer is running ✓' : 'no observer running'}`

export const register: Register = (on, options) => {
  witness.hiddenReports = 0
  witness.observerRunning = false
  turnReports = new Set()
  lastDrawnCardId = undefined
  cardDrawnThisTurn = false
  base = {
    theme: typeof options.theme === 'string' ? options.theme : DEFAULT_PREFS.theme,
    observerMark: boolOf(options.observerMark, DEFAULT_PREFS.observerMark),
    foldNarration: boolOf(options.foldNarration, DEFAULT_PREFS.foldNarration),
    foldNotifications: boolOf(options.foldNotifications, DEFAULT_PREFS.foldNotifications),
    audit: boolOf(options.audit, DEFAULT_PREFS.audit),
  }
  prefs = base
  // SPEC §3.3: which agent types count as an observer for the witness check.
  // userConfig has no list type, so plugin.json declares a comma-separated string; a raw option may still be an array
  const configured = options.observerTypes
  const listed = Array.isArray(configured)
    ? configured.filter((type): type is string => typeof type === 'string')
    : typeof configured === 'string'
      ? configured.split(',').map(type => type.trim()).filter(type => type !== '')
      : []
  observerTypes = listed.length > 0 ? listed : DEFAULT_OBSERVER_TYPES
  prices = parsePrices(typeof options.prices === 'string' ? options.prices : undefined)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // the store is the reader's own choice and wins over userConfig, key by key
    const saved = await $.store.get(PREFS_KEY).catch(() => undefined)
    if (isPrefs(saved)) {
      prefs = {
        theme: typeof saved.theme === 'string' ? saved.theme : base.theme,
        observerMark: boolOf(saved.observerMark, base.observerMark),
        foldNarration: boolOf(saved.foldNarration, base.foldNarration),
        foldNotifications: boolOf(saved.foldNotifications, base.foldNotifications),
        audit: boolOf(saved.audit, base.audit),
      }
    }
    await $.command
      .register({
        name: COMMAND,
        description: 'The reply card: theme <id>, themes, observer on|off, fold on|off, audit on|off, reset, observers, agents (signal-only-ui)',
        argumentHint: '[theme <id> | themes | observer on|off | fold on|off | audit on|off | reset | observers | agents]',
        // the card is read while a turn streams, so its switches must answer then too
        immediate: true,
      })
      .catch(err => $.ui.log(`signal: /${COMMAND} not registered: ${err}`))
    return r
  })

  // `turn.start` is the main loop's alone: a subagent's run raises none, so there is no agentId to check here.
  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    turnId = e.turnId
    waiting = new Map()
    narrationByText.clear()
    narrationPending = false
    narrationCandidate = undefined
    cardDrawnThisTurn = false
    lastAssistantId = undefined
    lastCardForAudit = undefined
    witnessRefreshedThisStep = false
    await refresh($)
    return r
  })

  // Narration is text-then-tool in one turn. TurnStepChunk has block index but no requestId, so we
  // watch turn.step (pass chunks through unchanged) and match narration by text at render time.
  // When tool.call still beats the render hook, narrationPending + narrationFallbackOnBlock decide
  // at the later block so the final block of a turn is never marked.
  on('turn.step', async function* ($, e, next) {
    witnessRefreshedThisStep = false
    let blocks = new Map<number, string>()
    for await (const chunk of next(e)) {
      if (!e.agentId) {
        const step = narrationTextsOfChunk(blocks, chunk)
        blocks = step.blocks
        if (step.texts.length > 0) {
          for (const text of step.texts) {
            narrationByText.add(text)
            narrated.add(stableIdOf(undefined, text))
          }
          trim(narrated, KEPT_STATES)
          if (prefs.foldNarration) $.ui.invalidate('ui.render')
        }
      }
      yield chunk
    }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    // a subagent's turn ends inside the session's own and is not the main loop's
    if (e.agentId) return r
    // usage rides on the last assistant block this turn drew — the same id `waiting` held
    if (e.usage && lastAssistantId) {
      usageById.set(lastAssistantId, computeUsage(e.usage, prices))
      trim(usageById, KEPT_STATES)
      $.ui.invalidate('ui.render')
    }
    turnId = undefined
    lastAssistantId = undefined
    // the last block of a turn has no tool call after it, so what is still waiting or pending is never narration
    waiting.clear()
    narrationPending = false
    narrationCandidate = undefined
    if (prefs.audit && lastCardForAudit && !auditInFlight) {
      const card = lastCardForAudit
      lastCardForAudit = undefined
      auditInFlight = true
      void (async () => {
        try {
          const dir = await $.session.cwd().catch(() => '/tmp')
          const { exitCode, stdout } = await $.process.run(auditArgv(card.raw, card.rendered), auditRunInit(dir))
          if (exitCode !== 0 || stdout.trim() === '') return
          const findings = parseAuditAnswer(stdout)
          for (const finding of findings) $.ui.log(`signal audit: dropped — ${finding}`)
          if (findings.length > 0) $.ui.invalidate('ui.render')
        } catch {
          // audit must never disturb the session
        } finally {
          auditInFlight = false
        }
      })()
    }
    await refresh($)
    return r
  })

  // The narration rule: a block followed by a tool call of the same main-loop turn was the model talking while it worked.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    let touched = false
    if (waiting.size > 0) {
      for (const [id, tid] of waiting) {
        if (tid === turnId) narrated.add(id)
      }
      waiting.clear()
      touched = true
    } else narrationPending = true
    trim(narrated, KEPT_STATES)
    if (touched && prefs.foldNarration) $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const id = stableIdOf(e.requestId, e.props.text)
    const model = parseCard(e.props.text)
    let marked = narrationMarkedOf(id, e.props.text, narrated, narrationByText)
    // only while a turn runs: a resize redraws the whole transcript, and old blocks are not this turn's narration
    if (turnId && !marked) {
      if (narrationPending) {
        const fallback = narrationFallbackOnBlock(narrationCandidate, id, model !== null)
        narrationCandidate = fallback.candidate
        for (const confirmed of fallback.confirmed) narrated.add(confirmed)
        if (fallback.confirmed.length > 0) {
          trim(narrated, KEPT_STATES)
          marked = narrationMarkedOf(id, e.props.text, narrated, narrationByText)
        }
      }
      if (drawnInTurn.get(id) === undefined) drawnInTurn.set(id, turnId)
      if (drawnInTurn.get(id) === turnId) {
        waiting.set(id, turnId)
        lastAssistantId = id
      }
      if (!witnessRefreshedThisStep && Date.now() - witnessRefreshedAt > WITNESS_STALE_MS) await refresh($)
    }
    // read without creating: most blocks never fold, and the map is the session's
    const how = narrationOf({ fold: prefs.foldNarration, marked, open: states.get(id)?.open.narration === true, isCard: model !== null })
    const press = () => {
      const state = stateOf(id)
      state.open.narration = state.open.narration !== true
      $.ui.invalidate('ui.render')
    }
    if (how === 'folded') return summary($, e, `narration:${id}`, narrationSummary(e.props.text), press)
    if (model === null) return prefs.foldNarration && marked ? opened($, e, await next(e), `narration:${id}`, press) : next(e)
    const firstCardThisTurn = turnId !== undefined && !cardDrawnThisTurn
    if (turnId !== undefined) {
      lastDrawnCardId = id
      cardDrawnThisTurn = true
    }
    const drawn = themeOf(prefs.theme).render(model, ctxOf($, e, id, stateOf(id)))
    if (prefs.audit && turnId !== undefined) lastCardForAudit = { raw: e.props.text, rendered: renderedText(drawn) }
    if (firstCardThisTurn) {
      witness.hiddenReports = 0
      turnReports = new Set()
    }
    return drawn
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const kind = e.props.origin.kind
    if (prefs.observerMark && isObserverOrigin(kind)) {
      const key = reportKey(e.props.text)
      if (!turnReports.has(key)) {
        turnReports.add(key)
        witness.hiddenReports++
        if (lastDrawnCardId && (!turnId || cardDrawnThisTurn)) $.ui.invalidate('ui.render')
      }
      if (!reports.has(key)) {
        reports.set(key, e.props.text)
        trim(reports, KEPT_REPORTS)
      }
      // hidden, not dropped: `/signal observers` still reads them back
      return $.ui.resolve(e).Box({ display: 'none' })
    }
    if (!prefs.foldNotifications || !foldsNotification(kind)) return next(e)
    if (notificationLooksFailed(e.props.text)) return next(e)
    const id = stableIdOf(e.requestId, e.props.text)
    const state = stateOf(id)
    // one fold, the same word as a narration's: `[show]` means the block whole
    const press = () => {
      state.open.narration = state.open.narration !== true
      $.ui.invalidate('ui.render')
    }
    return state.open.narration === true
      ? opened($, e, await next(e), `notice:${id}`, press)
      : summary($, e, `notice:${id}`, notificationSummary(kind), press)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [word = '', value = ''] = e.args.trim().split(/\s+/)
    const save = async () => {
      await $.store.set(PREFS_KEY, prefs).catch(err => $.ui.log(`signal: store write failed: ${err}`))
      $.ui.invalidate('ui.render')
    }
    if (word === '') return { text: status() }
    if (word === 'themes') return { text: Object.values(themes).map(theme => `${theme.id === prefs.theme ? '·' : ' '} ${theme.id} — ${theme.tagline}`).join('\n') }
    if (word === 'theme') {
      if (value === '') return { text: `signal: /${COMMAND} theme <${ids().join('|')}> · now ${prefs.theme}` }
      const picked = themes[value]
      if (!picked) return { text: `signal: no theme ${value} · ${ids().join(', ')}` }
      prefs = { ...prefs, theme: value }
      await save()
      return { text: `signal: theme ${value} · ${picked.tagline}` }
    }
    if (word === 'observer') {
      const flag = onOff(value)
      prefs = { ...prefs, observerMark: flag ?? !prefs.observerMark }
      await save()
      return { text: `signal: observer ${prefs.observerMark ? 'on · reports hidden, the card carries the witness check' : 'off · reports drawn as they come'}` }
    }
    if (word === 'fold') {
      const flag = onOff(value)
      const next = flag ?? !(prefs.foldNarration || prefs.foldNotifications)
      // one word for both folds: the reader asked for quiet, not for a matrix of switches
      prefs = { ...prefs, foldNarration: next, foldNotifications: next }
      await save()
      return { text: `signal: fold ${next ? 'on · narration and notifications are one dim line each' : 'off · every block drawn whole'}` }
    }
    if (word === 'audit') {
      const flag = onOff(value)
      prefs = { ...prefs, audit: flag ?? !prefs.audit }
      await save()
      return {
        text: `signal: audit ${prefs.audit ? 'on · every card is compared with a haiku claude -p (≈30 s, costs tokens)' : 'off'}`,
      }
    }
    if (word === 'reset') {
      prefs = { ...base }
      await save()
      return { text: `signal: reset · ${status()}` }
    }
    if (word === 'agents') {
      // ground truth for observerTypes: what $.agent.list() calls the agents of this session
      const agents = await $.agent.list().catch(() => [])
      if (agents.length === 0) return { text: 'signal: no agent listed for this session' }
      const rows = agents.map(agent => `${observerTypes.includes(agent.type) ? '*' : ' '} ${agent.type} · ${agent.status} · ${agent.id}`)
      return { text: [`signal: ${agents.length} agent${agents.length === 1 ? '' : 's'} · * = counted as observer (${observerTypes.join(', ')})`, ...rows].join('\n') }
    }
    if (word === 'observers') {
      if (reports.size === 0) return { text: 'signal: no observer report hidden this session' }
      const listed = [...reports.values()].reverse().slice(0, LISTED)
      const head = `signal: ${reports.size} observer report${reports.size === 1 ? '' : 's'} hidden this session · newest first${reports.size > LISTED ? ` · ${LISTED} shown` : ''}`
      return { text: [head, ...listed.map(text => `\n— ${text.trim()}`)].join('\n') }
    }
    return { text: `${status()} · /${COMMAND} theme <id> · themes · observer on|off · fold on|off · audit on|off · reset · observers · agents` }
  })
}
