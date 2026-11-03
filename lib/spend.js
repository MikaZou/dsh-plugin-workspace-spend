/**
 * Pure spend accounting for the workspace-spend plugin.
 *
 * Everything here is framework-free: the Host half feeds it durable session
 * events, and the tests feed it fixtures. A session fold keeps billed token
 * buckets keyed by (Beijing calendar day, peak/idle flag, model route) so cost
 * is computed at aggregation time from the user's current price table instead
 * of being baked into a cache.
 *
 * Billing model (DeepSeek public pricing, CNY per million tokens):
 * - uncached input tokens (`inputTokens`)
 * - cache-hit input tokens (`cacheReadTokens`)
 * - cache-write tokens (`cacheWriteTokens`, usually 0 for DeepSeek)
 * - output tokens (`outputTokens`)
 * Peak hours are Beijing time (UTC+8) Monday-Friday 09:00-12:00 and
 * 14:00-18:00, excluding configured statutory-holiday dates; every other
 * moment is off-peak and billed at `offPeakDiscount` of the peak rate.
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** Peak-hour table of DeepSeek's public price list, CNY per million tokens. */
const DEFAULT_PRICES = Object.freeze({
  'deepseek-flash': Object.freeze({ input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 }),
  'deepseek-v4-pro': Object.freeze({ input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 }),
})

/** Retired model ids that the provider still serves under another identity. */
const DEFAULT_MODEL_ALIASES = Object.freeze({
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
})

/** Default plugin configuration. Row config may override any field. */
export const DEFAULT_CONFIG = Object.freeze({
  currency: 'CNY',
  currencySymbol: '¥',
  unit: 1_000_000,
  offPeakDiscount: 0.5,
  trackCompaction: true,
  prices: DEFAULT_PRICES,
  modelAliases: DEFAULT_MODEL_ALIASES,
  holidays: [],
  perCallFees: Object.freeze({}),
})

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const finiteNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const nonNegative = (value) => {
  const n = finiteNumber(value)
  return n === undefined ? undefined : Math.max(0, n)
}
const clamp01 = (value, fallback) => {
  const n = finiteNumber(value)
  return n === undefined ? fallback : Math.min(1, Math.max(0, n))
}

/**
 * Normalize the row config into the fully resolved shape used below.
 * Unknown fields are ignored; partial `prices` entries merge over defaults.
 * @param {Record<string, unknown> | undefined} raw row config.
 * @returns resolved config.
 */
export function resolveConfig(raw) {
  const input = isRecord(raw) ? raw : {}
  const prices = {}
  for (const [model, price] of Object.entries(DEFAULT_PRICES)) prices[model] = { ...price }
  if (isRecord(input.prices)) {
    for (const [model, price] of Object.entries(input.prices)) {
      if (!isRecord(price)) continue
      const base = prices[model] ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      const next = { ...base }
      for (const field of ['input', 'cacheRead', 'cacheWrite', 'output']) {
        const value = nonNegative(price[field])
        if (value !== undefined) next[field] = value
      }
      prices[model] = next
    }
  }
  const modelAliases = { ...DEFAULT_MODEL_ALIASES }
  if (isRecord(input.modelAliases)) {
    for (const [from, to] of Object.entries(input.modelAliases)) {
      if (typeof from === 'string' && typeof to === 'string' && from.length > 0 && to.length > 0) {
        modelAliases[from] = to
      }
    }
  }
  const perCallFees = {}
  if (isRecord(input.perCallFees)) {
    for (const [tool, fee] of Object.entries(input.perCallFees)) {
      const value = nonNegative(fee)
      if (value !== undefined && typeof tool === 'string') perCallFees[tool] = value
    }
  }
  const holidays = Array.isArray(input.holidays)
    ? input.holidays.filter((day) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day))
    : []
  const unit = nonNegative(input.unit)
  return {
    currency: typeof input.currency === 'string' && input.currency.trim() ? input.currency.trim() : DEFAULT_CONFIG.currency,
    currencySymbol:
      typeof input.currencySymbol === 'string' && input.currencySymbol.trim()
        ? input.currencySymbol.trim().slice(0, 4)
        : DEFAULT_CONFIG.currencySymbol,
    unit: unit !== undefined && unit > 0 ? unit : DEFAULT_CONFIG.unit,
    offPeakDiscount: clamp01(input.offPeakDiscount, DEFAULT_CONFIG.offPeakDiscount),
    trackCompaction: input.trackCompaction === undefined ? true : input.trackCompaction !== false,
    prices,
    modelAliases,
    holidays,
    holidaysSet: new Set(holidays),
    perCallFees,
  }
}

