/**
 * Offline tests for the workspace-spend accounting fold and report assembly.
 * Run with: node test/spend.test.mjs
 */
import assert from 'node:assert/strict'
import {
  aggregateReport,
  beijingDay,
  foldSessionEvents,
  foldSignature,
  isPeakTime,
  normalizeRangeDays,
  resolveConfig,
  resolvePrice,
  shiftDay,
} from '../lib/spend.js'

// 2026-11-03 is a Tuesday. 02:00Z = 10:00 Beijing (peak); 12:00Z = 20:00 (idle).
const PEAK = Date.UTC(2026, 10, 3, 2, 0, 0)
const IDLE = Date.UTC(2026, 10, 3, 12, 0, 0)
const NOW = Date.UTC(2026, 10, 3, 13, 0, 0) // 21:00 Beijing, 2026-11-03

const config = resolveConfig(undefined)
const workspace = { id: 'w1', title: 'Work', path: 'D:\\work\\a', sessionIds: ['s1'] }

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
})

const mk = (type, seq, time, data) => ({ type, seq, time, data })

const message = (seq, turn, step, provider, model, time, tokens) => {
  const data = {
    turn,
    step,
    message: { role: 'assistant', source: { kind: 'model', provider, model } },
    usage: tokens,
    stream: [],
  }
  return mk('assistant/message', seq, time, data)
}

const attempt = (seq, turn, step, time, tokens) =>
  mk('assistant/attempt', seq, time, { turn, step, stream: [], usage: tokens })

const report = (fold, options = {}) =>
  aggregateReport({
    sessions: [{ sessionId: 's1', cwd: 'D:\\work\\a', fold }],
    workspaces: [workspace],
    config,
    rangeDays: 0,
    now: NOW,
    ...options,
  })

const header = (seq, provider = 'deepseek-official', model = 'deepseek-flash') =>
  mk('request/header', seq, PEAK, { header: { config: { provider, model } }, reason: 'initial' })

// --- pricing resolution ----------------------------------------------------
{
  assert.deepEqual(resolvePrice(config, 'deepseek-official/deepseek-flash'), {
    model: 'deepseek-flash',
    rate: config.prices['deepseek-flash'],
  })
  assert.equal(resolvePrice(config, 'deepseek-account/deepseek-v4-flash').model, 'deepseek-flash')
  assert.equal(resolvePrice(config, 'deepseek-official/deepseek-v4-flash-vision-exp').model, 'deepseek-flash')
  assert.equal(resolvePrice(config, 'deepseek-official/deepseek-v4-pro').model, 'deepseek-v4-pro')
  assert.equal(resolvePrice(config, 'custom/unknown-model'), undefined)
  assert.equal(resolvePrice(config, 'tool:web_search'), undefined)
}

// --- peak window -----------------------------------------------------------
{
  assert.equal(isPeakTime(PEAK, new Set()), true)
  assert.equal(isPeakTime(Date.UTC(2026, 10, 3, 4, 30, 0), new Set()), false) // 12:30 Beijing
  assert.equal(isPeakTime(Date.UTC(2026, 10, 7, 2, 0, 0), new Set()), false) // Saturday
  assert.equal(isPeakTime(PEAK, new Set(['2026-11-03'])), false) // configured holiday
  assert.equal(beijingDay(PEAK), '2026-11-03')
  assert.equal(shiftDay('2026-11-03', -6), '2026-10-28')
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31')
  assert.equal(normalizeRangeDays(undefined), 0)
  assert.equal(normalizeRangeDays('7'), 7)
  assert.equal(normalizeRangeDays('-3'), 0)
  assert.equal(normalizeRangeDays('abc'), 0)
}

// --- basic peak pricing ----------------------------------------------------
{
  const fold = foldSessionEvents(
    [
      mk('request/header', 0, PEAK, { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } }, reason: 'initial' }),
      message(1, 0, 0, 'deepseek-official', 'deepseek-flash', PEAK, usage(1_000_000, 500_000)),
    ],
    { config },
  )
  assert.equal(fold.requests, 1)
  assert.equal(fold.messages, 1)
  const priced = report(fold)
  assert.equal(priced.totals.cost, 6) // 1M input * 2 + 0.5M output * 8
  assert.equal(priced.workspaces.length, 1)
  assert.equal(priced.workspaces[0].key, 'ws:w1')
  assert.equal(priced.workspaces[0].sessions, 1)
  assert.equal(priced.totals.tokens.input, 1_000_000)
  assert.equal(priced.totals.tokens.output, 500_000)
}

