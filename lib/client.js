/**
 * dsh-usage-stats — CLIENT half（浏览器端 bundle，由宿主 __ModuleLoader__ 加载）。
 *
 * 在会话视图顶部注册「用量统计」tab，渲染按服务商分组、按模型展开的用量表：
 *   模型 | 输入 | 输出 | 缓存命中 | 缓存读写 | 总量
 * 列结构与 PI 的用量统计报表保持一致（总量 = 四类之和）。
 */
window.__ModuleLoader__.load({
  id: "dsh-usage-stats",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const el = React.createElement;

    // ── 文案（中文为键，英文为值；跟随宿主语言） ──────────────────────────
    const EN = {
      "用量统计": "Usage Stats",
      "记录每一次模型调用的 token 用量": "Token usage for every model call",
      "今日": "Today", "本周": "This week", "上周": "Last week", "全部": "All", "指定日期": "Pick a date",
      "口径": "Scope", "对话": "Chat", "内部": "Internal",
      "刷新": "Refresh", "正在加载…": "Loading…", "暂无记录": "No records",
      "模型": "Model", "输入": "Input", "输出": "Output",
      "缓存命中": "Cache hit", "缓存读写": "Cache write", "总量": "Total",
      "总 Token": "Total tokens",
      "内部调用自插件安装之日起统计，无法回溯历史": "Internal calls are counted from install time; history cannot be backfilled",
      "账本": "Ledger", "条记录": "records", "会话": "sessions",
    };
    let LANG = (() => {
      try { return String(navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en"; } catch (e) { return "zh"; }
    })();
    const t = (s) => (LANG === "en" ? EN[s] || s : s);

    // ── 样式 ──────────────────────────────────────────────────────────────
    const st = {
      root: { display: "flex", flexDirection: "column", gap: 12, padding: "16px 20px", width: "100%", boxSizing: "border-box", minWidth: 0 },
      head: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
      title: { fontSize: "1.15em", fontWeight: 600 },
      sub: { fontSize: "0.85em", opacity: 0.6, marginTop: 2 },
      bar: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
      seg: { display: "inline-flex", border: "1px solid rgba(128,128,128,.35)", borderRadius: 6, overflow: "hidden" },
      segBtn: { border: 0, background: "transparent", padding: "4px 10px", fontSize: "0.88em", cursor: "pointer", color: "inherit" },
      segOn: { border: 0, background: "rgba(90,140,255,.22)", padding: "4px 10px", fontSize: "0.88em", cursor: "pointer", color: "inherit", fontWeight: 600 },
      btn: { border: "1px solid rgba(128,128,128,.35)", background: "transparent", borderRadius: 6, padding: "4px 10px", fontSize: "0.88em", cursor: "pointer", color: "inherit" },
      date: { border: "1px solid rgba(128,128,128,.35)", background: "transparent", borderRadius: 6, padding: "3px 8px", fontSize: "0.88em", color: "inherit" },
      hint: { fontSize: "0.82em", opacity: 0.6 },
      // 宽表必须可横向滚动，窄屏下列不被挤压
      tableWrap: { width: "100%", overflowX: "auto", border: "1px solid rgba(128,128,128,.25)", borderRadius: 8 },
      table: { width: "100%", minWidth: 620, borderCollapse: "collapse", fontSize: "0.9em" },
      thName: { textAlign: "left", padding: "8px 12px", fontWeight: 600, fontSize: "0.85em", opacity: 0.75, borderBottom: "1px solid rgba(128,128,128,.3)", whiteSpace: "nowrap" },
      thNum: { textAlign: "right", padding: "8px 12px", fontWeight: 600, fontSize: "0.85em", opacity: 0.75, borderBottom: "1px solid rgba(128,128,128,.3)", whiteSpace: "nowrap" },
      tdName: { padding: "7px 12px", borderBottom: "1px solid rgba(128,128,128,.15)" },
      tdNum: { padding: "7px 12px", textAlign: "right", borderBottom: "1px solid rgba(128,128,128,.15)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
      provRow: { background: "rgba(128,128,128,.08)", cursor: "pointer", fontWeight: 600 },
      modelName: { paddingLeft: 28, opacity: 0.9 },
      totalRow: { fontWeight: 700, borderTop: "2px solid rgba(128,128,128,.45)" },
      empty: { padding: "24px 12px", textAlign: "center", opacity: 0.6, fontSize: "0.9em" },
      err: { padding: "10px 12px", borderRadius: 6, background: "rgba(220,60,60,.12)", fontSize: "0.88em" },
    };

    // ── 避让宿主的对话宽度把手 ────────────────────────────────────────────
    // 宿主在对话正文两侧各放一条 40px 的 col-resize 把手（ui-conversation
    // ConversationRoot，z-index 8），只在对话视图下有意义，且仅对带 composer
    // overlay 的视图自我隐藏。本页铺满对话列，把手会盖住页内按钮并抢走
    // pointerdown。抬本页层级能盖住把手，但底部输入框只有 z-index 7，本页反
    // 而会压住输入框；因此改为在用量页挂载期间隐藏把手——切回对话 tab 时本页
    // 卸载，body:has 失配，把手自动恢复。
    if (typeof document !== "undefined" && !document.getElementById("dsh-usage-stats-handle-fix")) {
      const style = document.createElement("style");
      style.id = "dsh-usage-stats-handle-fix";
      style.textContent = "body:has([data-usage-stats]) [data-width-handle]{display:none}";
      document.head.append(style);
    }

    // ── 工具 ──────────────────────────────────────────────────────────────
    /** KM 格式化：>=1e6 用 M，>=1e3 用 K，两位小数（与 PI 报表一致）。 */
    function kmb(n) {
      const v = Number(n) || 0;
      if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
      if (v >= 1e3) return (v / 1e3).toFixed(2) + "K";
      return String(v);
    }
    /** 精确值：千分位分隔，用于 hover 提示。 */
    function exact(n) {
      return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
    function api(payload) {
      return fetch("/usage/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then((r) => r.json());
    }

    // ── 用量表 ────────────────────────────────────────────────────────────
    function StatsTable(props) {
      const rows = props.rows || [];
      const [collapsed, setCollapsed] = React.useState({});

      const visible = React.useMemo(() => {
        const out = [];
        let hide = false;
        for (const row of rows) {
          if (row.level === "provider") {
            hide = !!collapsed[row.name];
            out.push(row);
          } else if (row.level === "model") {
            if (!hide) out.push(row);
          } else {
            out.push(row);
          }
        }
        return out;
      }, [rows, collapsed]);

      const cells = (row) => [
        el("td", { key: "n", style: Object.assign({}, st.tdName, row.level === "model" ? st.modelName : null) },
          row.level === "model" ? "└─ " + row.name : row.name),
        el("td", { key: "i", style: st.tdNum, title: exact(row.input) }, kmb(row.input)),
        el("td", { key: "o", style: st.tdNum, title: exact(row.output) }, kmb(row.output)),
        el("td", { key: "r", style: st.tdNum, title: exact(row.cacheRead) }, kmb(row.cacheRead)),
        el("td", { key: "w", style: st.tdNum, title: exact(row.cacheWrite) }, kmb(row.cacheWrite)),
        el("td", { key: "t", style: st.tdNum, title: exact(row.total) }, kmb(row.total)),
      ];

      return el("div", { style: st.tableWrap },
        el("table", { style: st.table },
          el("thead", null, el("tr", null,
            el("th", { style: st.thName }, t("模型")),
            el("th", { style: st.thNum }, t("输入")),
            el("th", { style: st.thNum }, t("输出")),
            el("th", { style: st.thNum }, t("缓存命中")),
            el("th", { style: st.thNum }, t("缓存读写")),
            el("th", { style: st.thNum }, t("总量")),
          )),
          el("tbody", null, visible.map((row, idx) => {
            const style = row.level === "provider" ? st.provRow : row.level === "total" ? st.totalRow : null;
            const onClick = row.level === "provider"
              ? () => setCollapsed((prev) => Object.assign({}, prev, { [row.name]: !prev[row.name] }))
              : undefined;
            return el("tr", {
              key: row.level + ":" + (row.provider || "") + ":" + row.name + ":" + idx,
              style,
              onClick,
            },
              row.level === "provider"
                ? [
                  el("td", { key: "n", style: st.tdName }, (collapsed[row.name] ? "▸ " : "▾ ") + row.name + "  ·  " + row.messages + " " + t("条记录")),
                  el("td", { key: "i", style: st.tdNum, title: exact(row.input) }, kmb(row.input)),
                  el("td", { key: "o", style: st.tdNum, title: exact(row.output) }, kmb(row.output)),
                  el("td", { key: "r", style: st.tdNum, title: exact(row.cacheRead) }, kmb(row.cacheRead)),
                  el("td", { key: "w", style: st.tdNum, title: exact(row.cacheWrite) }, kmb(row.cacheWrite)),
                  el("td", { key: "t", style: st.tdNum, title: exact(row.total) }, kmb(row.total)),
                ]
                : cells(row));
          })),
        ));
    }

    // ── 主面板 ────────────────────────────────────────────────────────────
    const RANGES = [
      { k: "today", label: "今日" },
      { k: "week", label: "本周" },
      { k: "lastweek", label: "上周" },
      { k: "all", label: "全部" },
      { k: "date", label: "指定日期" },
    ];
    const KINDS = [
      { k: "all", label: "全部" },
      { k: "chat", label: "对话" },
      { k: "internal", label: "内部" },
    ];

    function UsageStatsPanel() {
      const [range, setRange] = React.useState("today");
      const [kind, setKind] = React.useState("all");
      const [date, setDate] = React.useState("");
      const [state, setState] = React.useState({ status: "loading", data: null, error: "" });

      const load = React.useCallback(() => {
        setState((prev) => ({ status: "loading", data: prev.data, error: "" }));
        api({ action: "summary", range, kind, date: range === "date" && date ? date : undefined })
          .then((res) => {
            if (res && res.ok) setState({ status: "done", data: res, error: "" });
            else setState({ status: "error", data: null, error: (res && res.error) || t("暂无记录") });
          })
          .catch((e) => setState({ status: "error", data: null, error: String((e && e.message) || e) }));
      }, [range, kind, date]);

      React.useEffect(() => { load(); }, [load]);

      const data = state.data || {};
      const rows = data.rows || [];
      const hasData = rows.length > 1 || (data.messages || 0) > 0;

      return el("div", { style: st.root, "data-usage-stats": "" },
        el("div", { style: st.head },
          el("div", null,
            el("div", { style: st.title }, t("用量统计")),
            el("div", { style: st.sub }, data.label || t("记录每一次模型调用的 token 用量")),
          ),
          el("div", { style: st.bar },
            el("button", { style: st.btn, onClick: load }, t("刷新")),
          ),
        ),

        el("div", { style: st.bar },
          el("span", { style: st.hint }, t("口径") + ":"),
          el("div", { style: st.seg }, KINDS.map((item) =>
            el("button", { key: item.k, style: kind === item.k ? st.segOn : st.segBtn, onClick: () => setKind(item.k) }, t(item.label)))),
          el("span", { style: { width: 8 } }),
          el("div", { style: st.seg }, RANGES.map((item) =>
            el("button", { key: item.k, style: range === item.k ? st.segOn : st.segBtn, onClick: () => setRange(item.k) }, t(item.label)))),
          range === "date"
            ? el("input", { type: "date", style: st.date, value: date, onChange: (e) => setDate(e.target.value) })
            : null,
        ),

        kind !== "chat"
          ? el("div", { style: st.hint }, t("内部调用自插件安装之日起统计，无法回溯历史"))
          : null,

        state.error
          ? el("div", { style: st.err }, state.error)
          : null,

        state.status === "loading" && !hasData
          ? el("div", { style: st.empty }, t("正在加载…"))
          : hasData
            ? el(StatsTable, { rows })
            : el("div", { style: st.empty }, t("暂无记录")),
      );
    }

    // ── 插件注册 ──────────────────────────────────────────────────────────
    const inject = ["slots"];

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;

      const locale = ctx.get("locale");
      try {
        if (locale && typeof locale.getLocale === "function") {
          const snap = locale.getLocale();
          LANG = snap && snap.active === "zh" ? "zh" : "en";
        }
      } catch (e) { /* 语言服务不可读时沿用浏览器语言 */ }

      slots.inject("conversation.view", () => slots.register(
        { name: "conversation.view", id: "usage-stats", order: 25, label: () => t("用量统计") },
        UsageStatsPanel,
      ));
    }

    exports.inject = inject;
    exports.apply = apply;

    // __ModuleLoader__ 用 factory 的返回值作为模块导出，漏掉它会拿到 undefined。
    return module.exports;
  },
});
