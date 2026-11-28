#!/usr/bin/env node
// 雪球「关注」时间线抓取 —— 抓当天（北京日期）关注的人发的帖子，可只保留高赞
//
// 前置：xq-browser 正在运行且已登录雪球
//   xq-browser start          # profile = ~/.cache/xq-browser，登录态在里面
//   （登录过期：xq-cdp nav https://xueqiu.com → 验证码登录 → 输码 → 点 .newLogin_modal__login__btn_viK）
//   cookie 另存一份：node $PREFIX/tmp/opencode/dump-cookies.js  → ~/.secrets/xq-cookies.json
//
// 用法:
//   node scripts/crawl_xueqiu_following.js                  # 今天，like > 10
//   node scripts/crawl_xueqiu_following.js --min-like=50    # 高赞阈值
//   node scripts/crawl_xueqiu_following.js --all            # 不过滤，全部今天的
//   node scripts/crawl_xueqiu_following.js --date=2026-11-27
//
// 输出: data/following/<YYYY-MM-DD>.json （按 id 去重，和已有文件合并）
// 接口: /v4/statuses/home_timeline.json?count=20&max_id=<next_max_id>（就是网页「关注」流）

const fs = require("fs");
const path = require("path");
const CDP = process.env.XQ_CDP || "http://127.0.0.1:9222";
const ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const bjDate = (ms) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
const today = arg("date", bjDate(Date.now()));
const MIN_LIKE = argv.includes("--all") ? -1 : Number(arg("min-like", "10"));
const MAX_PAGES = Number(arg("max-pages", "80"));
const DRY = argv.includes("--dry");

// 今天 00:00 (北京) 的毫秒时间戳
const dayStartMs = Date.parse(`${today}T00:00:00+08:00`);

