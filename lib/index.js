/**
 * dsh-usage-stats — HOST half.
 *
 * 只做用量统计，不做费用计算。统计每次模型调用的四类 token
 * （输入未命中 / 输出 / 缓存命中 / 缓存写入）与总量，按 天 × 服务商 × 模型 落库。
 *
 * 三条数据来源：
 *   1. `session/event` → `assistant/message.usage`：主对话的权威事实，kind='chat'。
 *      事件是 post-commit 广播且不重放，带 seq / messageId，天然幂等。
 *   2. `llm/stream`（仅 purpose 非空）：压缩、摘要、标题生成等 DSH 内部调用，
 *      kind='internal'。这类调用不写进会话日志，只能实时捕获。
 *   3. 启动回溯：读 `sessionPersistence` 里的历史会话，补齐插件安装前的对话调用。
 *
 * 三路共用主键 (session_id, record_key)，靠 INSERT OR IGNORE 去重。
 * 账本是权威事实源，不依赖会话文件；删除会话不影响已记账数据。
 */
import path from 'node:path'
import os from 'node:os'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const pad2 = (n) => (n < 10 ? '0' : '') + n

/** 本地日历日 YYYY-MM-DD（与 DSH / 官方账单的本地口径一致）。 */
function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 本地时区当天 00:00 的毫秒时间戳。 */
function startOfDay(d) {
  const x = new Date(d.getTime())
  x.setHours(0, 0, 0, 0)
  return x
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * 把一条 provider usage 归一成账本的四类桶 + 总量。
 * `totalTokens` 由 provider 给出时优先采用；缺失时四类相加。
 */
function buckets(u) {
  const input = num(u?.inputTokens)
  const output = num(u?.outputTokens)
  const cacheRead = num(u?.cacheReadTokens)
  const cacheWrite = num(u?.cacheWriteTokens)
  const total = typeof u?.totalTokens === 'number' && Number.isFinite(u.totalTokens)
    ? u.totalTokens
    : input + output + cacheRead + cacheWrite
  return { input, output, cacheRead, cacheWrite, total }
}

/** 账本文件：$DSH_HOME/storages/usage-stats/usage.db。 */
function resolveDbPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'usage-stats', 'usage.db')
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS usage_calls (
    session_id  TEXT    NOT NULL,
    record_key  TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    time        INTEGER NOT NULL,
    day         TEXT    NOT NULL,
    provider    TEXT    NOT NULL DEFAULT '',
    model       TEXT    NOT NULL DEFAULT '',
    purpose     TEXT    NOT NULL DEFAULT '',
    input       INTEGER NOT NULL DEFAULT 0,
    output      INTEGER NOT NULL DEFAULT 0,
    cache_read  INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, record_key)
  );
  CREATE INDEX IF NOT EXISTS idx_calls_day ON usage_calls (day);
  CREATE INDEX IF NOT EXISTS idx_calls_day_kind ON usage_calls (day, kind);
  CREATE INDEX IF NOT EXISTS idx_calls_group ON usage_calls (kind, provider, model);

  CREATE TABLE IF NOT EXISTS scan_state (
    session_id TEXT PRIMARY KEY,
    revision   TEXT    NOT NULL DEFAULT '',
    next_seq   INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`

/** 用量账本：一个 SQLite 文件，WAL 模式，逐条 INSERT OR IGNORE。 */
class Ledger {
  constructor(dbPath) {
    mkdirSync(path.dirname(dbPath), { recursive: true })
    this.dbPath = dbPath
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(SCHEMA)
    this.insert = this.db.prepare(`
      INSERT OR IGNORE INTO usage_calls
        (session_id, record_key, kind, time, day, provider, model, purpose,
         input, output, cache_read, cache_write, total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.getState = this.db.prepare('SELECT revision, next_seq FROM scan_state WHERE session_id = ?')
    this.putState = this.db.prepare(`
      INSERT INTO scan_state (session_id, revision, next_seq, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        revision = excluded.revision, next_seq = excluded.next_seq, updated_at = excluded.updated_at
    `)
  }

  /** 记一笔；主键冲突（同一 session 的同一条消息）直接忽略。 */
  add(rec) {
    this.insert.run(
      String(rec.sessionId || ''), String(rec.recordKey || ''), String(rec.kind || 'chat'),
      Math.round(num(rec.time)), dayKey(num(rec.time)),
      String(rec.provider || ''), String(rec.model || ''), String(rec.purpose || ''),
      Math.round(num(rec.input)), Math.round(num(rec.output)),
      Math.round(num(rec.cacheRead)), Math.round(num(rec.cacheWrite)), Math.round(num(rec.total)),
    )
  }

  scanState(sessionId) {
    const row = this.getState.get(String(sessionId))
    if (!row) return null
    return { revision: String(row.revision || ''), nextSeq: Number(row.next_seq) || 0 }
  }

  setScanState(sessionId, revision, nextSeq) {
    this.putState.run(String(sessionId), String(revision || ''), Math.round(num(nextSeq)), Date.now())
  }

  /**
   * 按范围聚合，返回扁平行数组（provider 汇总行 → 其下模型行 → 总计行），
   * 结构与 PI 的用量统计报表一致，前端可直接映射成表格行。
   */
  summary({ from, to, kind }) {
    const conds = []
    const params = []
    if (from) { conds.push('day >= ?'); params.push(from) }
    if (to) { conds.push('day <= ?'); params.push(to) }
    if (kind === 'chat' || kind === 'internal') { conds.push('kind = ?'); params.push(kind) }
    const where = conds.length ? ' WHERE ' + conds.join(' AND ') : ''
    const groups = this.db.prepare(`
      SELECT provider, model,
             SUM(input) AS input, SUM(output) AS output,
             SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite,
             SUM(total) AS total, COUNT(*) AS messages
      FROM usage_calls${where}
      GROUP BY provider, model
    `).all(...params)

    const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0 })
    const addInto = (dst, src) => {
      dst.input += src.input; dst.output += src.output
      dst.cacheRead += src.cacheRead; dst.cacheWrite += src.cacheWrite
      dst.total += src.total; dst.messages += src.messages
    }

    const byProvider = new Map()
    const total = zero()
    for (const g of groups) {
      const provider = String(g.provider || '（未知服务商）')
      const row = {
        name: String(g.model || 'unknown'),
        input: num(g.input), output: num(g.output),
        cacheRead: num(g.cacheRead), cacheWrite: num(g.cacheWrite),
        total: num(g.total), messages: num(g.messages),
      }
      let bucket = byProvider.get(provider)
      if (!bucket) {
        bucket = { name: provider, sum: zero(), models: [] }
        byProvider.set(provider, bucket)
      }
      bucket.models.push(row)
      addInto(bucket.sum, row)
      addInto(total, row)
    }

    const providers = [...byProvider.values()].sort((a, b) => b.sum.total - a.sum.total)
    const rows = []
    for (const p of providers) {
      rows.push({ level: 'provider', name: p.name, ...p.sum })
      for (const m of p.models.sort((a, b) => b.total - a.total)) {
        rows.push({ level: 'model', name: m.name, provider: p.name, ...m })
      }
    }
    rows.push({ level: 'total', name: '总 Token', ...total })

    return { rows, total, messages: total.messages, providers: providers.length }
  }

  /** 账本概况：给界面显示数据量与覆盖范围。 */
  status() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS calls,
             MIN(day) AS firstDay, MAX(day) AS lastDay,
             SUM(CASE WHEN kind = 'chat' THEN 1 ELSE 0 END) AS chatCalls,
             SUM(CASE WHEN kind = 'internal' THEN 1 ELSE 0 END) AS internalCalls
      FROM usage_calls
    `).get()
    let sessions = 0
    try { sessions = Number(this.db.prepare('SELECT COUNT(*) AS n FROM scan_state').get()?.n) || 0 } catch (e) { sessions = 0 }
    return {
      dbPath: this.dbPath,
      calls: num(row?.calls),
      chatCalls: num(row?.chatCalls),
      internalCalls: num(row?.internalCalls),
      firstDay: row?.firstDay || null,
      lastDay: row?.lastDay || null,
      sessionsTracked: sessions,
    }
  }

  close() {
    try { this.db.close() } catch (e) { /* 关闭失败不影响退出 */ }
  }
}

/** 把请求体读成 JSON（解析失败按空对象处理）。 */
function readBody(req) {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (c) => { text += c })
    req.on('end', () => { try { resolve(JSON.parse(text)) } catch (e) { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

/**
 * 把请求的 range 参数换算成 [from, to] 的本地日历日闭区间。
 * 周区间以周一为起点，与 PI 的用量报表口径保持一致。
 */
function resolveRange(range, dateArg) {
  const today = dayKey(Date.now())
  if (range === 'all') return { from: null, to: null, label: '全部' }

  if (range === 'date') {
    const d = String(dateArg || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { from: today, to: today, label: `今日 ${today}` }
    return { from: d, to: d, label: d }
  }

  if (range === 'week') {
    const base = startOfDay(new Date())
    const weekday = (base.getDay() + 6) % 7 // 周一 = 0
    const start = new Date(base.getTime() - weekday * 86400000)
    const from = dayKey(start.getTime())
    return { from, to: today, label: `本周（${from} 起）` }
  }

  if (range === 'lastweek') {
    const base = startOfDay(new Date())
    const weekday = (base.getDay() + 6) % 7
    const thisStart = new Date(base.getTime() - weekday * 86400000)
    const lastStart = new Date(thisStart.getTime() - 7 * 86400000)
    const lastEnd = new Date(thisStart.getTime() - 1)
    const from = dayKey(lastStart.getTime())
    const to = dayKey(lastEnd.getTime())
    return { from, to, label: `上周（${from} ~ ${to}）` }
  }

  return { from: today, to: today, label: `今日 ${today}` }
}

export const inject = ['sessionPersistence', 'webServer']

export function apply(ctx) {
    const warn = (message) => { try { ctx.logger?.warn?.(`[dsh-usage-stats] ${message}`) } catch (e) { /* 日志不可用则静默 */ } }

    let ledger = null
    try {
      ledger = new Ledger(resolveDbPath())
    } catch (error) {
      warn(`账本打开失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const currentAgent = () => {
      try {
        const agents = ctx.get('agents')
        if (agents && typeof agents.currentInitiator === 'function') return agents.currentInitiator()
      } catch (e) { /* agents 服务可选 */ }
      return undefined
    }

    // 会话 → 最近一次请求头里的 provider/model；message.source 缺失时兜底。
    const headers = new Map()
    const rememberHeader = (sessionId, header) => {
      if (!header || typeof header.provider !== 'string' || typeof header.model !== 'string') return
      if (!headers.has(sessionId) && headers.size >= 500) {
        const oldest = headers.keys().next().value
        if (oldest !== undefined) headers.delete(oldest)
      }
      headers.set(sessionId, { provider: header.provider, model: header.model })
    }

    if (ledger) {
      // ── 路 1：会话事件（主对话，权威事实） ─────────────────────────────
      try {
        ctx.on('session/event', (session, event) => {
          try {
            const sessionId = String(session?.id ?? '')
            if (event?.type === 'request/header') {
              rememberHeader(sessionId, event.data?.header?.config)
              return
            }
            if (event?.type !== 'assistant/message') return
            const usage = event.data?.usage
            if (!usage) return
            const source = event.data?.message?.source
            const header = headers.get(sessionId)
            ledger.add({
              sessionId,
              recordKey: String(event.data?.message?.id ?? `seq-${event.seq}`),
              kind: 'chat',
              time: num(event.time),
              provider: (typeof source?.provider === 'string' && source.provider) || header?.provider || '',
              model: (typeof source?.model === 'string' && source.model) || header?.model || 'unknown',
              purpose: '',
              ...buckets(usage),
            })
          } catch (error) {
            warn(`记录会话事件失败：${error instanceof Error ? error.message : String(error)}`)
          }
        })
      } catch (error) {
        warn(`订阅 session/event 失败：${error instanceof Error ? error.message : String(error)}`)
      }

      // ── 路 2：LLM 流（只记 purpose 非空的内部调用） ─────────────────────
      // 主对话不在这里记账，直接透传原始流，零额外开销。
      try {
        ctx.on('llm/stream', (options, next) => {
          const source = next()
          const purpose = options?.purpose ? String(options.purpose) : ''
          if (!purpose) return source

          const provider = String(options?.provider || '')
          const model = String(options?.model || '')
          const startedAt = Date.now()
          let sessionId = options?.sessionId ? String(options.sessionId) : ''
          let usage = null

          async function* observe() {
            try {
              for await (const chunk of source) {
                if (chunk?.type === 'usage' && chunk.usage) usage = chunk.usage
                yield chunk
              }
            } finally {
              try {
                if (!sessionId) {
                  const agent = currentAgent()
                  if (agent?.session?.id) sessionId = String(agent.session.id)
                }
                if (usage) {
                  ledger.add({
                    sessionId: sessionId || '（内部）',
                    recordKey: `internal:${purpose}:${startedAt}`,
                    kind: 'internal',
                    time: startedAt,
                    provider, model, purpose,
                    ...buckets(usage),
                  })
                }
              } catch (error) {
                warn(`记录内部调用失败：${error instanceof Error ? error.message : String(error)}`)
              }
            }
          }

          return observe()
        })
      } catch (error) {
        warn(`订阅 llm/stream 失败：${error instanceof Error ? error.message : String(error)}`)
      }

      // ── 路 3：历史回溯（补齐插件安装前的对话调用） ──────────────────────
      // 内部调用不在会话日志里，无法回溯，只能靠路 2 实时捕获。
      const backfill = async () => {
        const persistence = ctx.get('sessionPersistence')
        if (!persistence || typeof persistence.list !== 'function') return
        let snapshots = []
        try {
          snapshots = await persistence.list()
        } catch (error) {
          warn(`列出会话失败：${error instanceof Error ? error.message : String(error)}`)
          return
        }
        let scanned = 0
        let added = 0
        for (const snapshot of snapshots) {
          const sessionId = String(snapshot?.header?.id ?? '')
          if (!sessionId) continue
          const revision = String(snapshot?.revision ?? '')
          const state = ledger.scanState(sessionId)
          if (state && revision && state.revision === revision) continue

          let handle = null
          try {
            handle = await persistence.open(sessionId, 'read')
            const fromSeq = state ? state.nextSeq : 0
            const { events } = await handle.read(fromSeq)
            let maxSeq = fromSeq - 1
            for (const event of events) {
              if (typeof event?.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq
              if (event?.type !== 'assistant/message') continue
              const usage = event.data?.usage
              if (!usage) continue
              const source = event.data?.message?.source
              ledger.add({
                sessionId,
                recordKey: String(event.data?.message?.id ?? `seq-${event.seq}`),
                kind: 'chat',
                time: num(event.time),
                provider: typeof source?.provider === 'string' ? source.provider : '',
                model: typeof source?.model === 'string' ? source.model : 'unknown',
                purpose: '',
                ...buckets(usage),
              })
              added += 1
            }
            ledger.setScanState(sessionId, revision, maxSeq + 1)
            scanned += 1
          } catch (error) {
            warn(`回溯会话 ${sessionId} 失败：${error instanceof Error ? error.message : String(error)}`)
          } finally {
            try { await handle?.close?.() } catch (e) { /* 句柄已关闭 */ }
          }
        }
        if (scanned > 0) warn(`历史回溯完成：扫描 ${scanned} 个会话，补录 ${added} 条用量`)
      }

      // 异步跑，不阻塞插件激活与 web 服务启动。
      Promise.resolve().then(backfill).catch((error) => {
        warn(`历史回溯异常：${error instanceof Error ? error.message : String(error)}`)
      })
    }

    // ── API ───────────────────────────────────────────────────────────────
    const route = (body) => {
      if (!ledger) return { ok: false, error: '账本不可用（SQLite 打开失败）' }
      const action = body?.action ? String(body.action) : 'summary'
      if (action === 'status') return { ok: true, ...ledger.status() }
      if (action === 'summary') {
        const kind = ['chat', 'internal', 'all'].includes(body?.kind) ? String(body.kind) : 'all'
        const range = resolveRange(body?.range, body?.date)
        return { ok: true, label: range.label, range: { from: range.from, to: range.to }, kind, ...ledger.summary({ ...range, kind }) }
      }
      return { ok: false, error: `未知操作：${action}` }
    }

    const webServer = ctx.get('webServer')
    if (webServer && typeof webServer.register === 'function') {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/usage/api',
        handler: async (req, res) => {
          try {
            sendJson(res, route(await readBody(req)))
          } catch (error) {
            sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }), 'dsh-usage-stats: /usage/api')
    } else {
      warn('webServer 不可用，/usage/api 未注册')
    }

    ctx.effect(() => () => { ledger?.close() }, 'dsh-usage-stats: 关闭账本')
}
