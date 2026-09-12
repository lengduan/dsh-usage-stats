# @lengduan/dsh-usage-stats

DeepSeek Harness 的**用量统计**插件（只统计用量，不做费用计算）。

## 它统计什么

每次模型调用的四类 token：**输入（未命中）/ 输出 / 缓存命中 / 缓存写入**，以及四者之和「总量」，
按 **天 × 服务商 × 模型** 分桶，落在本地 SQLite 账本里。

## 数据来源（两路实时 + 一路回溯）

| 来源 | 覆盖 | 落库 kind |
| --- | --- | --- |
| `session/event` → `assistant/message.usage` | 主对话的每次模型调用（权威、幂等、带 seq） | `chat` |
| `llm/stream`（仅 `purpose` 非空） | 压缩、摘要、标题生成等 **DSH 内部调用** | `internal` |
| 启动回溯：`sessionPersistence` 逐个读历史会话 | 插件安装之前的全部对话调用 | `chat` |

- 内部调用不写进会话日志，**只能实时捕获**，所以 `internal` 自插件安装之日起才有数据。
- 对话调用可用 `sessionPersistence` 服务回溯补齐历史（增量，按 `revision` + `next_seq` 水位）。
- 两路使用同一主键 `(session_id, record_key)`，`INSERT OR IGNORE` 天然去重，不会双计。

## 存储

`$DSH_HOME/storages/usage-stats/usage.db`（默认 `~/.dsh/storages/usage-stats/usage.db`），`node:sqlite` 内置零依赖，WAL 模式。

**账本是权威事实源，不是会话日志的索引**——删除会话（或会话日志被清理）不会影响已记账的数据。

## 界面

在会话视图顶部新增「用量统计」tab：时间范围（今日 / 本周 / 上周 / 全部 / 指定日期）、
口径切换（对话 / 内部 / 全部），表格按服务商分组列出各模型的输入 / 输出 / 缓存命中 / 缓存读写 / 总量。

## 安装

从 npm 装（已发布包）：

```sh
dsh plugin --profile web add @lengduan/dsh-usage-stats
```

从源码装（本地开发调试）：

```sh
git clone https://github.com/lengduan/dsh-usage-stats
cd dsh-usage-stats
dsh plugin --profile web add .
```

装完需要重启 dsh web 服务。
