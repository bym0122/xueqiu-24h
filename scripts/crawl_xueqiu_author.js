#!/usr/bin/env node
// 雪球作者主页「今天」帖子抓取（登录态 CDP）
// 用法: node scripts/crawl_xueqiu_author.js 9493911686 [1910783512 ...]
// 前置: xq-browser start（已登录）
// 输出: data/xueqiu/<uid>/<YYYY-MM-DD>.json（按 id 去重合并，只留当天北京日期）
const fs = require("fs");
const path = require("path");
const CDP = process.env.XQ_CDP || "http://127.0.0.1:9222";
const ROOT = path.resolve(__dirname, "..");
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const DAY_START = Date.parse(`${today}T00:00:00+08:00`);
const uids = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (!uids.length) { console.log("用法: node scripts/crawl_xueqiu_author.js <uid> [uid...]"); process.exit(1); }

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
    for (const uid of uids) {
      const expression = `(async () => {
        const DAY_START = ${DAY_START};
        const strip = (s) => { const d = document.createElement('div'); d.innerHTML = String(s || ''); return (d.textContent || '').replace(/\\s+/g, ' ').trim(); };
        const all = new Map();
        let stop = 'max-pages';
        for (let p = 1; p <= 40; p++) {
          const u = '/v4/statuses/user_timeline.json?user_id=${uid}&page=' + p + '&count=20';
          let j = null;
          for (let t = 0; t < 4; t++) {
            const r = await fetch(u, { headers: { 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' });
            const txt = await r.text();
            if (txt.trim().startsWith('{')) { try { j = JSON.parse(txt); break; } catch (e) {} }
            await new Promise((s) => setTimeout(s, [5000, 12000, 25000][t] || 25000));
          }
          if (!j) { stop = 'blocked'; break; }
          const arr = j.statuses || [];
          if (!arr.length) { stop = 'empty'; break; }
          let minMs = Infinity;
          for (const s of arr) {
            if (s.created_at < minMs) minMs = s.created_at;
            if (!all.has(String(s.id))) all.set(String(s.id), {
              id: String(s.id),
              created_at: new Date(s.created_at).toISOString(),
              kind: s.retweet_status_id ? 'retweet' : (s.longTextForIOS ? 'long' : 'status'),
              url: 'https://xueqiu.com/' + (s.user_id || '${uid}') + '/' + s.id,
              text: strip(s.description || s.text || '').slice(0, 2000),
              likes: s.like_count || 0,
              comments: s.reply_count || 0,
              retweets: s.retweet_count || 0,
              symbol: (s.topic_symbol || '') || null,
              retweet_from: s.retweeted_status && s.retweeted_status.user ? s.retweeted_status.user.screen_name : null,
            });
          }
          if (minMs < DAY_START) { stop = 'reached-yesterday'; break; }
          if (!j.statuses || arr.length < 20) { stop = 'end-of-pages'; break; }
          await new Promise((s) => setTimeout(s, 1200));
        }
        const todays = [...all.values()].filter((x) => new Date(x.created_at).getTime() >= DAY_START);
        return { ok: true, stop, fetched: all.size, today: todays };
      })()`;
      const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      const v = res && res.result ? res.result.value : null;
      if (!v || !v.ok) { console.error(`[${uid}] 失败: ` + JSON.stringify(res).slice(0, 200)); continue; }

      const dir = path.join(ROOT, "data", "xueqiu", uid);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${today}.json`);
      let rec = {
        user_id: uid,
        profile_url: `https://xueqiu.com/u/${uid}`,
        window: "today",
        posts: v.today,
        crawled_at_beijing: new Date().toISOString(),
        crawled_date: today,
        deep: false,
        post_count: v.today.length,
        source: "登录态 xq-cdp(API /v4/statuses/user_timeline.json,按今天北京日期筛)",
        stop_reason: v.stop,
      };
      if (fs.existsSync(file)) {
        try {
          const prev = JSON.parse(fs.readFileSync(file, "utf8"));
          const byId = new Map((prev.posts || []).map((p) => [p.id, p]));
          for (const p of v.today) byId.set(p.id, { ...(byId.get(p.id) || {}), ...p });
          rec.posts = [...byId.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
          rec.post_count = rec.posts.length;
        } catch (e) { console.error("[warn] 合并失败: " + e.message); }
      }
      fs.writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
      console.log(JSON.stringify({ uid, file, stop: v.stop, fetched: v.fetched, today: v.today.length, merged: rec.post_count }));
      await new Promise((s) => setTimeout(s, 1000));
    }
  } finally { ws.close(); }
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
