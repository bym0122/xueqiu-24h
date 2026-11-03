#!/usr/bin/env node
// 探测微博翻页接口：哪种能真正翻到第 2 页以后
const { spawn } = require("child_process");
const CRI = require("/data/data/com.termux/files/usr/lib/node_modules/bwb-browser/node_modules/chrome-remote-interface");
const path = require("path");
const fs = require("fs");
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const PORT = 9341;
const PROFILE = path.join(process.env.PREFIX || "/tmp", "tmp/opencode/cr-probe-weibo");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = process.argv[2] || "3962719063";

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  const proc = spawn("chromium-browser", ["--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--disable-blink-features=AutomationControlled","--user-agent="+UA,"--lang=zh-CN","--user-data-dir="+PROFILE,"--remote-debugging-port="+PORT,"about:blank"], { stdio: "ignore", detached: true });
  proc.unref();
  const kill = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch {} };
  setTimeout(() => { kill(); process.exit(1); }, 180000).unref();

  let client = null;
  for (let i = 0; i < 60; i++) { try { client = await CRI({ port: PORT }); break; } catch { await sleep(500); } }
  const { Page, Runtime } = client;
  await Page.enable(); await Runtime.enable();
  const ev = async (e, ap=false) => { const r = await Runtime.evaluate({ expression: e, awaitPromise: ap, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };

  await Page.navigate({ url: "https://m.weibo.cn/" });
  await Page.loadEventFired().catch(()=>{});
  await sleep(4000);

  async function probe(label, url, pick) {
    try {
      const r = await ev(`fetch(${JSON.stringify(url)},{headers:{'x-requested-with':'XMLHttpRequest'},credentials:'include'}).then(async r=>({s:r.status,t:(await r.text()).slice(0,200000)}))`, true);
      if (r.s !== 200) { console.log(`${label}: HTTP ${r.s} ${String(r.t).slice(0,80)}`); return null; }
      let j; try { j = JSON.parse(r.t); } catch { console.log(`${label}: 非 JSON`); return null; }
      const arr = pick(j);
      console.log(`${label}: ok=${j.ok} 条数=${arr.length} 首条=${arr[0] ? (arr[0].mblog||arr[0]).created_at : "-"}`);
      return arr;
    } catch (e) { console.log(`${label}: 异常 ${e.message}`); return null; }
  }

  const pickM = (j) => { const o=[]; for (const c of (j.data&&j.data.cards)||[]) for (const it of (c.card_group||[c])) if ((it.mblog||it).id) o.push(it); for (const s of (j.data&&j.data.statuses)||[]) o.push(s); return o; };

  const base = `https://m.weibo.cn/api/container/getIndex?type=uid&value=${uid}&containerid=107603${uid}`;
  const p1 = await probe("container page=1", base + "&page=1", pickM);
  const lastId = p1 && p1.length ? String((p1[p1.length-1].mblog||p1[p1.length-1]).id) : "";
  await probe("container page=2", base + "&page=2", pickM);
  await probe("container since_id", base + "&since_id=" + lastId, pickM);
  await probe("container max_id", base + "&max_id=" + lastId, pickM);

  // 桌面接口
  const dj = await probe("weibo ajax mymblog p2", `https://weibo.com/ajax/statuses/mymblog?uid=${uid}&page=2&feature=0`, (j)=> (j.data&&j.data.list)||[]);
  if (!dj) {
    await probe("m.weibo.cn ajax mymblog p2", `https://m.weibo.cn/api/statuses/mymblog?uid=${uid}&page=2&feature=0`, (j)=> (j.data&&j.data.list)||[]);
  }
  kill(); process.exit(0);
})();