/** Stable identity of the config fields a session fold depends on. */
export function foldSignature(config) {
  return JSON.stringify({
    holidays: config.holidays,
    feeTools: Object.keys(config.perCallFees).sort(),
    trackCompaction: config.trackCompaction,
  })
}

/** Join a provider route into the `provider/model` spelling used as a key. */
export function routeKey(provider, model) {
  if (typeof model !== 'string' || model.length === 0) return undefined
  return typeof provider === 'string' && provider.length > 0 ? `${provider}/${model}` : model
}

/** The model segment of a `provider/model` route. */
export function modelOfRoute(route) {
  if (typeof route !== 'string') return undefined
  const slash = route.indexOf('/')
  return slash >= 0 ? route.slice(slash + 1) : route
}

/** Provider/model route of a stored assistant message. */
export function messageRoute(message) {
  if (!isRecord(message)) return undefined
  const source = message.source
  if (!isRecord(source)) return undefined
  return routeKey(source.provider, source.model)
}

/** Provider/model route of a `request/header` epoch header. */
export function headerRoute(header) {
  if (!isRecord(header)) return undefined
  const config = header.config
  if (!isRecord(config)) return undefined
  return routeKey(config.provider, config.model)
}

/** Beijing calendar day (`YYYY-MM-DD`) of one epoch millisecond timestamp. */
export function beijingDay(timeMs) {
  const date = new Date(timeMs + BEIJING_OFFSET_MS)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Shift a `YYYY-MM-DD` day string by whole days. */
export function shiftDay(day, deltaDays) {
  const [year, month, date] = day.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, date))
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Whether one timestamp falls in DeepSeek's Beijing peak window. */
export function isPeakTime(timeMs, holidaysSet) {
  const date = new Date(timeMs + BEIJING_OFFSET_MS)
  const day = beijingDay(timeMs)
  if (holidaysSet && holidaysSet.has(day)) return false
  const weekday = date.getUTCDay()
  if (weekday < 1 || weekday > 5) return false
  const hour = date.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/** The fold bucket key of one timestamp. */
function bucketKey(timeMs, holidaysSet) {
  return `${beijingDay(timeMs)}|${isPeakTime(timeMs, holidaysSet) ? 1 : 0}`
}

const ZERO_USAGE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, messages: 0 })

/** Normalize one provider usage report into accounting buckets. */
function usageOf(usage) {
  if (!isRecord(usage)) return undefined
  const input = nonNegative(usage.inputTokens)
  const output = nonNegative(usage.outputTokens)
  const cacheRead = nonNegative(usage.cacheReadTokens) ?? 0
  const cacheWrite = nonNegative(usage.cacheWriteTokens) ?? 0
  if (input === undefined || output === undefined) return undefined
  return { input, output, cacheRead, cacheWrite }
}

const sameUsage = (left, right) =>
  left.input === right.input &&
  left.output === right.output &&
  left.cacheRead === right.cacheRead &&
  left.cacheWrite === right.cacheWrite

/** Last usage chunk embedded in one assistant stream. */
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (!isRecord(record) || record.type !== 'chunk') continue
    const chunk = record.chunk
    if (isRecord(chunk) && chunk.type === 'usage') return chunk.usage
  }
  return undefined
}

/** The usage one durable assistant settlement reports for its attempt. */
function settlementUsage(data) {
  const direct = usageOf(data?.usage)
  if (direct !== undefined) return direct
  return usageOf(lastStreamUsage(data?.stream))
}

function addUsage(buckets, key, route, usage, delta) {
  const mapKey = `${key}|${route}`
  const current = buckets.get(mapKey) ?? { ...ZERO_USAGE }
  current.input += delta * usage.input
  current.output += delta * usage.output
  current.cacheRead += delta * usage.cacheRead
  current.cacheWrite += delta * usage.cacheWrite
  buckets.set(mapKey, current)
}

