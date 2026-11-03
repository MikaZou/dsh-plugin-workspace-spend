/**
 * End-to-end replay check for dsh-plugin-workspace-spend against the real
 * DSH home on this machine.
 *
 * It decodes every stored session log, folds it with the plugin's own
 * `lib/spend.js`, compares token totals with the harness's persisted
 * `tokenUsage` projection cache (an independent fold), and prints the
 * per-workspace report the Settings page would show.
 *
 * Run from the package directory: node tools/verify-real-logs.mjs
 * The DSH home defaults to `~/.dsh`; set DSH_HOME to point elsewhere.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  aggregateReport,
  foldSessionEvents,
  resolveConfig,
} from '../lib/spend.js'

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const SESSIONS = path.join(DSH_HOME, 'sessions')
const STORAGES = path.join(DSH_HOME, 'storages')
const PROJCACHE = path.join(STORAGES, 'session_projcache', 'sessions')
const WORKSPACE_FILE = path.join(STORAGES, 'workspace.json')

function frameLength(buf) {
  if (buf.length < 6 || buf.readUInt32LE(0) !== 0xfd2fb528) return undefined
  const fhd = buf[4]
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictFlag = fhd & 3
  let p = 5
  if (!singleSegment) p += 1
  let fcsSize = [0, 2, 4, 8][fcsFlag]
  if (fcsFlag === 0) fcsSize = singleSegment ? 1 : 0
  p += (dictFlag === 3 ? 4 : dictFlag) + fcsSize
  if (p > buf.length) return undefined
  let last = 0
  while (!last && p + 3 <= buf.length) {
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    last = bh & 1
    const type = (bh >> 1) & 3
    const size = bh >>> 3
    p += 3
    if (type === 1) p += 1
    else if (type === 2 || type === 0) p += size
    else return undefined
    if (p > buf.length) return undefined
  }
  if (checksum) p += 4
  return last ? p : undefined
}

function decodeLog(buffer) {
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0xfd2fb528) {
    const out = []
    let rest = buffer
    while (rest.length > 0) {
      const consumed = frameLength(rest)
      if (consumed === undefined || consumed <= 0) break
      out.push(zlib.zstdDecompressSync(rest.subarray(0, consumed)))
      rest = rest.subarray(consumed)
    }
    return Buffer.concat(out).toString('utf8')
  }
  return buffer.toString('utf8')
}

function versionOf(name) {
  const match = /^session\.v(\d+)\.jsonl\.zstd$/.exec(name)
  if (match !== null) return Number(match[1])
  if (name === 'session.jsonl.zstd') return 0
  return -1
}

function walkSessionFiles() {
  const files = []
  for (const wsDir of fs.readdirSync(SESSIONS)) {
    const wsPath = path.join(SESSIONS, wsDir)
    if (!fs.statSync(wsPath).isDirectory()) continue
    for (const sessDir of fs.readdirSync(wsPath)) {
      const sessPath = path.join(SESSIONS, wsDir, sessDir)
      if (!fs.statSync(sessPath).isDirectory()) continue
      // One session directory may hold several log generations; the highest
      // version is the current one the persistence service resolves.
      const generations = fs
        .readdirSync(sessPath)
        .map((name) => ({ name, version: versionOf(name) }))
        .filter((entry) => entry.version >= 0)
        .sort((left, right) => right.version - left.version)
      if (generations.length > 0) files.push({ path: path.join(sessPath, generations[0].name), version: generations[0].version })
    }
  }
  return files
}

function readProjectionCache(sessionId) {
  const id = String(sessionId)
  const file = path.join(PROJCACHE, `${id}.json`)
  if (!fs.existsSync(file)) return undefined
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

const workspaceDoc = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8'))
const workspaces = workspaceDoc.global.workspaceIds.map((id) => {
  const row = workspaceDoc.tables.workspaces[id]
  return {
    id,
    title: row.title,
    path: row.path,
    sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds : [],
  }
})

const config = resolveConfig(undefined)
const noCompactionConfig = resolveConfig({ trackCompaction: false })
const sessions = []
const failures = []
const bucketTotals = (fold) =>
  fold.buckets.reduce(
    (sum, bucket) => ({
      uncachedInputTokens: sum.uncachedInputTokens + bucket.input,
      outputTokens: sum.outputTokens + bucket.output,
      cacheReadTokens: sum.cacheReadTokens + bucket.cacheRead,
      cacheWriteTokens: sum.cacheWriteTokens + bucket.cacheWrite,
    }),
    { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  )
const sameTokens = (left, right) =>
  left.uncachedInputTokens === right.uncachedInputTokens &&
  left.outputTokens === right.outputTokens &&
  left.cacheReadTokens === right.cacheReadTokens &&
  left.cacheWriteTokens === right.cacheWriteTokens

for (const file of walkSessionFiles()) {
  const text = decodeLog(fs.readFileSync(file.path))
  const events = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const header = events.find((event) => event.type === 'session')
  if (header === undefined) continue
  const cache = readProjectionCache(header.id)
  const inherited = Number(cache?.record?.identity?.inheritedEventCount ?? 0)
  const billingFold = foldSessionEvents(events, {
    startSeq: Number.isFinite(inherited) ? inherited : 0,
    config,
  })
  sessions.push({ sessionId: String(header.id), cwd: header.cwd, fold: billingFold, source: path.relative(SESSIONS, file.path) })

  // The harness `tokenUsage` projection excludes compaction calls and counts
  // the whole stored log (inherited fork prefix included), so compare against
  // a full-log fold with compaction disabled 鈥?an independent fold of the data.
  const expected = cache?.record?.rows?.tokenUsage?.val?.totals
  if (expected !== undefined) {
    const projectionFold = foldSessionEvents(events, { startSeq: 0, config: noCompactionConfig })
    const actual = bucketTotals(projectionFold)
    if (!sameTokens(actual, expected)) {
      failures.push({ session: header.id, version: file.version, cwd: header.cwd, expected, actual })
    }
  }
}

const report = aggregateReport({ sessions, workspaces, config, rangeDays: 0, now: Date.now() })

console.log(`sessions folded: ${sessions.length}`)
console.log(`tokenUsage projection mismatches: ${failures.length}`)
for (const failure of failures.slice(0, 10)) console.log('  MISMATCH', JSON.stringify(failure))
console.log(`\nworkspaces with usage: ${report.workspaces.length}`)
console.log(`total estimated cost: ${report.currencySymbol}${report.totals.cost}`)
console.log(`tokens: input=${report.totals.tokens.input} output=${report.totals.tokens.output} cacheRead=${report.totals.tokens.cacheRead}`)
console.log('\nper workspace:')
for (const workspace of report.workspaces) {
  console.log(
    `  ${report.currencySymbol}${workspace.cost.toFixed(4).padStart(10)}  ${workspace.title.padEnd(20)} sessions=${workspace.sessions} messages=${workspace.messages} input=${workspace.tokens.input} output=${workspace.tokens.output} cacheRead=${workspace.tokens.cacheRead}`,
  )
}
console.log('\nby model:')
for (const model of report.models) {
  console.log(`  ${report.currencySymbol}${model.cost.toFixed(4).padStart(10)}  ${model.model}  requests=${model.requests} messages=${model.messages}`)
}
console.log(`\nunpriced models: ${report.unpricedModels.length === 0 ? 'none' : report.unpricedModels.join(', ')}`)


