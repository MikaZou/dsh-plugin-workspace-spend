# 发布到开源社区

这是一份发布清单。插件本身**没有构建步骤**、没有运行时依赖，发布就是把当前目录原样推到 npm / Git 仓库。

## 发布前检查

- [x] `package.json` 无 `private: true`，`name = dsh-plugin-workspace-spend`（npm 上当前可用）
- [x] `license: MIT` + `LICENSE` 文件
- [x] `engines.dsh: ">=0.2.1-rc.5"`（Plugin Manager 的版本兼容检查会读它）
- [x] `dsh.bundle.patch` 与 `dsh.client`（`platform: web`、`immediately: true`）
- [x] `exports` 暴露 `./client`、`./locale/*.json`、`./icon`
- [x] 图标、中英 locale 元数据（插件页显示标题与描述）
- [x] `npm test` / `npm run check` 通过
- [x] 仓库内没有个人路径、密钥、会话内容；`tools/verify-real-logs.mjs` 只读本机 `~/.dsh`
- [ ] 按需补 `author`、`repository`、`homepage`、`bugs` 字段（在 npm 发布前或之后都可补）

## 首次发布（npm）

先确认 npm 指向的 registry：本机若配置了国内镜像（`npm config get registry` 返回 `https://registry.npmmirror.com` 之类），镜像**只能读、不能发**，发布时必须显式指定 npm 官方 registry。

```sh
cd /path/to/dsh-plugin-workspace-spend

# 1. 预览将发布哪些文件（不会真的上传）
npm pack --dry-run

# 2. 登录 npm 官方 registry（浏览器完成一次授权）
npm login --registry https://registry.npmjs.org

# 3. 发布（unscoped 包默认 public）
npm publish --registry https://registry.npmjs.org --access public
```

发布后用户即可：

```sh
dsh plugin add dsh-plugin-workspace-spend
```

或在 Web 的 **Plugins → Add plugin** 里填 `dsh-plugin-workspace-spend`。

## 同时放到 GitHub（推荐）

仓库地址：`git@github.com:MikaZou/dsh-plugin-workspace-spend.git`

```sh
git remote add origin git@github.com:MikaZou/dsh-plugin-workspace-spend.git
git push -u origin main
```

然后：

1. `package.json` 已补好 `repository` / `homepage` / `bugs`（指向 MikaZou/dsh-plugin-workspace-spend）。
2. 用户也可以直接从 Git 安装：`dsh plugin add github:MikaZou/dsh-plugin-workspace-spend`。
3. 打 tag / 发 Release：`git tag v1.0.0 && git push --tags`。

## 升级发布

```sh
npm version patch   # 或 minor / major，自动改 package.json 并打 tag
npm test
npm run check
npm publish
```

用户侧在 Plugins 页点 **Update**，或重新 `dsh plugin add dsh-plugin-workspace-spend@<version>`。

## 版本兼容策略

- `engines.dsh` 表示测试过的 DSH 范围；DSH 升级后如果接口变化，先在新版本上跑一遍 `npm test` 和 `node tools/verify-real-logs.mjs`，再放宽/收紧范围。
- 若 DSH 的兼容检查拒绝某个较新的**预发布**版本（SemVer 对 prerelease 的范围匹配较严格），用户可以临时用插件页的版本豁免（`allow-version`），但建议尽快发布一个更新了 `engines.dsh` 的版本。
- 不要放宽到你没有测过的版本上——Host 半边直接跑在 Harness 进程里。

## 其他分发方式

- **tarball**：`npm pack` 生成 `dsh-plugin-workspace-spend-1.0.0.tgz`，用户 `dsh plugin add ./<file>.tgz`。
- **私有 registry / 镜像**：`dsh plugin add` 支持配置 registry 与 fallback 镜像，安装时按顺序查找。
- **本地目录**：`dsh plugin add /abs/path/to/dsh-plugin-workspace-spend`（开发调试用，`link:` 方式）。
- **桌面版**：Desktop 的包操作由 Desktop shell 负责；Web 侧栏 Plugins 页的安装入口同样可用。

## 发布后自检

1. 在一个干净 profile 里安装：`dsh plugin add dsh-plugin-workspace-spend`。
2. 打开设置确认出现「支出统计」，数字非空、刷新与时间范围切换正常。
3. 卸载再装一次，确认无残留路由与页面（`GET /api/workspace-spend` 在卸载后应 404/不可达）。