/**
 * Fold one session's durable events into spend buckets.
 *
 * Usage replacement follows the harness token-usage projection: within one
 * (turn, step), the latest provider sample replaces the previous one, and
 * `llm/retry-started` closes that replacement scope so a retried attempt is
 * billed separately. Compaction summaries carry their own billed usage.
 *
 * @param {readonly Record<string, any>[]} events ordered session events.
 * @param {{
 *   startSeq?: number,
 *   config?: ReturnType<typeof resolveConfig>,
 * }} [options] `startSeq` skips an inherited fork prefix.
 * @returns {{
 *   buckets: Array<{ day: string, peak: boolean, route: string, input: number,
 *     output: number, cacheRead: number, cacheWrite: number, requests: number,
 *     messages: number }>,
 *   fees: Array<{ day: string, peak: boolean, tool: string, count: number }>,
 *   messages: number,
 *   requests: number,
 *   firstTime: number | undefined,
 *   lastTime: number | undefined,
 * }}
 */
export function foldSessionEvents(events, options = {}) {
  const config = options.config ?? resolveConfig(undefined)
  const startSeq = options.startSeq ?? 0
  const holidaysSet = config.holidaysSet
  const feeTools = new Set(Object.keys(config.perCallFees))
  const buckets = new Map()
  const fees = new Map()
  const pendingCalls = new Map()
  let currentRoute
  let last
  let firstTime
  let lastTime

  const noteTime = (time) => {
    if (typeof time !== 'number' || !Number.isFinite(time)) return
    if (firstTime === undefined || time < firstTime) firstTime = time
    if (lastTime === undefined || time > lastTime) lastTime = time
  }
  const countOf = (map, key) => map.get(key) ?? 0
  const bump = (map, key, amount) => map.set(key, countOf(map, key) + amount)

  for (const event of events) {
    if (!isRecord(event) || typeof event.type !== 'string') continue
    const seq = Number(event.seq)
    if (Number.isFinite(seq) && seq < startSeq) continue
    noteTime(event.time)
    const data = isRecord(event.data) ? event.data : {}

    if (event.type === 'request/header') {
      const route = headerRoute(data.header)
      if (route !== undefined) currentRoute = route
      continue
    }

    if (event.type === 'llm/retry-started') {
      if (last !== undefined && last.turn === data.turn && last.step === data.step) last = undefined
      continue
    }

    if (event.type === 'tool/call') {
      if (feeTools.size > 0 && typeof data.callId === 'string' && typeof data.name === 'string' && feeTools.has(data.name)) {
        pendingCalls.set(data.callId, { tool: data.name, key: bucketKey(event.time, holidaysSet) })
      }
      continue
    }

    if (event.type === 'tool/result') {
      const callId = data?.message?.toolCallId ?? data?.callId
      if (typeof callId !== 'string') continue
      const pending = pendingCalls.get(callId)
      if (pending === undefined) continue
      pendingCalls.delete(callId)
      if (isRecord(data.error) || data.message?.isError === true) continue
      bump(fees, `${pending.key}|${pending.tool}`, 1)
      continue
    }

    if (event.type === 'compaction/summary') {
      if (!config.trackCompaction) continue
      const usage = usageOf(data.usage)
      const route = routeKey(data.provider, data.model)
      if (usage === undefined || route === undefined) continue
      const key = bucketKey(event.time, holidaysSet)
      addUsage(buckets, key, route, usage, 1)
      buckets.get(`${key}|${route}`).requests += 1
      continue
    }

    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const usage = settlementUsage(data)
    const isMessage = event.type === 'assistant/message'
    const route = (isMessage ? messageRoute(data.message) : undefined) ?? currentRoute
    if (usage === undefined || route === undefined) continue
    const turn = typeof data.turn === 'number' ? data.turn : undefined
    const step = typeof data.step === 'number' ? data.step : undefined
    const key = bucketKey(event.time, holidaysSet)
    const previous = last !== undefined && last.turn === turn && last.step === step ? last : undefined
    if (previous !== undefined && previous.route === route && sameUsage(previous.usage, usage)) {
      if (isMessage && previous.messages === 0) {
        const entry = buckets.get(`${previous.key}|${route}`)
        if (entry !== undefined) {
          entry.messages += 1
          previous.messages = 1
        }
      }
      continue
    }
    if (previous !== undefined) {
      addUsage(buckets, previous.key, previous.route, previous.usage, -1)
      const previousEntry = buckets.get(`${previous.key}|${previous.route}`)
      if (previousEntry !== undefined) {
        previousEntry.requests -= previous.requests
        previousEntry.messages -= previous.messages
      }
    }
    addUsage(buckets, key, route, usage, 1)
    const entry = buckets.get(`${key}|${route}`)
    entry.requests += 1
    if (isMessage) entry.messages += 1
    last = { turn, step, route, usage, key, requests: 1, messages: isMessage ? 1 : 0 }
  }

  const bucketsOut = [...buckets.entries()]
    .map(([mapKey, usage]) => {
      const [key, route] = splitBucketKey(mapKey)
      const [day, peakFlag] = key.split('|')
      return { day, peak: peakFlag === '1', route, ...usage }
    })
    .filter(
      (bucket) =>
        bucket.requests > 0 ||
        bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite > 0,
    )

  return {
    buckets: bucketsOut,
    fees: [...fees.entries()].map(([mapKey, count]) => {
      const [key, tool] = splitBucketKey(mapKey)
      const [day, peakFlag] = key.split('|')
      return { day, peak: peakFlag === '1', tool, count }
    }),
    messages: bucketsOut.reduce((sum, bucket) => sum + bucket.messages, 0),
    requests: bucketsOut.reduce((sum, bucket) => sum + bucket.requests, 0),
    firstTime,
    lastTime,
  }
}

