# AGENTS.md — @lengduan/dsh-usage-stats

本项目面向代理的约定。跨项目通用规则见 `~/.dsh/AGENTS.md`；与本文件冲突时以本文件为准。

## 项目速览

- 形态：DSH 可安装插件包 —— host 半 `lib/index.js`、client 半 `lib/client.js`、bundle 补丁 `cordis.patch.yml`。无构建步骤，`lib/` 就是发布产物。
- 门禁：`node scripts/verify.mjs`（装载前自检），改动后提交前必跑。
- host 端点：只注册 `/usage/api`，自带 loopback 围栏（`lib/loopback-fence.js`）；远程访问靠 client 半降级到 remote-web-ui 的 `/remote` 门控通道。

## 发版流程

用户说「发版 / 发新版」且未额外指定时，按下列默认执行，不要跳步。

| 步骤 | 动作 | 判据 / 说明 |
|---|---|---|
| 1 | 取版本号：读 `package.json` 的 `version`，**最后一位 +1**（`0.1.3` → `0.1.4`） | 用户明确指定版本号时以用户为准 |
| 2 | 改 `package.json` 的 `version`；先 `git fetch origin`，本地落后于 `origin/master` 则先 `git pull` | 无远程跟踪分支则跳过 fetch |
| 3 | 跑 `node scripts/verify.mjs` | 必须全绿；它是 CI 之外唯一门禁 |
| 4 | 提交：代码改动与版本号分成两个 commit，Conventional Commits，subject 中文 | 不 amend、不 force push、不跳过 hooks |
| 5 | **推送 GitHub**：`git push origin master` | 发版必须推送；tag 触发发布，仓库不推则 workflow 里的提交不存在 |
| 6 | **打 tag 触发发布**：`git tag v<版本号>` 然后 `git push origin v<版本号>` | tag 打在含该版本号的提交上，`v` 前缀（workflow 匹配 `v[0-9]+.[0-9]+.[0-9]+`）；外网走本机代理 `127.0.0.1:7897` |
| 7 | **看 Actions 结果 + 验证 registry**：`gh run list --limit 3`、`gh run view <run-id>`；新版本已是 `latest`（`https://registry.npmjs.org/@lengduan/dsh-usage-stats/latest`） | run 结论必须 success；不能只信 workflow 输出，publish 后传播与自动审核需要时间 |
| 8 | 升级本机 profile（见下节） | profile 在 `~/.dsh/profiles/web` |
| 9 | 重启 `:3080` **前必须显式询问用户** | 重启会断开用户当前页面，不得擅自重启 |
| 10 | 重启后在 `:3080` 真实 GUI 复核 | 涉及 UI 或 host 路由的改动必做 |

### 触发发布（GitHub Actions）

- 发布由 `.github/workflows/publish.yml` 承担，走 npm 可信发布（Trusted Publishing / OIDC）：workflow 不注入任何 token，provenance 由 npm 自动生成，本地不再执行 `npm publish`。
- 触发方式：推 `v<版本号>` tag（workflow 先校验 tag 与 `package.json` 版本一致，再发布），或在 Actions 页面手动 `workflow_dispatch` 补发。
- workflow 只跑 `node scripts/verify.mjs`（本项目零依赖、无构建步骤），随后 `npm publish --access public`。
- npm 侧可信发布者配置：Workflow filename `publish.yml`、Environment name 留空（因此 workflow 也不声明 `environment`）、Allowed actions 含 `npm publish`。

### 升级本机 profile

1. 备份 `~/.dsh/profiles/web` 下本次会被改动的文件为 `*.bak-yyyyMMdd-HHmmss`：`package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`。
2. 确认没有其他会话在跑 `pnpm` / 插件安装进程（该 profile 曾被并发改动互锁过）。
3. **把新版本加进 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`**，写法延续既有风格：
   `- '@lengduan/dsh-usage-stats@0.1.1 || 0.1.2 || 0.1.3'`。
   漏掉这步，pnpm v12 的供应链策略会让 `pnpm update` 输出 `Done` 却静默保留旧版本。
4. 在 profile 目录里用 pnpm 升级（本机 `dsh` 不在 PATH，不要依赖它）：
   `pnpm update @lengduan/dsh-usage-stats`。
5. 核验真实结果：`node_modules/@lengduan/dsh-usage-stats/package.json` 的 `version` 是新版本，且本次新增文件（例如 `lib/loopback-fence.js`）确实到位。

### 重启

装完不擅自重启。用户同意后走双仓切换脚本，先探活再切：

```sh
node C:\lengduan\githubs\ds-harness\switch-service.ts
```

## 边界

- 本文件只约束**发版**。发版之外的日常改动沿用全局默认：不 commit、不 push，拿到发版指令才走上面的流程。
- 只改本仓库。`@linxin666/*`、`dsh-better-sidebar`、`@modusensus/dsh-mneme` 等第三方包只作只读参考 —— 不改它们的源码与白名单。
- 注释用中文；代码与非展示字符串不要 emoji；不重构、不改无关文件、不顺手格式化。