// --- off-peak discount -----------------------------------------------------
{
  const fold = foldSessionEvents(
    [message(0, 0, 0, 'deepseek-official', 'deepseek-flash', IDLE, usage(1_000_000, 0))],
    { config },
  )
  assert.equal(report(fold).totals.cost, 1) // 2 * 0.5
}

// --- cache-hit pricing -----------------------------------------------------
{
  const fold = foldSessionEvents(
    [message(0, 0, 0, 'deepseek-official', 'deepseek-flash', PEAK, usage(0, 0, 1_000_000, 0))],
    { config },
  )
  assert.equal(report(fold).totals.cost, 0.04)
}

// --- same-attempt replacement ---------------------------------------------
{
  const fold = foldSessionEvents(
    [
      header(0),
      attempt(1, 0, 0, PEAK, usage(10, 1)),
      message(2, 0, 0, 'deepseek-official', 'deepseek-flash', PEAK, usage(1_000_000, 0)),
    ],
    { config },
  )
  assert.equal(fold.requests, 1)
  const tokens = fold.buckets.reduce((sum, bucket) => sum + bucket.input, 0)
  assert.equal(tokens, 1_000_000)
}

// --- retry bills each attempt ---------------------------------------------
{
  const fold = foldSessionEvents(
    [
      header(0),
      attempt(1, 0, 0, PEAK, usage(100_000, 0)),
      mk('llm/retry-started', 2, PEAK, { retryId: 'r1', turn: 0, step: 0, retry: 1 }),
      attempt(3, 0, 0, PEAK, usage(200_000, 0)),
      message(4, 0, 0, 'deepseek-official', 'deepseek-flash', PEAK, usage(300_000, 0)),
    ],
    { config },
  )
  assert.equal(fold.requests, 2) // billed attempt #1 + the replacing final attempt
  assert.equal(fold.messages, 1)
  const tokens = fold.buckets.reduce((sum, bucket) => sum + bucket.input, 0)
  assert.equal(tokens, 400_000) // 100k retried + 300k final
}

// --- forked prefix ---------------------------------------------------------
{
  const fold = foldSessionEvents(
    [
      message(0, 0, 0, 'deepseek-official', 'deepseek-flash', PEAK, usage(1_000_000, 0)),
      message(1, 0, 1, 'deepseek-official', 'deepseek-flash', PEAK, usage(2_000_000, 0)),
      message(2, 0, 2, 'deepseek-official', 'deepseek-flash', PEAK, usage(3_000_000, 0)),
    ],
    { config, startSeq: 2 },
  )
  assert.equal(fold.requests, 1)
  assert.equal(fold.buckets.reduce((sum, bucket) => sum + bucket.input, 0), 3_000_000)
}

// --- compaction usage ------------------------------------------------------
{
  const fold = foldSessionEvents(
    [
      mk('compaction/summary', 0, PEAK, {
        provider: 'deepseek-account',
        model: 'deepseek-flash',
        usage: usage(1_000_000, 0),
        rawOutput: [],
        compactionId: 'c1',
      }),
    ],
    { config },
  )
  assert.equal(fold.requests, 1)
  assert.equal(fold.messages, 0)
  assert.equal(report(fold).totals.cost, 2)
}

// --- model alias -----------------------------------------------------------
{
  const fold = foldSessionEvents(
    [message(0, 0, 0, 'deepseek-official', 'deepseek-v4-flash', PEAK, usage(1_000_000, 0))],
    { config },
  )
  const priced = report(fold)
  assert.equal(priced.totals.cost, 2)
  assert.equal(priced.models[0].model, 'deepseek-flash')
}

// --- unpriced model --------------------------------------------------------
{
  const fold = foldSessionEvents(
    [message(0, 0, 0, 'custom', 'unknown-model', PEAK, usage(1_000_000, 500_000))],
    { config },
  )
  const priced = report(fold)
  assert.equal(priced.totals.cost, 0)
  assert.deepEqual(priced.unpricedModels, ['custom/unknown-model'])
  assert.equal(priced.totals.priced, false)
  assert.equal(priced.totals.tokens.input, 1_000_000)
  assert.equal(priced.workspaces[0].unpricedTokens, 1_500_000)
}

