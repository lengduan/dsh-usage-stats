# @lengduan/dsh-usage-stats

DeepSeek Harness 的**用量统计**插件。每次模型调用的四类 token 落进本地 SQLite 账本，按 天 × 服务商 × 模型 分桶。只统计用量，不做费用计算。

## Overview

**解决什么：** DSH 本身不保留跨会话的用量视图，会话一删历史消耗就查不到。本插件把每次模型调用记进一个独立账本，删会话、清会话日志都不影响已记账的数据。

**适合谁：** 想按天或按模型核对 token 消耗，并且需要把「主对话」与「DSH 内部调用（压缩、摘要、标题生成）」分开看的人。

**不适合：** 要算钱（这里只有 token，不乘单价）；要跨机器汇总（账本是单机 `$DSH_HOME` 下的一个文件）；TUI / headless（没有 Web 的 slot 可挂）。

## Compatibility

| 项 | 声明 |
|---|---|
| DSH 形态 | Web GUI profile（`dsh web` / `--profile web`） |
| 运行环境 | Node.js ≥ 22.5（依赖内置 `node:sqlite`）；Web 端需要会话视图提供 `conversation.view` 扩展点 |
| 宿主服务 | `sessionPersistence`、`webServer`，以及 `session/event`、`llm/stream` 事件 |
| 最后本机验证 | 2026-09-12，Windows，DSH mainline 本机构建 + web profile：tab 正常渲染、账本落库、按天 / 按模型聚合正确 |
| 未声称 | 未做跨平台与跨 DSH 版本矩阵；DSH mainline 的 DOM / class 漂移可能影响前端表格样式 |

## Install / Uninstall

从 npm 安装：

```sh
dsh plugin --profile web add @lengduan/dsh-usage-stats
```

升级：

```sh
dsh plugin --profile web update @lengduan/dsh-usage-stats
```

**禁用（不删依赖，账本保留）**：在 web profile 的 `cordis.patch.yml` 里把该行覆盖为 `disabled: true`：

```yaml
- id: usage-stats
  disabled: true
```

**彻底移除**：

```sh
dsh plugin --profile web remove @lengduan/dsh-usage-stats
```

移除不会删除账本。要清空历史，手动删 `$DSH_HOME/storages/usage-stats/`（默认 `~/.dsh/storages/usage-stats/`），该操作不可恢复。

装完或改完 patch 都需要重启 `dsh web`。

从源码安装（开发调试）：

```sh
git clone https://github.com/lengduan/dsh-usage-stats
cd dsh-usage-stats
dsh plugin --profile web add .
```

## Quick start

1. 安装并重启 `dsh web`，打开任意一个已有对话的会话。
2. 会话视图顶部出现「用量统计」tab，切过去；默认是「今日 · 全部口径」的表格。
3. 用时间范围（今日 / 本周 / 上周 / 全部 / 指定日期）和口径（全部 / 对话 / 内部）筛选；点服务商行可折叠其下的模型明细，点「刷新」重新取数。

最小验收：在任意会话发一句话触发一次模型调用，回到「用量统计」tab 点「刷新」，当天应出现该次调用的记录（输入 / 输出 / 缓存命中 / 缓存读写 / 总量）。

## Configuration

无配置项、无环境变量、无密钥。

唯一的隐式输入是 `DSH_HOME`（决定账本目录），沿用 DSH 自身取值。外观与表结构写死在 `lib/client.js` 里。

## Permissions & data

| 面 | 行为 |
|---|---|
| 网络 | 无出网请求。前端只 POST 本机 `/usage/api` |
| 文件系统 | 只读写 `$DSH_HOME/storages/usage-stats/usage.db`（含 WAL 伴生文件）；回溯历史时经 `sessionPersistence` 服务读会话日志 |
| 凭据 / 会话内容 | 不读 token、密钥、消息正文；只取用量数字与 session id、provider、model、时间、purpose |
| 宿主服务 | 订阅 `session/event` 与 `llm/stream`，注册 `/usage/api`，注入 `sessionPersistence` / `webServer` |
| 数据去向 | 全部留在本机账本，不外发、不写第三方 |

