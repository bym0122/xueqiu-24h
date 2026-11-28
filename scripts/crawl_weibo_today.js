#!/usr/bin/env node
// 微博「今天」抓取（登录态 CDP，since_id 翻页）
// 用法: node scripts/crawl_weibo_today.js 3962719063 4044309290 [--max-pages=10]
// 前置: xq-browser start，且已登录 m.weibo.cn（cookie 里有 SUBP）
//   登录过期时: xq-cdp nav https://passport.weibo.cn/signin/login → 验证码登录
// 输出: data/weibo/<uid>/<YYYY-MM-DD>.json（window:"today"，按 id 去重合并）
// 说明: 匿名接口每页只给 10 条且第 2 页 ok:-100；登录后 since_id 可翻到底（昨天实测 40 页 397 条）

const fs = require("fs");
const path = require("path");
const CDP = process.env.XQ_CDP || "http://127.0.0.1:9222";
const ROOT = path.resolve(__dirname, "..");
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const DAY_START = Date.parse(`${today}T00:00:00+08:00`);
const args = process.argv.slice(2);
const MAX_PAGES = Number((args.find((a) => a.startsWith("--max-pages=")) || "").split("=")[1] || 10);
const uids = args.filter((a) => /^\d+$/.test(a));
if (!uids.length) { console.log("用法: node scripts/crawl_weibo_today.js <uid> [uid...] [--max-pages=10]"); process.exit(1); }

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
    // 先切到微博域名（cookie 分域，停在雪球页看不到 SUBP），再确认登录态
    await send("Page.enable");
    await send("Page.navigate", { url: "https://m.weibo.cn/" });
    await new Promise((r) => setTimeout(r, 3500));
    const ck = await send("Runtime.evaluate", { expression: `document.cookie.includes('SUBP=')`, returnByValue: true });
    if (!ck.result || !ck.result.value) {
      console.error("⚠️ 当前页面没有 SUBP cookie（未登录 m.weibo.cn）。先登录再跑。");
      process.exit(2);
    }

    for (const uid of uids) {
      const expression = `(async () => {
        const DAY_START = ${DAY_START};
        const MAX_PAGES = ${MAX_PAGES};
        const hdr = { 'x-requested-with': 'XMLHttpRequest', 'referer': 'https://m.weibo.cn/' };
        const all = new Map();
        let since = null, pages = 0, stop = 'max-pages', err = null;
        for (let i = 0; i < MAX_PAGES; i++) {
          const url = 'https://m.weibo.cn/api/container/getIndex?type=uid&value=${uid}' +
            '&containerid=107603${uid}' + (since ? '&since_id=' + encodeURIComponent(since) : '');
          let j = null;
          for (let t = 0; t < 3; t++) {
            try {
              const r = await fetch(url, { headers: hdr, credentials: 'include' });
              j = await r.json();
              if (j && j.ok) break;
            } catch (e) { err = String(e); }
            await new Promise((s) => setTimeout(s, [4000, 10000][t] || 10000));
          }
          if (!j || !j.ok) { stop = 'api:' + JSON.stringify(j && (j.msg || j.code)).slice(0, 40); break; }
          const info = (j.data && j.data.cardlistInfo) || {};
          const cards = (j.data && j.data.cards) || [];
          let minMs = Infinity, added = 0;
          for (const c of cards) {
            for (const it of (c.card_group || [c])) {
              const m = it.mblog || it;
              if (!m || m.id == null) continue;
              const ms = Date.parse(String(m.created_at || '').replace(' +0800', ' +08:00'));
              if (!Number.isNaN(ms) && ms < minMs) minMs = ms;
              if (!all.has(String(m.id))) {
                all.set(String(m.id), {
                  id: String(m.id),
                  created_at: Number.isNaN(ms) ? null : new Date(ms).toISOString(),
                  kind: m.retweeted_status ? 'retweet' : (m.isLongText ? 'long' : 'status'),
                  url: 'https://weibo.com/${uid}/' + (m.bid || m.id),
                  text: String(m.text || m.raw_text || '')
                    .replace(/<br\\s*\\/?>/gi, '\\n').replace(/<[^>]+>/g, '')
                    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
                    .trim().slice(0, 2000),
                  source: String(m.source || '').replace(/<[^>]+>/g, '').trim(),
                  reposts: m.reposts_count ?? null,
                  comments: m.comments_count ?? null,
                  attitudes: m.attitudes_count ?? null,
                  pics: (m.pics || []).map((p) => (p.large && p.large.url) || p.url).filter(Boolean),
                });
                added++;
              }
            }
          }
          pages++;
          if (minMs < DAY_START) { stop = 'reached-yesterday'; break; }
          const next = info.since_id ? String(info.since_id) : null;
          if (!next || cards.length === 0) { stop = 'no-next'; break; }
          if (added === 0 && pages > 1) { stop = 'no-fresh'; break; }
          since = next;
          await new Promise((s) => setTimeout(s, 1200));
        }
        const items = [...all.values()].filter((p) => p.created_at && new Date(p.created_at).getTime() >= DAY_START)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return { ok: true, pages, stop, err, fetched: all.size, today: items };
      })()`;
      const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      const v = res && res.result ? res.result.value : null;
      if (!v || !v.ok) { console.error(`[${uid}] 失败: ` + JSON.stringify(res).slice(0, 200)); continue; }

      const dir = path.join(ROOT, "data", "weibo", uid);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${today}.json`);
      const stamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
      let rec = {
        user_id: uid,
        profile_url: `https://weibo.com/u/${uid}`,
        window: "today",
        source: "local-chromium-logged-in-paged",
        crawled_at_beijing: stamp,
        crawled_date: today,
        harvested: v.fetched,
        in24h: v.today.length,
        login_wall: v.fetched === 0,
        post_count: v.today.length,
        posts: v.today,
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
      console.log(JSON.stringify({ uid, file, pages: v.pages, stop: v.stop, fetched: v.fetched, today: v.today.length, merged: rec.post_count }));
      await new Promise((s) => setTimeout(s, 1500));
    }
  } finally { ws.close(); }
})().catch((e) => { console.error("ERR: " + e.message); process.exit(1); });
