# dsh-plugin-workspace-spend

按 **工作区** 统计 DeepSeek Harness（dsh）的模型调用花费：读取会话日志里的 Token 用量，按可配置的价格表估算金额，并在 **设置 → 支出统计** 提供一页看板。

Estimated model spend per workspace for DeepSeek Harness: token usage is folded from durable session logs, priced with a configurable price table (peak / off-peak), and shown on a **Spend** page in Settings.

- 适用版本 / Requires dsh：`>=0.2.1-rc.5`（`engines.dsh`）
- 许可证 / License：MIT
- 无构建步骤、无运行时依赖、无网络请求；Host 代码在本机进程内运行，只读本地日志。

## 功能

- **按工作区**：用 `workspaceRegistry` 的会话索引归属会话；未注册目录的会话按 cwd 单独成组并标注「未归入工作区」。
- **按时间**：全部 / 近 30 天 / 近 7 天 / 今天（按北京时间自然日切分）。
- **按模型**：每个工作区列出模型与对应金额；下方有全局「按模型」汇总。
- **计费口径**：区分缓存命中输入 / 缓存未命中输入 / 缓存写 / 输出；重试的每次计费尝试分别累计；压缩摘要请求单独计价；fork/seed 会话继承的前缀不重复计费。
- **峰谷价**：默认使用 DeepSeek 官方公开价（人民币/百万 tokens），高峰时段（北京时间工作日 9:00–12:00、14:00–18:00）用峰值价，其余时间按可配置折扣（默认 0.5 倍）计费。
- **可配置**：价格表、货币、折扣、节假日、按次计费的搜索/抓取工具都能在 profile 的 `cordis.patch.yml` 里改。
- 中英双语界面，浅色/深色主题跟随 Harness。

## 安装

### 从 npm（发布后）

```sh
dsh plugin add dsh-plugin-workspace-spend
```

或在 Harness 的 **Plugins → Add plugin** 里填包名 `dsh-plugin-workspace-spend`。

### 从 Git 仓库

```sh
dsh plugin add github:<你的用户名>/dsh-plugin-workspace-spend
```

### 从本地目录或 tarball

```sh
# 本地目录（开发时）
dsh plugin add "/path/to/dsh-plugin-workspace-spend"

# 或先打包再安装
npm pack
dsh plugin add ./dsh-plugin-workspace-spend-1.0.0.tgz
```

安装后 Host 行立即生效；浏览器侧通过 HMR 加载 Client 模块。如果设置面板里暂时没看到，刷新一次页面。打开 **设置 →「支出统计」** 即可。

卸载：在 Plugins 页移除，或 `dsh plugin remove dsh-plugin-workspace-spend`。

> 第一次打开页面会回放本机全部历史会话日志（当前机器 90+ 会话约 2–3 秒），之后只增量读取变化的会话。

## 数据口径

| 计入 | 说明 |
|---|---|
| 模型请求的输入 / 缓存命中 / 缓存写 / 输出 Token | 来自会话日志中 provider 上报的 usage |
| 重试尝试（`llm/retry-started`） | 每次计费尝试分别累计；同一 (turn, step) 的流式样本会被最终样本替换，不会重复 |
| 压缩（compaction）摘要请求 | `compaction/summary` 事件带 provider/model 与 usage，单独计价 |
| fork/seed 会话的继承前缀 | **跳过**，避免与源会话重复计费 |

不计入：

- 自动生成会话标题等不记录 usage 的模型调用；
- 图片/文件附件的单独计费（只按 token 用量算）；
- 网页搜索 / 抓取（Search/Fetch）的按次费用——默认关闭，可在 `perCallFees` 里开启；
- 赠送余额、免费额度、失败请求退费。

页面数字是**估算**，不是账单。

## 默认价格表

默认按 DeepSeek 官方 API 文档的**高峰价**（人民币 / 百万 tokens），取自
<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>（2026-11）：

| 模型 | 输入（缓存未命中） | 输入（缓存命中） | 输出 |
|---|---|---|---|
| `deepseek-flash` | 2 | 0.04 | 8 |
| `deepseek-v4-pro` | 9 | 0.30 | 27 |

- 高峰时段：北京时间周一至周五 09:00–12:00、14:00–18:00；其余时间（含周末）按 `offPeakDiscount`（默认 0.5 倍）计费。
- 法定节假日默认未内置（`holidays: []`）；需要精确时把日期加进配置。
- 退役模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 通过 `modelAliases` 映射到 `deepseek-flash`。
- 使用其他 provider/模型时，把对应价格加进 `prices`（键可以是模型名或 `provider/model`）；未配置价格的模型：Token 照常统计、金额按 0 计，页面会提示。