(async () => {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("没有可用的页面，先 xq-browser start");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  const send = (method, params) =>
    new Promise((res) => {
      const mid = ++id;
      pend.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m.result);
      pend.delete(m.id);
    }
  };
  await new Promise((r) => (ws.onopen = r));

  try {
    const { expression } = {
      expression: `(async () => {
        const TODAY = ${JSON.stringify(today)};
        const DAY_START = ${dayStartMs};
        const MAX_PAGES = ${MAX_PAGES};
        const hdr = { "x-requested-with": "XMLHttpRequest" };
        const strip = (s) => {
          const d = document.createElement("div");
          d.innerHTML = String(s || "");
          return (d.textContent || "").replace(/\\s+/g, " ").trim();
        };
        const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
        // 雪球对高频请求会吐 HTML 风控页（<script>function interceptOrigin...），不是 JSON；
        // 退避重试，别当成"没数据"。
        const getJson = async (url, tries = 4) => {
          for (let t = 0; t < tries; t++) {
            let r, txt;
            try {
              r = await fetch(url, { headers: hdr, credentials: "include" });
              txt = await r.text();
            } catch (e) {
              if (t === tries - 1) return { error: "fetch:" + e.message };
              await sleep([5000, 12000, 25000][t] || 25000);
              continue;
            }
            const body = txt.trim();
            if (body.startsWith("{")) {
              try { return JSON.parse(body); } catch (e) {}
            }
            if (t === tries - 1) {
              return { error: r.status >= 400 ? "HTTP " + r.status + " blocked" : "non-json blocked" };
            }
            await sleep([8000, 20000, 40000][t] || 40000);
          }
          return { error: "unreachable" };
        };

        let maxId = null;
        const seen = new Map();
        let pages = 0;
        let stopReason = "max-pages";

        for (let i = 0; i < MAX_PAGES; i++) {
          const url = "/v4/statuses/home_timeline.json?count=20" + (maxId ? "&max_id=" + maxId : "");
          const j = await getJson(url);
          if (!j || j.error || j.error_description) {
            stopReason = "api:" + (j && (j.error || j.error_description));
            break;
          }
          const batch = j.home_timeline || [];
          if (!batch.length) { stopReason = "empty-page"; break; }
          let minMs = Infinity;
          for (const s of batch) {
            if (!s || s.id == null) continue;
            if (s.created_at < minMs) minMs = s.created_at;
            if (!seen.has(String(s.id))) {
              const rt = s.retweeted_status || null;
              seen.set(String(s.id), {
                id: String(s.id),
                url: "https://xueqiu.com/" + s.user_id + "/" + s.id,
                author: (s.user && s.user.screen_name) || "",
                author_id: s.user_id,
                created_at: new Date(s.created_at).toISOString(),
                created_at_bj: new Date(s.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
                like_count: s.like_count || 0,
                reply_count: s.reply_count || 0,
                retweet_count: s.retweet_count || 0,
                is_retweet: !!s.retweet_status_id,
                retweet_from: rt ? (rt.user && rt.user.screen_name) || "" : null,
                text: strip(s.description || s.text || "").slice(0, 2000),
                time_before: s.timeBefore || null,
              });
            }
          }
          pages++;
          await sleep(1500 + Math.floor(Math.random() * 500));
          if (minMs < DAY_START) { stopReason = "reached-yesterday"; break; }
          const next = j.next_max_id;
          if (!next || String(next) === String(maxId)) { stopReason = "no-next"; break; }
          maxId = next;
        }

        return { ok: true, pages, stopReason, items: [...seen.values()] };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    };
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    const v = res && res.result ? res.result.value : null;
    if (!v || v.ok !== true) throw new Error("抓取失败: v=" + JSON.stringify(v).slice(0, 200) + " res=" + JSON.stringify(res).slice(0, 600));

    const all = v.items || [];
    const todays = all.filter((p) => p.created_at_bj.startsWith(today.replace(/-/g, "/")));
    const hot = todays
      .filter((p) => p.like_count > MIN_LIKE)
      .sort((a, b) => b.like_count - a.like_count);

    const outDir = path.join(ROOT, "data", "following");
    const outFile = path.join(outDir, `${today}.json`);
    if (DRY) {
      console.log(JSON.stringify({ pages: v.pages, stopReason: v.stopReason, fetched: all.length, today_total: todays.length, hot_total: hot.length }, null, 1));
      console.log(todays.slice(0, 5).map((p) => `${p.like_count}赞 ${p.author} ${p.text.slice(0, 40)}`).join("\n"));
      return;
    }
    fs.mkdirSync(outDir, { recursive: true });

    let rec = {
      date: today,
      window: "today",
      source: "xueqiu-home-timeline-cdp",
      min_like: MIN_LIKE,
      crawled_at_beijing: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }),
      pages: v.pages,
      stop_reason: v.stopReason,
      fetched_total: all.length,
      today_total: todays.length,
      hot_total: hot.length,
      posts: hot,
    };
    let prevRec = null;
    if (fs.existsSync(outFile)) {
      try {
        const prev = JSON.parse(fs.readFileSync(outFile, "utf8"));
        prevRec = prev;
        const byId = new Map((prev.posts || []).map((p) => [p.id, p]));
        for (const p of hot) byId.set(p.id, { ...(byId.get(p.id) || {}), ...p });
        rec.posts = [...byId.values()].sort((a, b) => b.like_count - a.like_count);
        rec.hot_total = rec.posts.length;
        rec.today_total = Math.max(rec.today_total || 0, prev.today_total || 0);
        rec.fetched_total = Math.max(rec.fetched_total || 0, prev.fetched_total || 0);
      } catch (e) { console.error("[warn] 合并旧文件失败: " + e.message); }
    }
    rec.first_crawled_at = (prevRec && (prevRec.first_crawled_at || prevRec.crawled_at_beijing)) || rec.crawled_at_beijing;
    fs.writeFileSync(outFile, JSON.stringify(rec, null, 2), "utf8");
    console.log(
      JSON.stringify(
        { file: outFile, pages: v.pages, stop: v.stopReason, fetched: all.length, today_total: todays.length, hot_total: rec.hot_total },
        null,
        1
      )
    );
  } finally {
    ws.close();
  }
})().catch((e) => {
  console.error("ERR: " + e.message);
  process.exit(1);
});
