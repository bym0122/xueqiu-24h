#!/usr/bin/env node
// 个股讨论区「今天」抓取（登录态 CDP）—— 全量 + 高赞(>10) 两份口径
// 用法: node scripts/crawl_stock_hot.js SH601872:招商轮船 SZ000933:神火股份 [...]
// 前置: xq-browser start（已登录）
// 输出: data/stock_hot/<TICKER>_<YYYY-MM-DD>_<HH-MM>.json
// 接口: /query/v1/symbol/search/status.json?symbol=<TICKER>&source=user&sort=time&page=N&count=20
const fs = require("fs");
const path = require("path");
const CDP = process.env.XQ_CDP || "http://127.0.0.1:9222";
const ROOT = path.resolve(__dirname, "..");
const MIN_LIKE = Number(process.env.MIN_LIKE || 10);
const now = new Date();
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const hhmm = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(now).replace(":", "-");
const DAY_START = Date.parse(`${today}T00:00:00+08:00`);

const targets = process.argv.slice(2).map((a) => {
  const [ticker, name] = a.split(":");
  return { ticker, name: name || ticker };
}).filter((t) => /^[A-Z]{2}\d{6}$/.test(t.ticker));
if (!targets.length) { console.log("用法: node scripts/crawl_stock_hot.js SH601872:招商轮船 SZ000933:神火股份"); process.exit(1); }

(async () => {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("没有页面，先 xq-browser start");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (m, p) => new Promise((r) => { const mid = ++id; pend.set(mid, r); ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  await new Promise((r) => (ws.onopen = r));
  try {
    for (const { ticker, name } of targets) {
      const expression = `(async () => {
        const DAY_START = ${DAY_START};
        const strip = (s) => { const d = document.createElement('div'); d.innerHTML = String(s || ''); return (d.textContent || '').replace(/\\s+/g, ' ').trim(); };
        const all = new Map();
        let stop = 'max-pages';
        for (let p = 1; p <= 60; p++) {
          const u = '/query/v1/symbol/search/status.json?comment=0&symbol=${ticker}&hl=0&source=user&sort=time&q=&type=11&page=' + p + '&count=20';
          let j = null;
          for (let t = 0; t < 4; t++) {
            const r = await fetch(u, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' });
            const txt = await r.text();
            if (txt.trim().startsWith('{')) { try { j = JSON.parse(txt); break; } catch (e) {} }
            await new Promise((s) => setTimeout(s, [5000, 12000, 25000][t] || 25000));
          }
          if (!j) { stop = 'blocked'; break; }
          const arr = j.list || [];
          if (!arr.length) { stop = 'empty'; break; }
          let minMs = Infinity;
          for (const s of arr) {
            if (s.created_at < minMs) minMs = s.created_at;
            if (!all.has(String(s.id))) all.set(String(s.id), {
              id: String(s.id),
              created_at: new Date(s.created_at).toISOString(),
              user: (s.user && s.user.screen_name) || '',
              user_id: s.user_id,
              like: s.like_count || 0,
              comment: s.reply_count || 0,
              retweet: s.retweet_count || 0,
              text: strip(s.description || s.text || '').slice(0, 1500),
              link: 'https://xueqiu.com/' + s.user_id + '/' + s.id,
            });
          }
          if (minMs < DAY_START) { stop = 'reached-yesterday'; break; }
          if (arr.length < 20) { stop = 'end-of-pages'; break; }
          await new Promise((s) => setTimeout(s, 900));
        }
        const todays = [...all.values()].filter((x) => new Date(x.created_at).getTime() >= DAY_START)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return { ok: true, stop, fetched: all.size, today: todays };
      })()`;
      const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      const v = res && res.result ? res.result.value : null;
      if (!v || !v.ok) { console.error(`[${ticker}] 失败: ` + JSON.stringify(res).slice(0, 200)); continue; }

      const hot = v.today.filter((p) => p.like > MIN_LIKE).sort((a, b) => b.like - a.like);
      const dir = path.join(ROOT, "data", "stock_hot");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${ticker}_${today}_${hhmm}.json`);
      const rec = {
        ticker,
        name,
        date: today,
        source: "xueqiu讨论区(登录态xq-cdp,API翻页,全量抓至出现昨天)",
        stop_reason: v.stop,
        today_total: v.today.length,
        hot_count: hot.length,
        min_like: MIN_LIKE,
        note: `口径: today_total=当天讨论全量, hot=当天点赞>${MIN_LIKE} 的子集`,
        hot: hot.map((p) => ({
          like: p.like,
          comment: p.comment,
          user: p.user,
          created_at: p.created_at,
          date: new Date(p.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
          text: p.text,
          link: p.link,
        })),
      };
      fs.writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
      console.log(JSON.stringify({ ticker, file, stop: v.stop, fetched: v.fetched, today_total: v.today.length, hot: hot.length }));
      await new Promise((s) => setTimeout(s, 1000));
    }
  } finally { ws.close(); }
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
