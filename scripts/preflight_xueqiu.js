#!/usr/bin/env node
/**
 * preflight_xueqiu.js — 雪球抓取预检（约 10–20 秒）
 *
 * 为什么需要它：
 *   crawl_xueqiu_deep.js 跑完要 25 秒，而且「出口 IP 被雪球标记」时的表现
 *   是「最新页 0 条 → 新增 0 条」，很容易被误读成「今天没发帖」。
 *   本脚本只做一件事：判断当前出口 IP 能不能抓雪球。
 *
 * 三种结果（退出码）：
 *   0  OK       可以抓
 *   2  WAF      撞到滑块/验证页（重跑一次或换个网络）
 *   3  BLOCKED  出口 IP 被标记（API 返回 400 / 空 statuses）→ 关代理或换节点
 *   1  其他未知错误
 *
 * 用法:
 *   node scripts/preflight_xueqiu.js            # 默认查 1910783512
 *   node scripts/preflight_xueqiu.js 9493911686
 *   node scripts/preflight_xueqiu.js --quiet    # 只输出一行结论
 */
"use strict";
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");
const CRI = require("/data/data/com.termux/files/usr/lib/node_modules/bwb-browser/node_modules/chrome-remote-interface");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const argv = process.argv.slice(2);
const QUIET = argv.includes("--quiet");
const UID = argv.find((a) => /^\d+$/.test(a)) || "1910783512";
const PROFILE = path.join(os.tmpdir(), "xq-preflight");
const PORT = 9700 + (process.pid % 80);

/** 给任意 promise 加超时，超时返回 {timedOut:true} 而不是永远挂着 */
function withTimeout(p, ms, tag) {
  return Promise.race([
    Promise.resolve(p).then((v) => ({ ok: true, value: v })),
    sleep(ms).then(() => ({ ok: false, timedOut: true, tag })),
  ]);
}

function say(...a) {
  if (!QUIET) console.log(...a);
}

function finish(code, verdict, detail) {
  // 结论永远打到 stdout（--quiet 也要有）
  console.log(`${verdict}${detail ? " | " + detail : ""}`);
  process.exit(code);
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
      "--window-size=1440,1000",
      "--user-data-dir=" + PROFILE,
      "--remote-debugging-port=" + PORT,
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  proc.unref();
  const kill = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
  };
  const guard = setTimeout(() => {
    kill();
    finish(1, "TIMEOUT", "整体 45 秒超时（chromium 起不来或网络卡死）");
  }, 45000);
  guard.unref();

  let client = null;
  for (let i = 0; i < 40; i++) {
    try {
      client = await CRI({ port: PORT });
      break;
    } catch {
      await sleep(400);
    }
  }
  if (!client) {
    kill();
    finish(1, "ERROR", "连不上 Chromium 调试端口");
  }

  const { Page, Runtime } = client;
  await Page.enable();
  await Runtime.enable();

  const ev = async (expr, awaitPromise = false, timeoutMs = 20000) => {
    const r = await withTimeout(
      Runtime.evaluate({ expression: expr, awaitPromise, returnByValue: true }),
      timeoutMs,
      "evaluate",
    );
    if (!r.ok) return { timedOut: true };
    const v = r.value;
    if (v.exceptionDetails) return { error: v.exceptionDetails.text || "eval error" };
    return { value: v.result.value };
  };

  // ① 打开用户页，让 WAF 走完（这里最容易卡，所以 15 秒封顶）
  const nav = await withTimeout(
    Page.navigate({ url: `https://xueqiu.com/u/${UID}` }),
    15000,
    "navigate",
  );
  if (!nav.ok) {
    kill();
    finish(1, "TIMEOUT", "打开雪球用户页超时（15s）");
  }
  if (nav.value && nav.value.errorText && nav.value.errorText !== "net::ERR_ABORTED") {
    kill();
    finish(1, "ERROR", "导航失败: " + nav.value.errorText);
  }
  await sleep(5000);

  // ② 标题判定：撞到验证页就直接返回
  const title = await ev("document.title", false, 5000);
  const titleStr = String(title.value || "");
  say(`[1/3] 页面标题: ${titleStr.slice(0, 60) || "(空)"}`);
  if (/Verification|验证|访问提示/i.test(titleStr)) {
    kill();
    finish(2, "WAF", "撞到验证页/滑块，重跑一次通常就好");
  }

  // ③ API 判定：这是唯一能区分「IP 被标记」和「今天没发帖」的信号
  const api = await ev(
    `(async () => {
       try {
         const r = await fetch('/v4/statuses/user_timeline.json?user_id=${UID}&page=1&count=5',
           { credentials: 'include', headers: { 'Accept': 'application/json' } });
         const t = await r.text();
         let n = -1;
         try { const j = JSON.parse(t); n = (j.statuses || j.list || []).length; } catch {}
         return JSON.stringify({ status: r.status, statuses: n, bodyHead: t.slice(0, 160) });
       } catch (e) { return JSON.stringify({ status: 0, statuses: -1, err: e.message }); }
     })()`,
    true,
    20000,
  );
  if (api.timedOut) {
    kill();
    finish(1, "TIMEOUT", "API 请求超时（20s）");
  }
  let info = {};
  try {
    info = JSON.parse(api.value || "{}");
  } catch {}
  say(`[2/3] API: status=${info.status} statuses=${info.statuses}`);

  kill();

  const body = String(info.bodyHead || info.err || "");

  if (info.status === 200 && info.statuses > 0) {
    finish(0, "OK", `可以抓，最新页 ${info.statuses} 条`);
  }
  // 明确的风控信号：400/567，或返回体里出现「请登录」
  if (info.status === 400 || info.status === 567 || /请登录|登录雪球/.test(body)) {
    finish(3, "BLOCKED", `出口 IP 被雪球标记（status=${info.status}）→ 关代理或换节点`);
  }
  // 200 但 0 条：可能 uid 写错，也可能是软限，必须换 uid 复测才能定
  if (info.status === 200 && info.statuses === 0) {
    finish(3, "EMPTY", "返回 200 但 0 条：uid 可能写错，或出口被软限 → 换 1910783512 复测");
  }
  finish(1, "UNKNOWN", `status=${info.status} body=${body.slice(0, 80)}`);
})();