/** Split a `<day>|<peak>|<name>` map key at its first two separators. */
function splitBucketKey(mapKey) {
  const first = mapKey.indexOf('|')
  const second = mapKey.indexOf('|', first + 1)
  return [mapKey.slice(0, second), mapKey.slice(second + 1)]
}

/**
 * Resolve the price entry for one route.
 * Exact `provider/model` keys win, then the model id, then a model alias.
 * @param {ReturnType<typeof resolveConfig>} config resolved config.
 * @param {string} route `provider/model` (or a bare model id).
 * @returns {{ model: string, rate: { input: number, cacheRead: number, cacheWrite: number, output: number } } | undefined}
 */
export function resolvePrice(config, route) {
  if (typeof route !== 'string' || route.length === 0) return undefined
  if (config.prices[route] !== undefined) return { model: route, rate: config.prices[route] }
  const model = modelOfRoute(route)
  if (model === undefined) return undefined
  if (config.prices[model] !== undefined) return { model, rate: config.prices[model] }
  const alias = config.modelAliases[model]
  if (alias !== undefined && config.prices[alias] !== undefined) {
    return { model: alias, rate: config.prices[alias] }
  }
  return undefined
}

/** Price one token bucket in `config.currency`. */
export function priceUsage(config, rate, usage, peak) {
  const amount =
    (usage.input * rate.input +
      usage.cacheRead * rate.cacheRead +
      usage.cacheWrite * rate.cacheWrite +
      usage.output * rate.output) /
    config.unit
  return amount * (peak ? 1 : config.offPeakDiscount)
}

/** Normalize a requested range into whole days: 0 means all time. */
export function normalizeRangeDays(value) {
  if (value === undefined || value === null || value === '' || value === 'all') return 0
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(36500, Math.floor(n))
}

const EMPTY_TOKENS = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

function addTokens(target, bucket) {
  target.input += bucket.input
  target.output += bucket.output
  target.cacheRead += bucket.cacheRead
  target.cacheWrite += bucket.cacheWrite
}

function roundAmount(value) {
  return Math.round(value * 1e6) / 1e6
}

/** Normalize a filesystem path for workspace matching. */
function normalizePath(value) {
  if (typeof value !== 'string') return undefined
  return value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}

