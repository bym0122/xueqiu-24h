#!/usr/bin/env node
/**
 * 抓上海航运交易所「中国进口原油运价指数」(CTFI)。
 *
 * 数据源: https://www.sse.net.cn/index/singleIndex?indexType=ctfi
 *   - 官方、免费、不用登录、每天更新(T+1 发布)
 *   - CT1 中东湾→宁波 (VLCC 27万吨)  ≈ 波罗的海 TD3C
 *   - CT2 西非→宁波   (VLCC 26万吨)   ≠ TD15(船型/目的地不同,只作区域参考)
 *   - CT4 美湾STS→宁波(VLCC 27万吨)  ≈ TD22
 *
 * 用法:
 *   node crawl_ctfi.js                 # 抓取并写入 ./data/shipping/ctfi/
 *   node crawl_ctfi.js --repo <path>   # 指定仓库根目录
 *   node crawl_ctfi.js --push          # 抓完 commit + push
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const URL_CTFI = "https://www.sse.net.cn/index/singleIndex?indexType=ctfi";
const REPO_DEFAULT = path.resolve(__dirname, "..");
const OPENCODE_CFG = path.join(
  process.env.HOME || ".",
  ".config/opencode/opencode.json",
);

const argv = process.argv.slice(2);
const push = argv.includes("--push");
const repoIdx = argv.indexOf("--repo");
const repo = repoIdx >= 0 ? path.resolve(argv[repoIdx + 1]) : REPO_DEFAULT;
const outDir = path.join(repo, "data/shipping/ctfi");

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

function num(s) {
  return s === undefined || s === null ? null : Number(s);
}

function parseSegment(seg) {
  const out = {};
  // CT1/CT2 单位是「点」,CT4 是「万美元」,两种都要认
  const idx = seg.match(/(?:点|万美元)\s+\d+%\s+([\d.]+)\s+(-?[\d.]+)/);
  if (idx) {
    out.index = num(idx[1]);
    out.index_chg = num(idx[2]);
  }
  const ws = seg.match(/WS\s+([\d.]+)\s+(-?[\d.]+)/);
  if (ws) {
    out.ws = num(ws[1]);
    out.ws_chg = num(ws[2]);
  }
  const usd = seg.match(/美元\/吨\s+([\d.]+)\s+(-?[\d.]+)/);
  if (usd) {
    out.usd_per_ton = num(usd[1]);
    out.usd_per_ton_chg = num(usd[2]);
  }
  const tce = seg.match(
    /美元\/天\(标准航速\)\s+(\d+)\s+(-?\d+)\s+美元\/天\(经济航速\)\s+(\d+)\s+(-?\d+)/,
  );
  if (tce) {
    out.tce = num(tce[1]);
    out.tce_chg = num(tce[2]);
    out.tce_eco = num(tce[3]);
    out.tce_eco_chg = num(tce[4]);
  }
  return out;
}

function parse(html) {
  const t = htmlToText(html);

  const dm = t.match(/CRUDE OIL TANKER FREIGHT INDEX\s+(\d{4}-\d{2}-\d{2})/);
  if (!dm) throw new Error("PARSE_FAIL: 找不到指数日期(页面结构可能变了)");
  const date = dm[1];

  const cm = t.match(/综合指数\s+点\s+100%\s+([\d.]+)\s+(-?[\d.]+)/);
  if (!cm) throw new Error("PARSE_FAIL: 找不到综合指数");

  const routes = {};
  const markers = [
    ["CT1", "(CT1)"],
    ["CT2", "(CT2)"],
    ["CT4", "(CT4)"],
  ];
  const positions = [];
  for (const [key, mk] of markers) {
    const i = t.indexOf(mk);
    if (i >= 0) positions.push({ key, i });
  }
  positions.sort((a, b) => a.i - b.i);
  if (positions.length === 0) throw new Error("PARSE_FAIL: 找不到任何航线");

  for (let k = 0; k < positions.length; k++) {
    const start = positions[k].i;
    const end = k + 1 < positions.length ? positions[k + 1].i : t.length;
    routes[positions[k].key] = parseSegment(t.slice(start, end));
  }

  if (!routes.CT1 || !routes.CT1.tce) {
    throw new Error("PARSE_FAIL: CT1 的 TCE 为空(行情可能未更新或页面改版)");
  }

  return {
    date,
    comprehensive_index: num(cm[1]),
    comprehensive_index_chg: num(cm[2]),
    routes,
  };
}

async function fetchHtml() {
  const res = await fetch(URL_CTFI, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${URL_CTFI}`);
  return res.text();
}

function loadSeries(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function main(data) {
  fs.mkdirSync(outDir, { recursive: true });
  const dayFile = path.join(outDir, `${data.date}.json`);
  const seriesFile = path.join(outDir, "series.json");

  const record = {
    date: data.date,
    crawled_at: new Date().toISOString(),
    source: "上海航运交易所 CTFI",
    comprehensive_index: data.comprehensive_index,
    comprehensive_index_chg: data.comprehensive_index_chg,
    routes: data.routes,
  };
  fs.writeFileSync(dayFile, JSON.stringify(record, null, 2) + "\n");

  const series = loadSeries(seriesFile).filter((x) => x.date !== record.date);
  series.push(record);
  series.sort((a, b) => (a.date < b.date ? -1 : 1));
  fs.writeFileSync(seriesFile, JSON.stringify(series, null, 2) + "\n");

  const w = (v) => String(v).padStart(10);
  const pct = (v, base) =>
    base && v ? `${(((v - base) / base) * 100).toFixed(1)}%` : "-";

  console.log(`CTFI ${data.date}  综合 ${data.comprehensive_index} (${data.comprehensive_index_chg})`);
  console.log("航线      指数        TCE(美元/天)   日环比");
  for (const key of ["CT1", "CT2", "CT4"]) {
    const r = data.routes[key];
    if (!r || !r.tce) continue;
    console.log(
      `${key}  ${w(r.index)}  ${w(r.tce)}   ${pct(r.tce, r.tce - r.tce_chg)}`,
    );
  }

  // 历史对比(需要至少 5/10/20 个交易日)
  const past = series.filter((x) => x.date !== data.date);
  const nth = (n) => (past.length >= n ? past[past.length - n] : null);
  const line = (n) => {
    const p = nth(n);
    if (!p || !p.routes?.CT1?.tce) return null;
    const now = data.routes.CT1.tce;
    const old = p.routes.CT1.tce;
    return `${n}个交易日前(${p.date}) ${old} → ${now}  ${(((now - old) / old) * 100).toFixed(1)}%`;
  };
  const lines = [line(5), line(10), line(20)].filter(Boolean);
  if (lines.length) {
    console.log("\nCT1 历史对比:");
    lines.forEach((l) => console.log("  " + l));
  } else {
    console.log("\n(历史不足,先在攒数据;至少 5 个交易日后可看周环比)");
  }

  console.log(`\n已写入 ${path.relative(repo, dayFile)}`);
  return record;
}

function gitPush(branch = "main") {
  const cfg = JSON.parse(fs.readFileSync(OPENCODE_CFG, "utf8"));
  const token =
    cfg?.mcp?.servers?.github?.headers?.Authorization?.replace(/^Bearer /, "") ||
    process.env.GITHUB_TOKEN;
  if (!token) throw new Error("找不到 GitHub token");
  const g = (cmd) => execSync(cmd, { cwd: repo, stdio: "pipe" });

  g("git add data/shipping/ctfi/");
  let dirty = true;
  try {
    g("git diff --cached --quiet");
    dirty = false;
  } catch {
    dirty = true;
  }
  if (!dirty) {
    console.log("没有新数据,不提交。");
    return;
  }
  const d = new Date().toISOString().slice(0, 10);
  g(
    `git -c user.name="termux-bot" -c user.email="termux@local" commit -m "chore: ctfi fetch (termux ${d})"`,
  );
  execSync(
    `git push https://x-access-token:${token}@github.com/bym0122/xueqiu-24h.git HEAD:${branch}`,
    { cwd: repo, stdio: "pipe" },
  );
  console.log("已推送。");
}

(async () => {
  try {
    const html = await fetchHtml();
    const data = parse(html);
    main(data);
    if (push) gitPush();
  } catch (e) {
    console.error(`抓取失败: ${e.message}`);
    process.exit(1);
  }
})();