**统计口径**：输入（未命中）/ 输出 / 缓存命中 / 缓存写入 / 总量；provider 给出 `totalTokens` 时优先采用，否则四类相加。

**三路数据来源**：

| 来源 | 覆盖 | kind |
|---|---|---|
| `session/event` → `assistant/message.usage` | 主对话的每次模型调用（权威、幂等、带 seq） | `chat` |
| `llm/stream`（仅 `purpose` 非空） | 压缩、摘要、标题生成等 DSH 内部调用 | `internal` |
| 启动回溯：`sessionPersistence` 逐个读历史会话 | 插件安装之前的对话调用 | `chat` |

内部调用不写进会话日志，**只能实时捕获**，所以 `internal` 自插件安装之日起才有数据。回溯是增量的，按 `revision` + `next_seq` 水位推进；两路共用主键 `(session_id, record_key)`，`INSERT OR IGNORE` 天然去重，不会双计。

**账本是权威事实源，不是会话日志的索引** —— 删会话或清理会话日志都不会改变已记账的数据。

## Troubleshooting

| 现象 | 处理 |
|---|---|
| 会话顶部没有「用量统计」tab | 确认装的是 **web** profile 且已重启 `dsh web`；看浏览器控制台是否报 `client-modules: bundle … loaded without registering "<包名>"` —— 这类报错说明 client bundle 注册的 id 与包名不一致 |
| tab 在，但一直「暂无记录」 | 先发一次消息触发调用；选「内部」口径时需要插件已运行过内部调用才有数据 |
| 数字比预期少 | 检查口径是否停在「对话」；历史回溯只在插件启动时跑一次，装完请重启 |
| 启动报 SQLite / 权限错误 | 确认 `$DSH_HOME/storages/usage-stats/` 可写；目录被占用或磁盘满会让账本打不开，此时接口返回 `账本不可用` |
| 用量页里的按钮点不动 | 对话区两侧的宽度把手（40px 的 col-resize 条）会压在本页上抢走 pointerdown；本插件在用量页挂载期间会隐藏这两个把手，若仍复现请提 issue |
| 卸载后 tab 还在 | 硬刷新页面；确认 profile 的 `dsh.profile.bundles` 已不再列出该包 |

日志：`dsh web` 的终端输出（插件只经 `ctx.logger.warn` 输出告警）+ 浏览器控制台。插件不写独立日志文件。

回滚：`dsh plugin --profile web remove @lengduan/dsh-usage-stats` 后重启；账本文件可先行备份。

## Development

```sh
git clone https://github.com/lengduan/dsh-usage-stats
cd dsh-usage-stats
node scripts/verify.mjs          # 装载前自检
dsh plugin --profile web add .   # 以本仓目录联调
```

无构建步骤，`lib/` 就是发布产物：

| 文件 | 角色 |
|---|---|
| `lib/index.js` | host 半：账本、订阅、`/usage/api` |
| `lib/client.js` | 浏览器 bundle：`conversation.view` 的「用量统计」tab |
| `cordis.patch.yml` | bundle 层，按**包名**插入插件行 |
| `scripts/verify.mjs` | 自检：host 半可 import 并导出 `inject`/`apply`；client 半的 `factory` 返回模块对象、bundle id 与 package.json 的 `name` 一致、确实注册到 `conversation.view` |

改完 host 半需重启 `dsh web`，只改 client 半刷新页面即可。提交前请跑 `node scripts/verify.mjs`，它是 CI 之外唯一的门禁。

贡献：最小 diff。Issue / PR 请写清 DSH 版本或 mainline commit、本插件 commit、操作系统。

## License & security

- 许可证：[MIT](LICENSE)
- 安全问题：不要在公开 issue 里贴密钥或会话内容。请用 GitHub 的 Private vulnerability reporting（若已开启），或只描述复现步骤的私密渠道联系维护者。
- 本插件不处理任何凭据；若发现发布产物里出现外链或凭证，视为供应链问题，按上面的私密渠道反馈。