/** Final path segment used as a display title for unregistered directories. */
function basenameOf(value) {
  if (typeof value !== 'string' || value.length === 0) return 'unknown'
  const parts = value.split(/[\\/]+/).filter((part) => part.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : value
}

/**
 * Build the full report from folded sessions.
 * @param {{
 *   sessions: readonly { sessionId: string, cwd?: string, fold: ReturnType<typeof foldSessionEvents> }[],
 *   workspaces: readonly { id: string, title: string, path: string, sessionIds: readonly string[] }[],
 *   config: ReturnType<typeof resolveConfig>,
 *   rangeDays?: number,
 *   now?: number,
 * }} input report input.
 */
export function aggregateReport(input) {
  const config = input.config
  const now = input.now ?? Date.now()
  const rangeDays = normalizeRangeDays(input.rangeDays)
  const today = beijingDay(now)
  const sinceDay = rangeDays > 0 ? shiftDay(today, -(rangeDays - 1)) : undefined
  const inRange = (day) => sinceDay === undefined || day >= sinceDay

  const bySessionId = new Map()
  for (const workspace of input.workspaces) {
    for (const sessionId of workspace.sessionIds) bySessionId.set(String(sessionId), workspace)
  }
  const byPath = [...input.workspaces]
    .map((workspace) => ({ workspace, key: normalizePath(workspace.path) }))
    .filter((entry) => entry.key !== undefined)
    .sort((left, right) => right.key.length - left.key.length)

  const workspaceOf = (session) => {
    const direct = bySessionId.get(String(session.sessionId))
    if (direct !== undefined) return direct
    const cwd = normalizePath(session.cwd)
    if (cwd !== undefined) {
      for (const entry of byPath) {
        if (cwd === entry.key || cwd.startsWith(entry.key + '\\')) return entry.workspace
      }
    }
    return undefined
  }

  const workspacesByKey = new Map()
  const modelsByKey = new Map()
  const totals = {
    cost: 0,
    sessions: 0,
    requests: 0,
    messages: 0,
    tokens: EMPTY_TOKENS(),
    unpricedTokens: 0,
    unpricedRequests: 0,
  }
  const unpricedModels = new Set()

  const workspaceSlot = (key, workspace, unattributed) => {
    let slot = workspacesByKey.get(key)
    if (slot === undefined) {
      slot = {
        key,
        id: workspace?.id,
        title: workspace?.title ?? key,
        path: workspace?.path,
        unattributed,
        cost: 0,
        requests: 0,
        messages: 0,
        sessions: 0,
        tokens: EMPTY_TOKENS(),
        unpricedTokens: 0,
        unpricedRequests: 0,
        models: new Map(),
      }
      workspacesByKey.set(key, slot)
    }
    return slot
  }

  const modelSlot = (ownerMap, key, display, priced) => {
    let slot = ownerMap.get(key)
    if (slot === undefined) {
      slot = { key, model: display, priced, cost: 0, requests: 0, messages: 0, calls: 0, tokens: EMPTY_TOKENS() }
      ownerMap.set(key, slot)
    }
    return slot
  }

  for (const session of input.sessions) {
    const workspace = workspaceOf(session)
    const workspaceKey = workspace !== undefined ? `ws:${String(workspace.id)}` : `cwd:${normalizePath(session.cwd) ?? 'unknown'}`
    const derivedWorkspace = workspace ?? { id: undefined, title: basenameOf(session.cwd), path: session.cwd }
    let countedSession = false
    const sessionSlot = () => {
      const slot = workspaceSlot(workspaceKey, derivedWorkspace, workspace === undefined)
      if (!countedSession) {
        slot.sessions += 1
        countedSession = true
      }
      return slot
    }

    for (const bucket of session.fold.buckets) {
      if (!inRange(bucket.day)) continue
      const wsSlot = sessionSlot()
      const priced = resolvePrice(config, bucket.route)
      const tokenUsage = { input: bucket.input, output: bucket.output, cacheRead: bucket.cacheRead, cacheWrite: bucket.cacheWrite }
      addTokens(wsSlot.tokens, tokenUsage)
      wsSlot.requests += bucket.requests
      wsSlot.messages += bucket.messages
      const display = priced?.model ?? bucket.route
      if (priced === undefined) {
        wsSlot.unpricedTokens += tokenUsage.input + tokenUsage.output + tokenUsage.cacheRead + tokenUsage.cacheWrite
        wsSlot.unpricedRequests += bucket.requests
        totals.unpricedTokens += tokenUsage.input + tokenUsage.output + tokenUsage.cacheRead + tokenUsage.cacheWrite
        totals.unpricedRequests += bucket.requests
        unpricedModels.add(bucket.route)
      }
      const wsModel = modelSlot(wsSlot.models, `${priced === undefined ? 'unpriced:' : 'model:'}${display}`, display, priced !== undefined)
      addTokens(wsModel.tokens, tokenUsage)
      wsModel.requests += bucket.requests
      wsModel.messages += bucket.messages
      if (priced !== undefined) {
        const amount = priceUsage(config, priced.rate, bucket, bucket.peak)
        wsSlot.cost += amount
        wsModel.cost += amount
        totals.cost += amount
        let globalModel = modelsByKey.get(display)
        if (globalModel === undefined) {
          globalModel = { key: display, model: display, priced: true, cost: 0, requests: 0, messages: 0, calls: 0, tokens: EMPTY_TOKENS() }
          modelsByKey.set(display, globalModel)
        }
        globalModel.cost += amount
        globalModel.requests += bucket.requests
        globalModel.messages += bucket.messages
        addTokens(globalModel.tokens, tokenUsage)
      } else {
        let globalModel = modelsByKey.get(display)
        if (globalModel === undefined) {
          globalModel = { key: display, model: display, priced: false, cost: 0, requests: 0, messages: 0, calls: 0, tokens: EMPTY_TOKENS() }
          modelsByKey.set(display, globalModel)
        }
        globalModel.requests += bucket.requests
        globalModel.messages += bucket.messages
        addTokens(globalModel.tokens, tokenUsage)
      }
      totals.tokens.input += tokenUsage.input
      totals.tokens.output += tokenUsage.output
      totals.tokens.cacheRead += tokenUsage.cacheRead
      totals.tokens.cacheWrite += tokenUsage.cacheWrite
      totals.requests += bucket.requests
      totals.messages += bucket.messages
    }

    for (const fee of session.fold.fees) {
      if (!inRange(fee.day)) continue
      const unitFee = config.perCallFees[fee.tool]
      if (unitFee === undefined) continue
      const amount = unitFee * (fee.peak ? 1 : config.offPeakDiscount) * fee.count
      const wsSlot = sessionSlot()
      wsSlot.cost += amount
      totals.cost += amount
      const display = `tool:${fee.tool}`
      const wsModel = modelSlot(wsSlot.models, `tool:${fee.tool}`, display, true)
      wsModel.calls += fee.count
      wsModel.cost += amount
      let globalModel = modelsByKey.get(display)
      if (globalModel === undefined) {
        globalModel = { key: display, model: display, priced: true, cost: 0, requests: 0, messages: 0, calls: 0, tokens: EMPTY_TOKENS() }
        modelsByKey.set(display, globalModel)
      }
      globalModel.calls += fee.count
      globalModel.cost += amount
    }

    if (countedSession) totals.sessions += 1
  }

  const finishSlot = (slot) => {
    const models = [...slot.models.values()]
      .map((model) => ({ ...model, tokens: { ...model.tokens } }))
      .sort((left, right) => right.cost - left.cost || right.requests - left.requests)
    return {
      ...slot,
      cost: roundAmount(slot.cost),
      tokens: { ...slot.tokens },
      models,
      modelsTotal: models.length,
    }
  }

  const workspaces = [...workspacesByKey.values()]
    .map(finishSlot)
    .sort((left, right) => right.cost - left.cost || right.tokens.input - left.tokens.input || right.messages - left.messages)

  const models = [...modelsByKey.values()]
    .map((model) => ({ ...model, cost: roundAmount(model.cost), tokens: { ...model.tokens } }))
    .sort((left, right) => right.cost - left.cost || right.requests - left.requests)

  return {
    generatedAt: now,
    range: { days: rangeDays, sinceDay, today },
    currency: config.currency,
    currencySymbol: config.currencySymbol,
    unit: config.unit,
    totals: {
      cost: roundAmount(totals.cost),
      currency: config.currency,
      currencySymbol: config.currencySymbol,
      sessions: totals.sessions,
      requests: totals.requests,
      messages: totals.messages,
      tokens: totals.tokens,
      unpricedTokens: totals.unpricedTokens,
      unpricedRequests: totals.unpricedRequests,
      priced: totals.unpricedTokens === 0,
    },
    workspaces,
    models,
    unpricedModels: [...unpricedModels].sort(),
    pricing: {
      currency: config.currency,
      unit: config.unit,
      offPeakDiscount: config.offPeakDiscount,
      trackCompaction: config.trackCompaction,
      holidayCount: config.holidays.length,
      rates: Object.entries(config.prices)
        .map(([model, rate]) => ({ model, ...rate }))
        .sort((left, right) => left.model.localeCompare(right.model)),
      perCallFees: Object.entries(config.perCallFees).map(([tool, fee]) => ({ tool, fee })),
    },
  }
}
