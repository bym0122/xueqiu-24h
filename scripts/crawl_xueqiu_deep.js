#!/usr/bin/env node
/**
 * crawl_xueqiu_deep.js — 雪球「翻页补齐」抓取
 *
 * 为什么需要它：
 *   /v4/statuses/user_timeline.json 匿名只能拿第 1 页（约 20 条），第 2 页返回
 *   「请登录雪球查看更多内容」。所以 xq24 靠「多次轮询 + 按 id 合并」来累积。
 *   但如果两次轮询之间作者发了 >20 条，中间那段就永远拿不到了。
 *
 * 本脚本补两条路：
 *   1) /statuses/original/timeline.json  匿名可翻到第 5 页（约 100 条原创/长文）
 *   2) /v4/statuses/user_timeline.json   每次拉第 1 页最新 20 条
 *
 * 用法:
 *   node crawl_xueqiu_deep.js [--repo <path>] [uid...]
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const CRI = require("/data/data/com.termux/files/usr/lib/node_modules/bwb-browser/node_modules/chrome-remote-interface");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PROFILE = path.join(os.tmpdir(), "xq-profile");
const PORT = 9600 + (process.pid % 300);

const argv = process.argv.slice(2);
const repoIdx = argv.indexOf("--repo");
const REPO = repoIdx >= 0 ? path.resolve(argv[repoIdx + 1]) : path.resolve(__dirname, "..");
const DEFAULT_UIDS = ["9493911686", "1910783512"];
const UIDS = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--repo");
const targets = UIDS.length ? UIDS : DEFAULT_UIDS;

const WINDOW_MS = 24 * 3600 * 1000;

const ent = (s) =>
  String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—");
const strip = (s) => ent(String(s || "").replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").trim();

function bjDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function normalize(it, uid) {
  return {
    id: String(it.id),
    created_at: new Date(Number(it.created_at)).toISOString(),
    kind: it.retweeted_status ? "retweet" : "status",
    url: `https://xueqiu.com/${uid}/${it.id}`,
    text: strip(it.text),
  };
}

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { fs.unlinkSync(path.join(PROFILE, f)); } catch {}
  }

  const proc = spawn(
    "chromium-browser",
    [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--user-agent=" + UA, "--lang=zh-CN", "--window-size=1440,1000",
      "--user-data-dir=" + PROFILE, "--remote-debugging-port=" + PORT, "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  proc.unref();
  const killAll = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch {} };
  const guard = setTimeout(() => { killAll(); process.exit(1); }, 240000);
  guard.unref();

  let client = null;
  for (let i = 0; i < 60; i++) {
    try { client = await CRI({ port: PORT }); break; } catch { await sleep(500); }
  }
  if (!client) { console.error("连不上 Chromium 调试端口"); killAll(); process.exit(1); }
  const { Page, Runtime } = client;
  await Page.enable();
  await Runtime.enable();

  const ev = async (e, ap = false) => {
    const r = await Runtime.evaluate({ expression: e, awaitPromise: ap, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval error");
    return r.result.value;
  };
  const api = async (p) => {
    const v = await ev(
      `fetch(${JSON.stringify(p)},{headers:{'x-requested-with':'XMLHttpRequest'},credentials:'include'}).then(async r=>({s:r.status,t:await r.text()}))`,
      true,
    );
    let j = null;
    try { j = JSON.parse(v.t); } catch {}
    return { status: v.s, json: j };
  };

  // 过一次 WAF
  await Page.navigate({ url: `https://xueqiu.com/u/${targets[0]}` });
  await Page.loadEventFired().catch(() => {});
  await sleep(6000);
  const title = await ev("document.title");
  if (/Verification|验证/i.test(title || "")) {
    console.error("被 WAF 拦了，重跑一次通常就好");
    await client.close(); killAll(); process.exit(1);
  }

  const cutoff = Date.now() - WINDOW_MS;
  const today = bjDate();
  let totalAdded = 0;

  for (const uid of targets) {
    const file = path.join(REPO, "data/xueqiu", uid, `${today}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let doc;
    if (fs.existsSync(file)) {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(doc)) doc = { posts: doc };
    } else {
      doc = { user_id: uid, profile_url: `https://xueqiu.com/u/${uid}`, window: "last-24h", posts: [] };
    }
    if (!Array.isArray(doc.posts)) doc.posts = [];
    const before = new Set(doc.posts.map((p) => String(p.id)));

    const collected = [];
    // 1) 最新 20 条
    const latest = await api(`/v4/statuses/user_timeline.json?user_id=${uid}&page=1&count=20`);
    const l1 = (latest.json && (latest.json.statuses || latest.json.list)) || [];
    collected.push(...l1);
    await sleep(900);

    // 2) 原创/长文翻页（匿名最多 5 页）
    let origPages = 0;
    for (let p = 1; p <= 5; p++) {
      const r = await api(`/statuses/original/timeline.json?user_id=${uid}&page=${p}&count=20`);
      const st = (r.json && (r.json.statuses || r.json.list)) || [];
      if (!st.length) break;
      collected.push(...st);
      origPages = p;
      const oldest = Math.min(...st.map((x) => Number(x.created_at)));
      if (oldest < cutoff) break;
      await sleep(900);
    }

    const added = [];
    for (const it of collected) {
      if (!it || !it.id || !it.created_at) continue;
      if (Number(it.created_at) < cutoff) continue;
      const n = normalize(it, uid);
      if (before.has(n.id)) continue;
      before.add(n.id);
      doc.posts.push(n);
      added.push(n);
    }

    doc.posts.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    doc.crawled_at_beijing = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", dateStyle: "full", timeStyle: "medium",
    }).format(new Date());
    doc.crawled_date = today;
    doc.deep = { original_pages: origPages, latest_page: l1.length, added: added.length };
    doc.post_count = doc.posts.length;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");

    totalAdded += added.length;
    console.log(
      `[${uid}] 最新页 ${l1.length} 条 / 原创翻 ${origPages} 页 → 新增 ${added.length} 条，文件共 ${doc.posts.length} 条`,
    );
    for (const a of added) {
      console.log(`   + ${a.created_at} ${a.kind} ${a.id} ${a.text.slice(0, 50).replace(/\n/g, " ")}`);
    }
  }

  await client.close();
  killAll();
  process.exit(totalAdded >= 0 ? 0 : 1);
})().catch((e) => {
  console.error("抓取失败:", e.message);
  process.exit(1);
});
