import { describe, expect, test } from 'bun:test'
import {
  FOLDED_KINDS,
  foldsNotification,
  hashOf,
  isObserverOrigin,
  narrationFallbackOnBlock,
  narrationMarkedOf,
  narrationOf,
  narrationSummary,
  narrationTextsOfChunk,
  notificationKindLabel,
  notificationLooksFailed,
  notificationSummary,
  reportKey,
  stableIdOf,
} from '../../hooks/fold.ts'

// SPEC §5: the narration and notification decisions as pure functions.

const input = (over: Partial<Parameters<typeof narrationOf>[0]> = {}) => ({ fold: true, marked: true, open: false, isCard: false, ...over })

describe('narrationOf', () => {
  test('a marked block folds while the fold is on and closed', () => {
    expect(narrationOf(input())).toBe('folded')
  })

  test('the preference off draws every block whole', () => {
    expect(narrationOf(input({ fold: false }))).toBe('full')
  })

  test('no tool call followed it, so it is the turn’s answer and not narration', () => {
    expect(narrationOf(input({ marked: false }))).toBe('full')
  })

  test('`[show]` opens it', () => {
    expect(narrationOf(input({ open: true }))).toBe('full')
  })

  test('a card is the signal: a tool call after it does not make it noise', () => {
    expect(narrationOf(input({ isCard: true }))).toBe('full')
  })
})

describe('narrationMarkedOf', () => {
  test('marked by id', () => {
    expect(narrationMarkedOf('msg_1', 'hello', new Set(['msg_1']), new Set())).toBe(true)
  })

  test('marked by text when turn.step had no requestId', () => {
    expect(narrationMarkedOf('msg_1', 'hello', new Set(), new Set(['hello']))).toBe(true)
  })

  test('unmarked when neither matches', () => {
    expect(narrationMarkedOf('msg_1', 'hello', new Set(['msg_2']), new Set(['bye']))).toBe(false)
  })
})

describe('narrationTextsOfChunk', () => {
  test('text before a tool chunk in the same step is narration', () => {
    let blocks = new Map<number, string>()
    ;({ blocks } = narrationTextsOfChunk(blocks, { kind: 'text', index: 0, text: 'Let me look.' }))
    const tool = narrationTextsOfChunk(blocks, { kind: 'tool', index: 1 })
    expect(tool.texts).toEqual(['Let me look.'])
  })

  test('accumulates streamed text on the same block index', () => {
    let blocks = new Map<number, string>()
    ;({ blocks } = narrationTextsOfChunk(blocks, { kind: 'text', index: 0, text: 'Let ' }))
    ;({ blocks } = narrationTextsOfChunk(blocks, { kind: 'text', index: 0, text: 'me look.' }))
    const tool = narrationTextsOfChunk(blocks, { kind: 'tool', index: 1 })
    expect(tool.texts).toEqual(['Let me look.'])
  })

  test('only blocks before the tool index count', () => {
    let blocks = new Map<number, string>()
    ;({ blocks } = narrationTextsOfChunk(blocks, { kind: 'text', index: 0, text: 'narration' }))
    ;({ blocks } = narrationTextsOfChunk(blocks, { kind: 'text', index: 2, text: 'after tool' }))
    const tool = narrationTextsOfChunk(blocks, { kind: 'tool', index: 1 })
    expect(tool.texts).toEqual(['narration'])
  })

  test('empty text blocks are skipped', () => {
    let blocks = new Map<number, string>()
    ;({ blocks } = narrationTextsOfChunk(blocks, { kind: 'text', index: 0, text: '   \n' }))
    const tool = narrationTextsOfChunk(blocks, { kind: 'tool', index: 1 })
    expect(tool.texts).toEqual([])
  })
})

describe('narrationFallbackOnBlock', () => {
  test('the first non-card block becomes the candidate', () => {
    expect(narrationFallbackOnBlock(undefined, 'a', false)).toEqual({ candidate: 'a', confirmed: [] })
  })

  test('a card is never a candidate', () => {
    expect(narrationFallbackOnBlock(undefined, 'a', true)).toEqual({ candidate: undefined, confirmed: [] })
  })

  test('a later block confirms the previous candidate', () => {
    expect(narrationFallbackOnBlock('a', 'b', false)).toEqual({ candidate: 'b', confirmed: ['a'] })
  })

  test('the same block redrawn does not confirm itself', () => {
    expect(narrationFallbackOnBlock('a', 'a', false)).toEqual({ candidate: 'a', confirmed: [] })
  })
})

describe('narrationSummary', () => {
  test('counts the non-empty lines', () => {
    expect(narrationSummary('one\ntwo\n\nthree')).toBe('· narration · 3 lines')
  })

  test('one line is singular', () => {
    expect(narrationSummary('Let me look at the second copy.')).toBe('· narration · 1 line')
  })
})