// --- range filtering -------------------------------------------------------
{
  const older = Date.UTC(2026, 9, 26, 2, 0, 0) // Monday 2026-10-26 10:00 Beijing, outside a 7-day range
  const fold = foldSessionEvents(
    [
      message(0, 0, 0, 'deepseek-official', 'deepseek-flash', older, usage(1_000_000, 0)),
      message(1, 0, 1, 'deepseek-official', 'deepseek-flash', PEAK, usage(1_000_000, 0)),
    ],
    { config },
  )
  const all = report(fold, { rangeDays: 0 })
  assert.equal(all.totals.cost, 4)
  assert.equal(all.totals.sessions, 1)
  const week = report(fold, { rangeDays: 7 })
  assert.equal(week.totals.cost, 2)
  assert.equal(week.range.sinceDay, '2026-10-28')
  const today = report(fold, { rangeDays: 1 })
  assert.equal(today.totals.cost, 2)
}

// --- workspace matching by directory ---------------------------------------
{
  const fold = foldSessionEvents(
    [message(0, 0, 0, 'deepseek-official', 'deepseek-flash', PEAK, usage(1_000_000, 0))],
    { config },
  )
  const priced = aggregateReport({
    sessions: [{ sessionId: 's-new', cwd: 'D:\\work\\a\\nested', fold }],
    workspaces: [{ id: 'w1', title: 'Work', path: 'D:\\work\\a', sessionIds: [] }],
    config,
    rangeDays: 0,
    now: NOW,
  })
  assert.equal(priced.workspaces.length, 1)
  assert.equal(priced.workspaces[0].title, 'Work')
  assert.equal(priced.workspaces[0].unattributed, false)

  const orphan = aggregateReport({
    sessions: [{ sessionId: 's-orphan', cwd: 'E:\\elsewhere\\project', fold }],
    workspaces: [],
    config,
    rangeDays: 0,
    now: NOW,
  })
  assert.equal(orphan.workspaces.length, 1)
  assert.equal(orphan.workspaces[0].unattributed, true)
  assert.equal(orphan.workspaces[0].title, 'project')
}

// --- per-call fees ---------------------------------------------------------
{
  const feeConfig = resolveConfig({ perCallFees: { web_search: 0.005, web_fetch: 0.005 } })
  const feeFold = (time, failed) =>
    foldSessionEvents(
      [
        mk('tool/call', 0, time, { turn: 0, step: 0, callId: 'c1', name: 'web_search', arguments: '{}' }),
        mk('tool/result', 1, time, {
          turn: 0,
          step: 0,
          message: { role: 'tool', toolCallId: 'c1', isError: failed },
          ...(failed ? { error: { name: 'Error', code: 'FAILED' } } : {}),
        }),
      ],
      { config: feeConfig },
    )
  const peakFee = aggregateReport({
    sessions: [{ sessionId: 's1', cwd: 'D:\\work\\a', fold: feeFold(PEAK, false) }],
    workspaces: [workspace],
    config: feeConfig,
    rangeDays: 0,
    now: NOW,
  })
  assert.equal(peakFee.totals.cost, 0.005)
  assert.equal(peakFee.models[0].calls, 1)

  const idleFee = aggregateReport({
    sessions: [{ sessionId: 's1', cwd: 'D:\\work\\a', fold: feeFold(IDLE, false) }],
    workspaces: [workspace],
    config: feeConfig,
    rangeDays: 0,
    now: NOW,
  })
  assert.equal(idleFee.totals.cost, 0.0025)

  const failedFee = aggregateReport({
    sessions: [{ sessionId: 's1', cwd: 'D:\\work\\a', fold: feeFold(PEAK, true) }],
    workspaces: [workspace],
    config: feeConfig,
    rangeDays: 0,
    now: NOW,
  })
  assert.equal(failedFee.totals.cost, 0)
}

// --- fold signature --------------------------------------------------------
{
  const a = resolveConfig({ holidays: ['2026-11-03'] })
  const b = resolveConfig({ perCallFees: { web_search: 0.005 } })
  assert.notEqual(foldSignature(a), foldSignature(config))
  assert.notEqual(foldSignature(b), foldSignature(config))
  assert.equal(foldSignature(resolveConfig(undefined)), foldSignature(config))
}

// --- empty / malformed input ----------------------------------------------
{
  assert.doesNotThrow(() => foldSessionEvents([], { config }))
  assert.doesNotThrow(() => foldSessionEvents([null, {}, { type: 'unknown' }], { config }))
  const empty = aggregateReport({ sessions: [], workspaces: [], config, rangeDays: 0, now: NOW })
  assert.equal(empty.workspaces.length, 0)
  assert.equal(empty.totals.cost, 0)
}

console.log('workspace-spend: all tests passed')
