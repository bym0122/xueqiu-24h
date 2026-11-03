#!/usr/bin/env node
// 从已有归档里抽取「方法论高信号」帖子，供人工阅读建基线
// 用法: node scripts/extract_method.js <uid> [--author 名字] [--top 80] [--out 文件]
const fs = require("fs");
const path = require("path");

const uid = process.argv[2];
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const TOP = parseInt(arg("--top", "80"), 10);
const OUT = arg("--out", null);

const dirs = ["data/xueqiu", "data/weibo", "data/wechat"];
let posts = [];

function walk(d) {
  if (!fs.existsSync(d)) return;
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (f.endsWith(".json")) {
      try {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        if (uid && !String(p).includes("/" + uid + "/")) continue;
        for (const x of j.posts || []) posts.push({ ...x, _src: d.includes("weibo") ? "微博" : d.includes("wechat") ? "公众号" : "雪球" });
      } catch {}
    }
  }
}
for (const d of dirs) walk(d);

// 去重
const seen = new Set();
posts = posts.filter((p) => {
  const k = p.id || (p.created_at + (p.text || "").slice(0, 40));
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const isRetweet = (t) => /^\/\//.test((t || "").trim()) || /^转发微博/.test((t || "").trim());

// 打分：有具体数字+单位，有分析词，长度适中，非纯转发
const UNIT = /(亿|万|吨|桶|美元|元|%|倍|天|海里|个百分点|PE|PB|ROE|毛利|净利|营收|股息|产能|库存|开工|运价|TCE|VLCC|MR|OPEC|美元\/桶)/;
const THINK = /(因为|所以|逻辑|假设|估算|折算|相当于|意味着|如果|前提|验证|口径|对比|同比|环比|年化|折合|推演|其实就是|本质)/;
const score = (p) => {
  const t = p.text || "";
  if (!t || t.length < 60) return -1;
  if (isRetweet(t) && t.length < 160) return -1;
  let s = Math.min(t.length, 600) / 60;
  const nums = (t.match(/\d+(\.\d+)?/g) || []).length;
  s += Math.min(nums, 12) * 1.5;
  if (UNIT.test(t)) s += 4;
  if (THINK.test(t)) s += 3;
  if (t.length > 400) s += 3;
  if (p._src === "公众号") s += 10;
  if (p.kind === "retweet") s -= 2;
  return s;
};

const scored = posts.map((p) => ({ p, s: score(p) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
const picked = scored.slice(0, TOP);

const lines = [];
lines.push(`# 作者 ${uid || "全部"}｜候选 ${scored.length} 条，取前 ${picked.length} 条`);
lines.push(`# 生成时间 ${new Date().toISOString()}`);
for (const { p, s } of picked) {
  const d = (p.created_at || "").slice(0, 16).replace("T", " ");
  lines.push(`\n----- [${d}] ${p._src} 分=${s.toFixed(1)} 字=${(p.text || "").length} -----`);
  lines.push((p.text || "").replace(/\s+/g, " ").slice(0, 1600));
}
const text = lines.join("\n");
if (OUT) {
  fs.writeFileSync(OUT, text);
  console.log(`写出 ${OUT}，${text.length} 字符，${picked.length} 条`);
} else {
  console.log(text);
}