## 配置

默认值在 `lib/spend.js` 的 `DEFAULT_CONFIG`；用户配置写在 **profile 的 `cordis.patch.yml`**，覆盖 `workspace-spend` 行（未写字段与默认表逐字段合并）。例如：

```yaml
- id: workspace-spend
  config:
    currency: CNY
    currencySymbol: "¥"
    offPeakDiscount: 0.5
    prices:
      deepseek-flash:
        input: 2
        cacheRead: 0.04
        cacheWrite: 0
        output: 8
      deepseek-v4-pro:
        input: 9
        cacheRead: 0.3
        cacheWrite: 0
        output: 27
      # 其他 provider/模型：
      # "openrouter/deepseek-chat": { input: 1, cacheRead: 0.1, output: 2 }
    modelAliases:
      deepseek-v4-flash: deepseek-flash
      deepseek-v4-flash-vision-exp: deepseek-flash
    holidays:
      - "2026-10-01"
    trackCompaction: true
    # 可选：按次计费的搜索/抓取工具（单位同 currency，每次成功调用）
    perCallFees:
      web_search: 0.005
      web_fetch: 0.005
```

## 隐私与安全

- **完全本地**：Host 半边只读本机会话日志（`sessionPersistence` / `workspaceRegistry`），只做计算，不发网络请求、不上报遥测；页面数据来自 `GET /api/workspace-spend`，该路由走 Harness 的浏览器 cookie 鉴权（未鉴权返回 401）。
- 插件不写 profile 配置、不改会话日志、不注入消息、不注册模型可见工具。
- 页面上只出现工作区名称/路径与聚合金额，不含提示词或会话内容。
- `tools/verify-real-logs.mjs` 是可选的自测脚本，默认读 `~/.dsh`，只在本地运行。

## 兼容性

- 在 dsh `0.2.1-rc.5`（desktop profile）上开发与验证；`package.json` 声明 `engines.dsh: ">=0.2.1-rc.5"`。
- 如果 Harness 的版本兼容检查拒绝了较新的预发布版本，可以等插件更新范围，或用插件页的版本豁免（`allow-version`）在自担风险下安装。
- Host 服务名与浏览器 Slot 名来自 DSH 公共扩展点；若未来 DSH 调整这些契约，插件需要跟随更新。

## 开发与验证

```sh
npm test          # node test/spend.test.mjs
npm run check     # node --check index.js client.js lib/spend.js
node tools/verify-real-logs.mjs   # 对照本机真实日志与 tokenUsage 投影的独立复核
```

- `test/spend.test.mjs` 覆盖峰谷计价、缓存价、重试/替换、fork 前缀、压缩、模型别名、区间过滤、工作区路径归属、按次费用等。
- `tools/verify-real-logs.mjs` 解码本机会话日志，用同一份 `lib/spend.js` 折叠后与 Harness 持久化的 `tokenUsage` 投影逐会话比对；实测 90/92 个历史会话的 Token 总量完全一致，剩余 2 个是仍在写入的实时会话（缓存落后于日志）。
- 端到端实测：`sessionPersistence` 扫描 92 个历史会话、0 失败；Host 行与 `settings.section` 注册均 active。

## 已知限制

- 金额是按配置价格计算的**估算**，不是账单；DeepSeek 价格与峰谷规则可能调整。
- 峰谷判定使用事件写入时间（请求结束附近），跨越峰谷边界的超长请求会有几分钟误差。
- 时间范围按北京时间自然日切分；其他时区用户的「今天」按北京时间计算。
- 首次加载需要回放全部历史日志；日志特别多时首次加载会慢一些。
- 卸载后统计不落盘（每次从日志重算）。

## 实现

```
package.json          # dsh.bundle.patch + dsh.client(platform: web, immediately)
cordis.patch.yml      # insert: workspace-spend → dsh-plugin-workspace-spend
index.js              # Host：读 sessionPersistence + workspaceRegistry，注册 GET /api/workspace-spend
lib/spend.js          # 纯函数：会话事件折叠、价格解析、区间聚合
client.js             # 浏览器：settings.section 页面
test/spend.test.mjs   # 单元测试
tools/verify-real-logs.mjs  # 对照真实日志的复核脚本
```

## License

[MIT](LICENSE)