describe('foldsNotification', () => {
  test('every delivered kind folds', () => {
    for (const kind of FOLDED_KINDS) expect(foldsNotification(kind)).toBe(true)
  })

  test('the five are the whole set', () => {
    expect([...FOLDED_KINDS]).toEqual(['task-notification', 'peer', 'peer-send-message', 'scheduled-trigger', 'projects-relay'])
  })

  test("the reader's own traffic passes through untouched", () => {
    for (const kind of ['composer', 'bridge', 'sdk', 'channel']) expect(foldsNotification(kind)).toBe(false)
  })

  test('an unknown kind passes through rather than being guessed at', () => {
    expect(foldsNotification('coordinator')).toBe(false)
    expect(foldsNotification('something-new')).toBe(false)
  })

  test('an observer report is hidden, never folded', () => {
    expect(foldsNotification('observer')).toBe(false)
  })
})

describe('notificationLooksFailed', () => {
  test('failure words and non-zero exit codes', () => {
    expect(notificationLooksFailed('e2e: 3 fail')).toBe(true)
    expect(notificationLooksFailed('task failed')).toBe(true)
    expect(notificationLooksFailed('failing fast')).toBe(true)
    expect(notificationLooksFailed('an error occurred')).toBe(true)
    expect(notificationLooksFailed('blocked by policy')).toBe(true)
    expect(notificationLooksFailed('uncaught exception')).toBe(true)
    expect(notificationLooksFailed('request timed out')).toBe(true)
    expect(notificationLooksFailed('connection timeout')).toBe(true)
    expect(notificationLooksFailed('exit code 3')).toBe(true)
    expect(notificationLooksFailed('exit status 1')).toBe(true)
    expect(notificationLooksFailed('exited with 2')).toBe(true)
  })

  test('benign text and zero exit codes', () => {
    expect(notificationLooksFailed('all green')).toBe(false)
    expect(notificationLooksFailed('errorless run')).toBe(false)
    expect(notificationLooksFailed('exit code 0')).toBe(false)
    expect(notificationLooksFailed('exit status 0')).toBe(false)
    expect(notificationLooksFailed('exited with 0')).toBe(false)
  })
})

describe('notificationKindLabel', () => {
  test('each folded kind reads as words', () => {
    expect(notificationKindLabel('task-notification')).toBe('background task')
    expect(notificationKindLabel('peer')).toBe('another session')
    expect(notificationKindLabel('peer-send-message')).toBe('message from a session')
    expect(notificationKindLabel('scheduled-trigger')).toBe('scheduled trigger')
    expect(notificationKindLabel('projects-relay')).toBe('relayed message')
    expect(notificationKindLabel('observer')).toBe('observer report')
  })

  test('an unknown kind keeps its own name', () => {
    expect(notificationKindLabel('something-new')).toBe('something-new')
  })

  test('the folded line names the kind', () => {
    expect(notificationSummary('task-notification')).toBe('· background task ·')
  })
})

describe('isObserverOrigin', () => {
  test('only the observer kind', () => {
    expect(isObserverOrigin('observer')).toBe(true)
    expect(isObserverOrigin('observer-activity')).toBe(false)
    expect(isObserverOrigin('peer')).toBe(false)
  })
})

describe('reportKey', () => {
  test('two drawings of one report share a key', () => {
    expect(reportKey('claim without a check: 42/42')).toBe(reportKey('claim without a check: 42/42'))
  })

  test('spacing and wrapping do not make a second report', () => {
    expect(reportKey('claim without\n  a check')).toBe(reportKey('claim without a check'))
  })

  test('two reports keep two keys', () => {
    expect(reportKey('claim A')).not.toBe(reportKey('claim B'))
  })
})

describe('stableIdOf', () => {
  test("the engine's instance id is used when there is one", () => {
    expect(stableIdOf('msg_017', 'anything')).toBe('msg_017')
  })

  test('without one the text gives a stable id', () => {
    expect(stableIdOf(undefined, 'the same block')).toBe(stableIdOf(undefined, 'the same block'))
    expect(stableIdOf(undefined, 'one block')).not.toBe(stableIdOf(undefined, 'another block'))
  })

  test('the fallback id is not mistakable for a hash of nothing', () => {
    expect(stableIdOf(undefined, 'x')).toMatch(/^t[0-9a-z]+$/)
  })
})

describe('hashOf', () => {
  test('stable, and different for different texts', () => {
    expect(hashOf('signal')).toBe(hashOf('signal'))
    expect(hashOf('signal')).not.toBe(hashOf('signal '))
  })

  test('the empty text hashes too', () => {
    expect(hashOf('')).toMatch(/^[0-9a-z]+$/)
  })
})
