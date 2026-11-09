#!/usr/bin/env node
/**
 * backfill_xueqiu.js — 按「帖子自己的北京日期」归档补抓
 *
 * 为什么需要它：
 *   xq24 / crawl_xueqiu_deep.js 都只收「最近 24h」的帖子，并且全部写进
 *   「今天」那个文件。只要某天没跑成功（WAF、任务没触发、手机没网），
 *   那天的帖子就永远补不回来了 —— 24h 窗口一过，再也进不了任何文件。
 *   鹿鼎公 11-01 / 11-03 / 11-06 的帖子就是这么丢的。
 *
 * 本脚本不设时间窗：把能翻到的帖子按 created_at 落到对应的
 *   data/xueqiu/<uid>/YYYY-MM-DD.json
 * 按 id 去重合并，不动历史。
 *
 * 用法:
 *   node scripts/backfill_xueqiu.js 8790885129              # 默认翻 2 页时间线 + 5 页原创
 *   node scripts/backfill_xueqiu.js 8790885129 --pages 3
 *   node scripts/backfill_xueqiu.js --dry                    # 只看能补到什么，不写文件
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
const PROFILE = path.join(os.tmpdir(), "xq-profile-" + process.pid);
const PORT = 9600 + (process.pid % 300);

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const pagesIdx = argv.indexOf("--pages");
const PAGES = pagesIdx >= 0 ? Math.max(1, parseInt(argv[pagesIdx + 1], 10) || 2) : 2;
const ORIG_PAGES = 5;
// 只补最近 N 天，避免把作者好几年前的旧帖也倒成新文件（会把仓库塞爆）。
const sinceIdx = argv.indexOf("--since");
const SINCE_DAYS = sinceIdx >= 0 ? Math.max(1, parseInt(argv[sinceIdx + 1], 10) || 30) : 30;
const SINCE = new Date(Date.now() - SINCE_DAYS * 24 * 3600 * 1000);
const UIDS = argv.filter((a, i) => /^\d{6,}$/.test(a));
const REPO = path.resolve(__dirname, "..");

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

function bjDate(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function normalize(it, uid) {
  const desc = strip(it.description || it.text || "");
  return {
    id: String(it.id),
    created_at: new Date(Number(it.created_at)).toISOString(),
    kind: it.retweeted_status || it.retweet_status_id ? "retweet" : /^回复/.test(desc) ? "reply" : "status",
    url: `https://xueqiu.com/${uid}/${it.id}`,
    text: desc.slice(0, 2000),
  };
}

(async () => {
  if (!UIDS.length) {
    console.error("用法: node scripts/backfill_xueqiu.js <uid> [uid…] [--pages N] [--dry]");
    process.exit(1);
  }
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
  const killAll = () => {
    try { process.kill(-proc.pid, "SIGKILL"); } catch {}
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  };
  const guard = setTimeout(() => { killAll(); process.exit(1); }, 300000);
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
    return { status: v.s, json: j, raw: v.t };
  };
  const fetchPage = async (uid, p, kind) => {
    const url = kind === "orig"
      ? `/statuses/original/timeline.json?user_id=${uid}&page=${p}&count=20`
      : `/v4/statuses/user_timeline.json?user_id=${uid}&page=${p}&count=20`;
    let r = await api(url);
    for (let attempt = 1; attempt <= 3 && (r.status !== 200 || !r.json); attempt++) {
      console.error(`[${uid}] ${kind} p${p} 非 JSON(${attempt}/3),重进作者页…`);
      await Page.navigate({ url: `https://xueqiu.com/u/${uid}` });
      await Page.loadEventFired().catch(() => {});
      await sleep(3000 + attempt * 2000);
      r = await api(url);
    }
    return r;
  };

  await Page.navigate({ url: `https://xueqiu.com/u/${UIDS[0]}` });
  await Page.loadEventFired().catch(() => {});
  await sleep(6000);
  const title = await ev("document.title");
  if (/Verification|验证/i.test(title || "")) {
    console.error("被 WAF 拦了(验证页),重跑一次通常就好");
    await client.close(); killAll(); process.exit(2);
  }

  let totalWritten = 0;
  for (const uid of UIDS) {
    const byDate = new Map(); // date -> Map(id -> post)
    let ok = 0, bad = 0;

    for (let p = 1; p <= PAGES; p++) {
      const r = await fetchPage(uid, p, "timeline");
      if (r.status !== 200 || !r.json) {
        if (p === 1) bad++;
        break;
      }
      const list = r.json.statuses || r.json.list || [];
      if (!list.length) break;
      ok++;
      for (const it of list) {
        if (!it || !it.id || typeof it.created_at !== "number") continue;
        if (Number(it.created_at) < SINCE.getTime()) continue;
        const n = normalize(it, uid);
        const d = bjDate(n.created_at);
        if (!byDate.has(d)) byDate.set(d, new Map());
        byDate.get(d).set(n.id, n);
      }
      await sleep(700);
    }

    for (let p = 1; p <= ORIG_PAGES; p++) {
      const r = await fetchPage(uid, p, "orig");
      if (r.status !== 200 || !r.json) break;
      const list = r.json.statuses || r.json.list || [];
      if (!list.length) break;
      ok++;
      for (const it of list) {
        if (!it || !it.id || typeof it.created_at !== "number") continue;
        if (Number(it.created_at) < SINCE.getTime()) continue;
        const n = normalize(it, uid);
        const d = bjDate(n.created_at);
        if (!byDate.has(d)) byDate.set(d, new Map());
        byDate.get(d).set(n.id, n);
      }
      await sleep(700);
    }

    const dates = [...byDate.keys()].sort();
    console.log(`[${uid}] 翻到 ${ok} 页 / 失败 ${bad} 页,涉及 ${dates.length} 天: ${dates.join(", ")}`);

    if (dry) {
      for (const d of dates) console.log(`  ${d}: ${byDate.get(d).size} 条（未写入）`);
      continue;
    }

    for (const d of dates) {
      const dir = path.join(REPO, "data", "xueqiu", uid);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${d}.json`);
      let prev = null;
      if (fs.existsSync(file)) {
        try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      }
      if (Array.isArray(prev)) prev = { posts: prev };
      const posts = (prev && prev.posts) || [];
      const have = new Set(posts.map((p) => String(p.id)));
      let added = 0;
      for (const [id, n] of byDate.get(d)) {
        if (have.has(id)) continue;
        posts.push(n);
        have.add(id);
        added++;
      }
      posts.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const out = {
        ...(prev || {}),
        user_id: uid,
        profile_url: `https://xueqiu.com/u/${uid}`,
        window: (prev && prev.window) || "backfill",
        source: "termux+backfill",
        crawled_at_beijing: new Intl.DateTimeFormat("zh-CN", {
          timeZone: "Asia/Shanghai", dateStyle: "full", timeStyle: "medium",
        }).format(new Date()),
        crawled_date: d,
        post_count: posts.length,
        posts,
      };
      fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
      if (added) {
        totalWritten += added;
        console.log(`  ${d}: +${added} 条 → 共 ${posts.length} 条`);
      }
    }
  }

  console.log(`合计写入 ${totalWritten} 条`);
  await client.close();
  killAll();
  process.exit(0);
})().catch((e) => {
  console.error("补抓失败:", e.message);
  process.exit(1);
});
