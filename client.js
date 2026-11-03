/**
 * Browser half of `dsh-plugin-workspace-spend`.
 *
 * Adds one settings page ("支出统计" / "Spend") under Settings. The page reads
 * the Host half's authenticated `GET /api/workspace-spend` route and renders
 * per-workspace estimated spend, token totals, model breakdown, and the price
 * table the Host applied. All visible text goes through the Client locale
 * service; styling uses only `--dsw-alias-*` theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-workspace-spend',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'workspaceSpend'

    const zh = {
      navLabel: '支出统计',
      title: '工作区支出',
      intro:
        '按工作区汇总本机所有会话的模型调用费用：Token 用量取自会话日志，金额按下方价格表估算。',
      refresh: '刷新',
      refreshing: '刷新中…',
      loading: '正在统计…（首次读取需要解析历史会话日志，请稍候）',
      retry: '重试',
      loadError: '统计失败',
      rangeAll: '全部',
      range30: '近 30 天',
      range7: '近 7 天',
      rangeToday: '今天',
      totalLabel: '估算总花费',
      totalNote: '峰值价 + 空闲时段折扣，仅作估算',
      statWorkspaces: '工作区',
      statSessions: '会话',
      statRequests: '模型请求',
      statMessages: '助手消息',
      tokensLine: '输入 {input} · 输出 {output} · 缓存命中 {cache}',
      unattributed: '未归入工作区',
      byModel: '按模型',
      modelUnpriced: '未配置价格',
      metaSessions: '{n} 个会话',
      metaMessages: '{n} 条消息',
      metaRequests: '{n} 次请求',
      emptyTitle: '所选范围内没有用量',
      emptyBody: '运行一个会话后再回来看，或切换到「全部」。',
      unpricedWarn: '以下模型没有配置价格，Token 已计入但不计价：',
      pricingTitle: '价格表与计费规则',
      pricingNote:
        '单价为 {currency}/百万 tokens 的峰值价；空闲时段按峰值价的 {discount} 倍计费。高峰时段：北京时间周一至周五 9:00–12:00、14:00–18:00；周末与 {holidays} 个配置的节假日全天为空闲时段。',
      pricingInput: '输入',
      pricingCache: '缓存命中',
      pricingOutput: '输出',
      pricingPerCall: '每次调用',
      updatedAt: '更新于 {time}',
      partial: '{failed} 个会话读取失败，统计可能偏低',
      scanNote: '共读取 {n} 个会话',
      note:
        '这是按本机日志与配置价格计算的估算值，不等同于账单；未记录用量的调用（例如自动生成标题）不计入。若要调整价格，请在 profile 的 cordis.patch.yml 中覆盖 workspace-spend 行的 config。',
      refund: '免费额度 / 赠送余额不在此统计范围内。',
    }

    const en = {
      navLabel: 'Spend',
      title: 'Workspace spend',
      intro:
        'Estimated model spend per workspace across every session on this machine: token usage is folded from session logs and priced with the table below.',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      loading: 'Computing… (the first load replays stored session logs)',
      retry: 'Retry',
      loadError: 'Failed to load',
      rangeAll: 'All time',
      range30: '30 days',
      range7: '7 days',
      rangeToday: 'Today',
      totalLabel: 'Estimated total',
      totalNote: 'Peak prices with off-peak discount; an estimate only',
      statWorkspaces: 'Workspaces',
      statSessions: 'Sessions',
      statRequests: 'Requests',
      statMessages: 'Messages',
      tokensLine: 'Input {input} · Output {output} · Cache hits {cache}',
      unattributed: 'No workspace',
      byModel: 'By model',
      modelUnpriced: 'no price',
      metaSessions: '{n} sessions',
      metaMessages: '{n} messages',
      metaRequests: '{n} requests',
      emptyTitle: 'No usage in this range',
      emptyBody: 'Run a session and come back, or switch to "All time".',
      unpricedWarn: 'These models have no configured price; their tokens are counted but not priced:',
      pricingTitle: 'Prices and rules',
      pricingNote:
        'Rates are peak {currency} per million tokens. Off-peak time is billed at {discount}×. Peak: Beijing time Mon–Fri 09:00–12:00 and 14:00–18:00; weekends and {holidays} configured holidays are off-peak all day.',
      pricingInput: 'Input',
      pricingCache: 'Cache hit',
      pricingOutput: 'Output',
      pricingPerCall: 'per call',
      updatedAt: 'Updated {time}',
      partial: '{failed} session(s) could not be read; totals may be low',
      scanNote: '{n} sessions scanned',
      note:
        'This is an estimate from local logs and configured prices, not a bill. Calls that log no usage (for example automatic title generation) are not included. To change prices, override the config of the workspace-spend row in the profile cordis.patch.yml.',
      refund: 'Free quota and bonus balance are outside this estimate.',
    }

    const CSS = `
.dws-root{display:flex;flex-direction:column;gap:14px;width:100%;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dws-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
.dws-headText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 220px}
.dws-title{margin:0;font-size:15px;line-height:24px;font-weight:600}
.dws-intro{margin:0;color:var(--dsw-alias-label-secondary)}
.dws-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dws-ranges{display:flex;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.dws-range{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:3px 9px;border-radius:7px;cursor:pointer;white-space:nowrap}
.dws-range:hover{color:var(--dsw-alias-label-primary)}
.dws-range[data-active="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 0 0 .5px var(--dsw-alias-border-l1)}
.dws-range:focus-visible,.dws-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dws-btn{border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:5px 11px;border-radius:8px;cursor:pointer;white-space:nowrap}
.dws-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dws-btn[disabled]{opacity:.5;cursor:default}
.dws-total{border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:10px}
.dws-totalTop{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.dws-totalLabel{color:var(--dsw-alias-label-secondary);font-size:12px}
.dws-totalValue{font-size:26px;line-height:34px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.2px}
.dws-totalNote{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dws-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin:0;padding:0}
.dws-stat{margin:0;min-width:0}
.dws-stat dt{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dws-stat dd{margin:1px 0 0;font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}
.dws-tokens{margin:0;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:18px;font-variant-numeric:tabular-nums}
.dws-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.dws-row{border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:7px;min-width:0}
.dws-rowHead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.dws-rowName{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;min-width:0;flex:1 1 180px}
.dws-rowTitle{font-weight:600;font-size:13.5px;overflow-wrap:anywhere}
.dws-rowPath{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.dws-badge{border:.5px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);border-radius:999px;padding:0 7px;font-size:10.5px;line-height:16px;white-space:nowrap}
.dws-rowRight{display:flex;align-items:baseline;gap:8px;margin-left:auto;font-variant-numeric:tabular-nums}
.dws-rowCost{font-size:15px;font-weight:600}
.dws-rowShare{color:var(--dsw-alias-label-secondary);font-size:11px;min-width:38px;text-align:right}
.dws-bar{height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dws-barFill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);min-width:2px}
.dws-rowMeta{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:18px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dws-models{display:flex;gap:5px;flex-wrap:wrap}
.dws-chip{border:.5px solid var(--dsw-alias-border-l1);border-radius:7px;padding:0 6px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dws-chip[data-unpriced="true"]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dws-section{display:flex;flex-direction:column;gap:8px}
.dws-sectionTitle{margin:0;font-size:12.5px;line-height:18px;font-weight:600}
.dws-modelList{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}
.dws-modelRow{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px}
.dws-modelName{font-weight:600;overflow-wrap:anywhere}
.dws-modelMeta{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums}
.dws-modelCost{margin-left:auto;font-variant-numeric:tabular-nums}
.dws-muted{margin:0;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:18px}
.dws-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0}
.dws-error{border:.5px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:10px 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dws-error p{margin:0;color:var(--dsw-alias-state-error-primary)}
.dws-warn{border:.5px solid var(--dsw-alias-state-warn-primary);border-radius:10px;padding:8px 11px;display:flex;flex-direction:column;gap:4px}
.dws-warn p{margin:0;font-size:12px;line-height:18px}
.dws-warnModels{display:flex;gap:5px;flex-wrap:wrap}
.dws-empty{display:flex;flex-direction:column;gap:4px;padding:10px 2px}
.dws-empty p{margin:0}
.dws-details{border-top:.5px solid var(--dsw-alias-border-l1);padding-top:9px}
.dws-details summary{cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dws-details summary:hover{color:var(--dsw-alias-label-primary)}
.dws-detailsBody{display:flex;flex-direction:column;gap:6px;padding-top:8px}
.dws-rateList{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.dws-rateRow{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;line-height:17px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dws-rateModel{color:var(--dsw-alias-label-primary);font-weight:600}
.dws-foot{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}
`

    const RANGES = [
      { days: 0, key: 'rangeAll' },
      { days: 30, key: 'range30' },
      { days: 7, key: 'range7' },
      { days: 1, key: 'rangeToday' },
    ]

    function fill(template, values) {
      let text = String(template)
      for (const [key, value] of Object.entries(values)) text = text.split(`{${key}}`).join(String(value))
      return text
    }

    function groupDigits(text) {
      const [whole, fraction] = text.split('.')
      const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      return fraction === undefined ? grouped : `${grouped}.${fraction}`
    }

    function formatCost(value, symbol) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value > 0 && value < 0.01) return `<${symbol}0.01`
      return `${symbol}${groupDigits(value.toFixed(2))}`
    }

    function formatTokens(value) {
      const n = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
      return String(Math.round(n))
    }

    function formatRate(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
      if (Number.isInteger(value)) return String(value)
      return String(Number(value.toFixed(4)))
    }

    function shareOf(cost, total) {
      if (typeof cost !== 'number' || !Number.isFinite(cost) || total <= 0) return 0
      return Math.min(100, Math.max(0, (cost / total) * 100))
    }

    function formatClock(timeMs) {
      try {
        return new Date(timeMs).toLocaleTimeString(undefined, { hour12: false })
      } catch {
        return ''
      }
    }

    async function fetchReport(days, signal) {
      if (typeof fetch !== 'function') throw new Error('fetch unavailable in this page')
      const response = await fetch(`api/workspace-spend?days=${encodeURIComponent(String(days))}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok || payload === undefined || payload.ok !== true) {
        const message = payload?.error?.message
        throw new Error(message === undefined ? `HTTP ${response.status}` : `${payload.error?.code ?? 'error'}: ${message}`)
      }
      return payload.report
    }

    function useLocaleRevision(locale) {
      const [revision, setRevision] = React.useState(0)
      React.useEffect(() => {
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setRevision((value) => value + 1))
      }, [locale])
      return revision
    }

    function SpendSection(props) {
      const t = props.t
      const locale = props.locale
      useLocaleRevision(locale)
      const [rangeDays, setRangeDays] = React.useState(0)
      const [attempt, setAttempt] = React.useState(0)
      const [state, setState] = React.useState({ status: 'loading', report: undefined, error: '' })

      React.useEffect(() => {
        const controller = new AbortController()
        let live = true
        setState((previous) => ({ status: 'loading', report: previous.report, error: '' }))
        fetchReport(rangeDays, controller.signal)
          .then((report) => {
            if (!live) return
            setState({ status: 'ready', report, error: '' })
          })
          .catch((error) => {
            if (!live || controller.signal.aborted) return
            setState((previous) => ({
              status: 'error',
              report: previous.report,
              error: String(error?.message ?? error),
            }))
          })
        return () => {
          live = false
          controller.abort()
        }
      }, [rangeDays, attempt])

      const report = state.report
      const busy = state.status === 'loading'
      const currencySymbol = report?.currencySymbol ?? '¥'
      const refresh = () => setAttempt((value) => value + 1)

      return h(
        React.Fragment,
        null,
        h('style', { key: 'dws-style' }, CSS),
        h(
          'div',
          { className: 'dws-root' },
          h(
            'header',
            { className: 'dws-head' },
            h(
              'div',
              { className: 'dws-headText' },
              h('h4', { className: 'dws-title' }, t('title')),
              h('p', { className: 'dws-intro' }, t('intro')),
            ),
            h(
              'div',
              { className: 'dws-actions' },
              h(
                'div',
                { className: 'dws-ranges', role: 'group' },
                RANGES.map((range) =>
                  h(
                    'button',
                    {
                      key: range.key,
                      type: 'button',
                      className: 'dws-range',
                      'data-active': rangeDays === range.days ? 'true' : 'false',
                      'aria-pressed': rangeDays === range.days,
                      disabled: busy,
                      onClick: () => setRangeDays(range.days),
                    },
                    t(range.key),
                  ),
                ),
              ),
              h(
                'button',
                { type: 'button', className: 'dws-btn', disabled: busy, onClick: refresh },
                busy ? t('refreshing') : t('refresh'),
              ),
            ),
          ),
          state.status === 'error'
            ? h(
                'div',
                { className: 'dws-error', role: 'alert' },
                h('p', null, `${t('loadError')} (${state.error})`),
                h('button', { type: 'button', className: 'dws-btn', onClick: refresh }, t('retry')),
              )
            : null,
          busy && report === undefined ? h('p', { className: 'dws-status' }, t('loading')) : null,
          report !== undefined ? h(ReportBody, { report, t, busy, currencySymbol }) : null,
        ),
      )
    }

    function ReportBody(props) {
      const { report, t, busy, currencySymbol } = props
      const totals = report.totals ?? {}
      const workspaces = Array.isArray(report.workspaces) ? report.workspaces : []
      const models = Array.isArray(report.models) ? report.models : []
      const unpricedModels = Array.isArray(report.unpricedModels) ? report.unpricedModels : []
      const scanned = report.scanned ?? { sessions: 0, failed: 0 }
      const totalCost = typeof totals.cost === 'number' ? totals.cost : 0
      const tokens = totals.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      const hasUnpriced = unpricedModels.length > 0
      const valueText =
        totalCost === 0 && hasUnpriced ? '—' : `≈ ${formatCost(totalCost, currencySymbol)}`

      return h(
        'div',
        { className: 'dws-section' },
        h(
          'div',
          { className: 'dws-total' },
          h(
            'div',
            { className: 'dws-totalTop' },
            h('span', { className: 'dws-totalLabel' }, t('totalLabel')),
            h('span', { className: 'dws-totalValue' }, valueText),
            h('span', { className: 'dws-totalNote' }, t('totalNote')),
          ),
          h('p', { className: 'dws-tokens' }, fill(t('tokensLine'), {
            input: formatTokens(tokens.input),
            output: formatTokens(tokens.output),
            cache: formatTokens(tokens.cacheRead),
          })),
          h(
            'dl',
            { className: 'dws-stats' },
            stat(t('statWorkspaces'), String(workspaces.length)),
            stat(t('statSessions'), String(totals.sessions ?? 0)),
            stat(t('statRequests'), String(totals.requests ?? 0)),
            stat(t('statMessages'), String(totals.messages ?? 0)),
          ),
        ),
        h(
          'p',
          { className: 'dws-muted' },
          [
            fill(t('updatedAt'), { time: formatClock(report.generatedAt) }),
            fill(t('scanNote'), { n: scanned.sessions ?? 0 }),
            scanned.failed > 0 ? fill(t('partial'), { failed: scanned.failed }) : '',
          ]
            .filter((part) => part.length > 0)
            .join(' · '),
        ),
        hasUnpriced
          ? h(
              'div',
              { className: 'dws-warn' },
              h('p', null, t('unpricedWarn')),
              h(
                'div',
                { className: 'dws-warnModels' },
                unpricedModels.map((model) => h('span', { key: model, className: 'dws-chip', 'data-unpriced': 'true' }, model)),
              ),
            )
          : null,
        workspaces.length === 0
          ? h(
              'div',
              { className: 'dws-empty' },
              h('p', { className: 'dws-rowTitle' }, t('emptyTitle')),
              h('p', { className: 'dws-muted' }, t('emptyBody')),
            )
          : h(
              'ul',
              { className: 'dws-list' },
              workspaces.map((workspace) =>
                h(WorkspaceRow, { key: workspace.key, workspace, totalCost, t, currencySymbol }),
              ),
            ),
        models.length > 0
          ? h(
              'div',
              { className: 'dws-section' },
              h('h5', { className: 'dws-sectionTitle' }, t('byModel')),
              h(
                'ul',
                { className: 'dws-modelList' },
                models.map((model) =>
                  h(
                    'li',
                    { key: model.key, className: 'dws-modelRow' },
                    h('span', { className: 'dws-modelName' }, model.model),
                    h(
                      'span',
                      { className: 'dws-modelMeta' },
                      `${formatTokens(
                        (model.tokens?.input ?? 0) + (model.tokens?.output ?? 0) + (model.tokens?.cacheRead ?? 0),
                      )} tokens · ${
                        model.calls > 0 ? fill(t('metaRequests'), { n: model.requests ?? 0 }) : fill(t('metaMessages'), { n: model.messages ?? 0 })
                      }`,
                    ),
                    h(
                      'span',
                      { className: 'dws-modelCost' },
                      model.priced === false
                        ? t('modelUnpriced')
                        : formatCost(model.cost ?? 0, currencySymbol),
                    ),
                  ),
                ),
              ),
            )
          : null,
        h(PriceDetails, { pricing: report.pricing, t }),
        h('p', { className: 'dws-foot' }, t('note')),
      )
    }

    function stat(label, value) {
      return h('div', { className: 'dws-stat', key: label }, h('dt', null, label), h('dd', null, value))
    }

    function WorkspaceRow(props) {
      const { workspace, totalCost, t, currencySymbol } = props
      const tokens = workspace.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      const share = shareOf(workspace.cost, totalCost)
      const models = Array.isArray(workspace.models) ? workspace.models : []
      return h(
        'li',
        { className: 'dws-row' },
        h(
          'div',
          { className: 'dws-rowHead' },
          h(
            'div',
            { className: 'dws-rowName' },
            h('span', { className: 'dws-rowTitle' }, workspace.title),
            workspace.unattributed === true
              ? h('span', { className: 'dws-badge' }, t('unattributed'))
              : null,
            workspace.path !== undefined && workspace.path !== workspace.title
              ? h('span', { className: 'dws-rowPath' }, workspace.path)
              : null,
          ),
          h(
            'div',
            { className: 'dws-rowRight' },
            h(
              'span',
              { className: 'dws-rowCost' },
              workspace.cost === 0 && workspace.unpricedTokens > 0 ? '—' : formatCost(workspace.cost ?? 0, currencySymbol),
            ),
            h('span', { className: 'dws-rowShare' }, totalCost > 0 ? `${share.toFixed(share >= 10 ? 0 : 1)}%` : ''),
          ),
        ),
        h(
          'div',
          { className: 'dws-bar', 'aria-hidden': true },
          h('span', { className: 'dws-barFill', style: { width: `${share === 0 ? 0 : Math.max(2, share)}%` } }),
        ),
        h(
          'p',
          { className: 'dws-rowMeta' },
          [
            fill(t('metaSessions'), { n: workspace.sessions ?? 0 }),
            fill(t('metaMessages'), { n: workspace.messages ?? 0 }),
            fill(t('tokensLine'), {
              input: formatTokens(tokens.input),
              output: formatTokens(tokens.output),
              cache: formatTokens(tokens.cacheRead),
            }),
          ].join(' · '),
        ),
        models.length > 0
          ? h(
              'div',
              { className: 'dws-models' },
              models.map((model) =>
                h(
                  'span',
                  {
                    key: model.key,
                    className: 'dws-chip',
                    'data-unpriced': model.priced === false ? 'true' : 'false',
                    title: model.priced === false ? t('modelUnpriced') : `${model.model} ${formatCost(model.cost, currencySymbol)}`,
                  },
                  model.priced === false
                    ? `${model.model} · ${t('modelUnpriced')}`
                    : `${model.model}${model.cost > 0 ? ` ${formatCost(model.cost, currencySymbol)}` : ''}`,
                ),
              ),
            )
          : null,
      )
    }

    function PriceDetails(props) {
      const { pricing, t } = props
      if (pricing === undefined || pricing === null) return null
      const rates = Array.isArray(pricing.rates) ? pricing.rates : []
      const fees = Array.isArray(pricing.perCallFees) ? pricing.perCallFees : []
      return h(
        'details',
        { className: 'dws-details' },
        h('summary', null, t('pricingTitle')),
        h(
          'div',
          { className: 'dws-detailsBody' },
          h(
            'p',
            { className: 'dws-muted' },
            fill(t('pricingNote'), {
              currency: pricing.currency,
              discount: pricing.offPeakDiscount,
              holidays: pricing.holidayCount ?? 0,
            }),
          ),
          h(
            'ul',
            { className: 'dws-rateList' },
            rates.map((rate) =>
              h(
                'li',
                { key: rate.model, className: 'dws-rateRow' },
                h('span', { className: 'dws-rateModel' }, rate.model),
                h('span', null, `${t('pricingInput')} ${formatRate(rate.input)}`),
                h('span', null, `${t('pricingCache')} ${formatRate(rate.cacheRead)}`),
                h('span', null, `${t('pricingOutput')} ${formatRate(rate.output)}`),
              ),
            ),
            fees.map((fee) =>
              h(
                'li',
                { key: fee.tool, className: 'dws-rateRow' },
                h('span', { className: 'dws-rateModel' }, fee.tool),
                h('span', null, `${formatRate(fee.fee)} ${pricing.currency} ${t('pricingPerCall')}`),
              ),
            ),
          ),
          h('p', { className: 'dws-foot' }, t('refund')),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'workspace-spend: dictionaries')
      const t = ctx.locale.bind(NS)
      const locale = ctx.locale
      const Section = (props) => h(SpendSection, { ...props, t, locale })
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'workspace-spend',
            order: 30,
            label: () => t('navLabel'),
          },
          Section,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
