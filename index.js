/**
 * Host half of `dsh-plugin-workspace-spend`.
 *
 * It derives billed spend per Workspace from the durable Session logs plus the
 * live Session store, prices the provider-reported token usage with the
 * plugin's price table (DeepSeek public prices by default), and serves the
 * report to its own Client half over one authenticated exact Fetch route:
 *
 *   GET /api/workspace-spend?days=<0|1|7|30|...>
 *
 * The report is computed from the log, never stored: session folds are cached
 * in memory and invalidated by each session's persistence revision (or live
 * sequence) so repeated page loads only re-read changed sessions.
 */
import {
  aggregateReport,
  foldSessionEvents,
  foldSignature,
  normalizeRangeDays,
  resolveConfig,
} from './lib/spend.js'

export const name = 'workspace-spend'

/** Required host services: durable session logs and the Workspace registry. */
export const inject = ['sessionPersistence', 'workspaceRegistry']

/** The one exact route the Client half reads. */
const REPORT_PATH = '/api/workspace-spend'

const EMPTY_FOLD = Object.freeze({
  buckets: [],
  fees: [],
  messages: 0,
  requests: 0,
  firstTime: undefined,
  lastTime: undefined,
})

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

function errorResponse(status, code, message) {
  return jsonResponse({ ok: false, error: { code, message } }, status)
}

function snapshotHeaderId(header) {
  return header?.id === undefined ? undefined : String(header.id)
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const signature = foldSignature(config)
  /** @type {Map<string, { key: string, entry: { sessionId: string, cwd?: string, fold: any } }>} */
  const cache = new Map()
  let folding

  const readLiveFold = (session) => {
    const events = session.snapshotEvents()
    const inherited = Number(session.inheritedEventCount)
    return foldSessionEvents(events, {
      startSeq: Number.isFinite(inherited) ? inherited : 0,
      config,
    })
  }

  const readStoredFold = async (persistence, snapshot) => {
    const handle = await persistence.open(snapshot.header.id, 'read')
    try {
      const inherited = Number(handle.inheritedEventCount)
      const read = await handle.read()
      return foldSessionEvents(read.events, {
        startSeq: Number.isFinite(inherited) ? inherited : 0,
        config,
      })
    } finally {
      await handle.close()
    }
  }

  /**
   * Fold every visible session, reusing cached folds whose source revision has
   * not moved. Live sessions are folded from the in-memory store (fresher than
   * a best-effort persisted tail); stored sessions use the persistence read
   * handle.
   */
  const foldAll = async () => {
    const persistence = ctx.get('sessionPersistence')
    const registry = ctx.get('workspaceRegistry')
    if (persistence === undefined || registry === undefined) {
      throw Object.assign(new Error('session-persistence 或 workspace-registry 服务不可用'), {
        code: 'services-unavailable',
      })
    }
    const snapshots = await persistence.list()
    const store = ctx.get('sessions')
    const live = new Map()
    if (store !== undefined && typeof store.list === 'function') {
      for (const session of store.list()) live.set(String(session.id), session)
    }
    const entries = []
    let failed = 0
    for (const snapshot of snapshots) {
      const sessionId = snapshotHeaderId(snapshot.header)
      if (sessionId === undefined) continue
      try {
        const liveSession = live.get(sessionId)
        if (liveSession !== undefined) {
          const key = `live:${Number(liveSession.seq)}:${signature}`
          const cached = cache.get(sessionId)
          if (cached !== undefined && cached.key === key) {
            entries.push(cached.entry)
            continue
          }
          const entry = { sessionId, cwd: snapshot.header.cwd, fold: readLiveFold(liveSession) }
          cache.set(sessionId, { key, entry })
          entries.push(entry)
          continue
        }
        const key = `store:${String(snapshot.revision)}:${signature}`
        const cached = cache.get(sessionId)
        if (cached !== undefined && cached.key === key) {
          entries.push(cached.entry)
          continue
        }
        const entry = { sessionId, cwd: snapshot.header.cwd, fold: await readStoredFold(persistence, snapshot) }
        cache.set(sessionId, { key, entry })
        entries.push(entry)
      } catch (error) {
        failed += 1
        console.warn(`[workspace-spend] session ${sessionId} 读取失败: ${error?.message ?? error}`)
        entries.push({ sessionId, cwd: snapshot.header.cwd, fold: EMPTY_FOLD })
      }
    }
    const visible = new Set(entries.map((entry) => entry.sessionId))
    for (const id of [...cache.keys()]) if (!visible.has(id)) cache.delete(id)
    return { entries, failed, scanned: snapshots.length }
  }

  const collect = () => {
    if (folding === undefined) {
      folding = foldAll().finally(() => {
        folding = undefined
      })
    }
    return folding
  }

  const buildReport = async (rangeDays) => {
    const { entries, failed, scanned } = await collect()
    const registry = ctx.get('workspaceRegistry')
    let workspaces = []
    try {
      workspaces = (registry?.list?.() ?? []).map((workspace) => ({
        id: String(workspace.id),
        title: workspace.title,
        path: workspace.path,
        sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
      }))
    } catch (error) {
      console.warn(`[workspace-spend] workspace registry read failed: ${error?.message ?? error}`)
    }
    const report = aggregateReport({
      sessions: entries.map((entry) => ({ sessionId: entry.sessionId, cwd: entry.cwd, fold: entry.fold })),
      workspaces,
      config,
      rangeDays,
      now: Date.now(),
    })
    return { ...report, scanned: { sessions: scanned, failed } }
  }

  const connection = ctx.get('connection')
  if (connection?.fetch !== undefined && typeof connection.fetch.register === 'function') {
    ctx.effect(() => {
      const dispose = connection.fetch.register({
        path: REPORT_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const url = new URL(request.url)
            const rangeDays = normalizeRangeDays(url.searchParams.get('days') ?? undefined)
            const report = await buildReport(rangeDays)
            return jsonResponse({ ok: true, report })
          } catch (error) {
            const code = error?.code === 'services-unavailable' ? 'services-unavailable' : 'report-failed'
            const status = code === 'services-unavailable' ? 503 : 500
            return errorResponse(status, code, String(error?.message ?? error))
          }
        },
      })
      return () => {
        void dispose()
      }
    }, 'workspace-spend: report route')
  } else {
    console.warn('[workspace-spend] connection 服务不可用：只登记会话统计，不提供 /api/workspace-spend 路由')
  }
}
