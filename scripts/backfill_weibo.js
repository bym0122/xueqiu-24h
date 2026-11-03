#!/usr/bin/env node
// 微博历史回填 —— 本机版（chromium + CDP，翻页取历史）
//
// 为什么单独写一个：crawl_weibo_local.js 只取第 1 页（约 24h），
// 建「方法基线」需要几个月的历史。m.weibo.cn 的 container API 支持 &page=N，
// 但必须从页面上下文 fetch（curl 一律 432）。
//
// 用法:
//   node scripts/backfill_weibo.js                       # 两个账号，最多 200 页
//   node scripts/backfill_weibo.js 3962719063 --pages 50
//   node scripts/backfill_weibo.js --until 2025-06-01
//
// 输出: data/weibo/<uid>/_backfill/YYYY-MM.json（按月分文件，不动日常抓取目录）

const { spawn } = require("child_process");
const CRI = require(
  "/data/data/com.termux/files/usr/lib/node_modules/bwb-browser/node_modules/chrome-remote-interface"
);
const fs = require("fs");
const path = require("path");

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const PORT = 9339;
const PROFILE = path.join(process.env.PREFIX || "/tmp", "tmp/opencode/cr-weibo-backfill");

const args = process.argv.slice(2);
const uids = args.filter((a) => /^\d+$/.test(a));
const pagesIdx = args.indexOf("--pages");
const MAX_PAGES = pagesIdx > -1 ? parseInt(args[pagesIdx + 1], 10) || 200 : 200;
const untilIdx = args.indexOf("--until");
const UNTIL = untilIdx > -1 ? args[untilIdx + 1] : "2025-06-01";
if (!uids.length) uids.push("3962719063", "4044309290");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeCard(card, uid) {
  const m = card.mblog || card;
  if (!m || m.id == null) return null;
  const createdMs = Date.parse(m.created_at || "");
  const text = String(m.text || m.raw_text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim()
    .slice(0, 4000);
  const kind = m.retweeted_status ? "retweet" : m.isLongText ? "long" : "status";
  return {
    id: String(m.id),
    mid: m.mid ? String(m.mid) : String(m.id),
    created_at: Number.isNaN(createdMs) ? String(m.created_at || "") : new Date(createdMs).toISOString(),
    kind,
    url: `https://weibo.com/${uid}/${m.bid || m.id}`,
    text,
    reposts: m.reposts_count ?? null,
    comments: m.comments_count ?? null,
    attitudes: m.attitudes_count ?? null,
    page_url: (m.page_info && m.page_info.page_url) || null,
  };
}

function extractPosts(j, uid) {
  const out = [];
  for (const c of (j && j.data && j.data.cards) || []) {
    for (const item of c.card_group || [c]) {
      const n = normalizeCard(item, uid);
      if (n) out.push(n);
    }
  }
  for (const s of (j && j.data && j.data.statuses) || []) {
    const n = normalizeCard(s, uid);
    if (n) out.push(n);
  }
  return out;
}

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      fs.unlinkSync(path.join(PROFILE, f));
    } catch {}
  }

  const proc = spawn(
    "chromium-browser",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--user-agent=" + UA,
      "--lang=zh-CN",
      "--window-size=390,844",
      "--user-data-dir=" + PROFILE,
      "--remote-debugging-port=" + PORT,
      "about:blank",
    ],
    { stdio: "ignore", detached: true }
  );
  proc.unref();
  const kill = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
  };
  const guard = setTimeout(() => {
    kill();
    process.exit(1);
  }, 1800000);
  guard.unref();

  let client = null;
  for (let i = 0; i < 60; i++) {
    try {
      client = await CRI({ port: PORT });
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!client) {
    console.error("连不上 Chromium 调试端口");
    kill();
    process.exit(1);
  }

  const { Page, Runtime } = client;
  await Page.enable();
  await Runtime.enable();
  const ev = async (expr, awaitPromise = false) => {
    const r = await Runtime.evaluate({ expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval error");
    return r.result.value;
  };

  await Page.navigate({ url: "https://m.weibo.cn/" });
  await Page.loadEventFired().catch(() => {});
  await sleep(4000);
  console.log(`[cookie] ${String(await ev("document.cookie")).slice(0, 90)}`);

  for (const uid of uids) {
    const all = new Map();
    let emptyStreak = 0;
    let stopPage = MAX_PAGES;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const apiUrl =
        `https://m.weibo.cn/api/container/getIndex?type=uid&value=${uid}` +
        `&containerid=107603${uid}&page=${page}`;
      let res;
      try {
        res = await ev(
          `fetch(${JSON.stringify(apiUrl)},{headers:{'x-requested-with':'XMLHttpRequest'},credentials:'include'}).then(async r=>({s:r.status,t:await r.text()}))`,
          true
        );
      } catch (e) {
        console.log(`[${uid}] page ${page} 请求异常，停在这里：${e.message}`);
        stopPage = page - 1;
        break;
      }
      if (res.s !== 200) {
        console.log(`[${uid}] page ${page} HTTP ${res.s}，停`);
        stopPage = page - 1;
        break;
      }
      let j;
      try {
        j = JSON.parse(res.t);
      } catch {
        console.log(`[${uid}] page ${page} 非 JSON，停`);
        stopPage = page - 1;
        break;
      }
      const batch = extractPosts(j, uid);
      const before = all.size;
      let oldest = null;
      for (const p of batch) {
        if (!all.has(p.id)) all.set(p.id, p);
        if (p.created_at && (!oldest || p.created_at < oldest)) oldest = p.created_at;
      }
      const added = all.size - before;
      if (page % 10 === 0 || page === 1) {
        console.log(
          `[${uid}] page ${page}: 本页 ${batch.length} 条，新增 ${added}，累计 ${all.size}，最早 ${oldest || "-"}`
        );
      }
      if (batch.length === 0) {
        emptyStreak++;
        if (emptyStreak >= 2) {
          console.log(`[${uid}] page ${page} 连续空页，收工`);
          stopPage = page;
          break;
        }
      } else emptyStreak = 0;

      if (oldest && oldest.slice(0, 10) < UNTIL) {
        console.log(`[${uid}] 已到 ${UNTIL}，收工（page ${page}）`);
        stopPage = page;
        break;
      }
      await sleep(1200);
    }

    // 按月分组写出
    const dir = path.join(process.cwd(), "data", "weibo", uid, "_backfill");
    fs.mkdirSync(dir, { recursive: true });
    const byMonth = new Map();
    for (const p of all.values()) {
      const mo = (p.created_at || "").slice(0, 7) || "unknown";
      if (!byMonth.has(mo)) byMonth.set(mo, []);
      byMonth.get(mo).push(p);
    }
    for (const [mo, posts] of byMonth) {
      const file = path.join(dir, `${mo}.json`);
      let merged = new Map();
      if (fs.existsSync(file)) {
        try {
          for (const p of JSON.parse(fs.readFileSync(file, "utf8")).posts || []) merged.set(p.id, p);
        } catch {}
      }
      for (const p of posts) merged.set(p.id, p);
      const out = {
        user_id: uid,
        month: mo,
        source: "backfill-weibo",
        updated_at: new Date().toISOString(),
        posts: [...merged.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
      };
      fs.writeFileSync(file, JSON.stringify(out, null, 1));
      console.log(`  → ${file} (${out.posts.length} 条)`);
    }
    console.log(`[${uid}] 合计 ${all.size} 条，翻到第 ${stopPage} 页`);
  }

  kill();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
