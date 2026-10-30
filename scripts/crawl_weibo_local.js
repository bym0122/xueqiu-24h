#!/usr/bin/env node
// 微博 24h 抓取 —— 本机版（chromium + CDP）
//
// 为什么需要本地版：
//   m.weibo.cn 对 curl / node fetch 一律返回 432（body 为空），
//   换美国代理也一样 —— 它拦的不是 IP，是 TLS 指纹（curl 的 ClientHello 是已知爬虫特征）。
//   本机真实 chromium 从页面上下文 fetch 同一个 API → 200。所以本地能抓，只是必须用浏览器。
//
// 用法:
//   node scripts/crawl_weibo_local.js                 # 默认两个账号
//   node scripts/crawl_weibo_local.js 4044309290      # 只抓一个
//   WEIBO_UIDS="3962719063 4044309290" node scripts/crawl_weibo_local.js
//
// 输出: data/weibo/<uid>/<YYYY-MM-DD>.json （与 GH Action 版格式完全一致，可互相同步）

const { spawn } = require("child_process");
const CRI = require(
  "/data/data/com.termux/files/usr/lib/node_modules/bwb-browser/node_modules/chrome-remote-interface"
);
const fs = require("fs");
const path = require("path");

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const WINDOW_MS = 24 * 3600 * 1000;
const PORT = 9337;
const PROFILE = path.join(process.env.PREFIX || "/tmp", "tmp/opencode/cr-weibo-local");

const DEFAULT_UIDS = ["3962719063", "4044309290"]; // 鹿鼎公 / 斯托伯的天空
const uids = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (!uids.length) {
  uids.push(
    ...(process.env.WEIBO_UIDS || "").split(/\s+/).filter((s) => /^\d+$/.test(s))
  );
}
if (!uids.length) uids.push(...DEFAULT_UIDS);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function beijingStamp(d) {
  return {
    date: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d),
    time: new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      dateStyle: "full",
      timeStyle: "medium",
    }).format(d),
  };
}

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
    .slice(0, 3000);
  const kind = m.retweeted_status ? "retweet" : m.isLongText ? "long" : "status";
  return {
    id: String(m.id),
    mid: m.mid ? String(m.mid) : String(m.id),
    created_at: Number.isNaN(createdMs)
      ? String(m.created_at || "")
      : new Date(createdMs).toISOString(),
    kind,
    url: `https://weibo.com/${uid}/${m.bid || m.id}`,
    text,
    source: (m.source || "").replace(/<[^>]+>/g, "").trim(),
    reposts: m.reposts_count ?? null,
    comments: m.comments_count ?? null,
    attitudes: m.attitudes_count ?? null,
    pics: (m.pics || []).map((p) => (p.large && p.large.url) || p.url).filter(Boolean),
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
  }, 300000);
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
    const r = await Runtime.evaluate({
      expression: expr,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval error");
    return r.result.value;
  };

  // 先拿 visitor cookie（_T_WM / SUBP / XSRF-TOKEN），否则 API 会 432
  await Page.navigate({ url: "https://m.weibo.cn/" });
  await Page.loadEventFired().catch(() => {});
  await sleep(4000);
  const ck = await ev("document.cookie");
  console.log(`[cookie] ${String(ck).slice(0, 90)}`);

  let anyFailed = false;

  for (const uid of uids) {
    try {
      const apiUrl =
        `https://m.weibo.cn/api/container/getIndex?type=uid&value=${uid}` +
        `&containerid=107603${uid}`;
      const res = await ev(
        `fetch(${JSON.stringify(apiUrl)},{headers:{'x-requested-with':'XMLHttpRequest'},credentials:'include'}).then(async r=>({s:r.status,t:await r.text()}))`,
        true
      );
      if (res.s !== 200) {
        console.error(`[${uid}] HTTP ${res.s} bodyHead=${String(res.t).slice(0, 80)}`);
        anyFailed = true;
        continue;
      }
      const j = JSON.parse(res.t);
      const batch = extractPosts(j, uid);
      const cutoff = Date.now() - WINDOW_MS;
      const posts = batch.filter(
        (p) => /^\d{4}-/.test(p.created_at) && new Date(p.created_at).getTime() >= cutoff
      );

      const dataDir = path.join(process.cwd(), "data", "weibo", uid);
      fs.mkdirSync(dataDir, { recursive: true });
      const existing = new Set();
      for (const f of fs.readdirSync(dataDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
          for (const p of d.posts || []) existing.add(String(p.id));
        } catch {}
      }
      const newPosts = posts.filter((p) => !existing.has(String(p.id)));

      const now = new Date();
      const stamp = beijingStamp(now);
      const outputFile = path.join(dataDir, `${stamp.date}.json`);
      const output = {
        user_id: uid,
        profile_url: `https://weibo.com/u/${uid}`,
        window: "last-24h",
        source: "local-chromium",
        crawled_at_beijing: stamp.time,
        crawled_date: stamp.date,
        post_count: newPosts.length,
        posts: newPosts,
      };
      let merged = output;
      if (fs.existsSync(outputFile)) {
        try {
          const prev = JSON.parse(fs.readFileSync(outputFile, "utf8"));
          const have = new Set((prev.posts || []).map((p) => String(p.id)));
          for (const p of newPosts) if (!have.has(String(p.id))) prev.posts.push(p);
          prev.post_count = (prev.posts || []).length;
          prev.crawled_at_beijing = stamp.time;
          prev.source = "local-chromium";
          merged = prev;
        } catch {}
      }
      fs.writeFileSync(outputFile, JSON.stringify(merged, null, 2), "utf8");
      console.log(
        `[${uid}] 24h 内 ${posts.length} 条 / 新增 ${newPosts.length} 条 / 文件共 ${merged.post_count} 条 → ${outputFile}`
      );
    } catch (e) {
      console.error(`[${uid}] 失败: ${e.message}`);
      anyFailed = true;
    }
  }

  await client.close();
  kill();
  process.exit(anyFailed ? 1 : 0);
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
