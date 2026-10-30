#!/usr/bin/env node
// 微信公众号单篇文章抓取器
//
// 用法:
//   node scripts/crawl_wechat.js <url> [url2 ...]
//   WECHAT_URLS="url1,url2" node scripts/crawl_wechat.js
//   node scripts/crawl_wechat.js --json <url>     # 只打印，不落盘
//
// 输出: data/wechat/<公众号名>/<YYYY-MM-DD>.json
//
// 为什么不做定时：公众号没有可枚举的公开时间线接口，
// 只能靠"拿到链接 -> 解析"。链接由用户提供，或从别处转发里提取。

const fs = require("fs");
const path = require("path");

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const args = process.argv.slice(2);
const jsonOnly = args.includes("--json");
const urls = args
  .filter((a) => !a.startsWith("--"))
  .concat(
    (process.env.WECHAT_URLS || "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  )
  .filter((u) => /^https?:\/\/mp\.weixin\.qq\.com\//.test(u));

if (!urls.length) {
  console.error(
    "用法: node scripts/crawl_wechat.js <mp.weixin.qq.com 链接> [更多链接]\n" +
      "      node scripts/crawl_wechat.js --json <链接>   # 只打印不落盘"
  );
  process.exit(2);
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function pick(html, re) {
  const m = html.match(re);
  return m ? decodeEntities(m[1]).trim() : "";
}

function stripTags(s) {
  return decodeEntities(
    String(s || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// 文章 id：优先 sn（微信的稳定短 id），退回 mid+idx
function articleId(u) {
  try {
    const parsed = new URL(u);
    const p = parsed.searchParams;
    const sn = p.get("sn");
    if (sn) return sn;
    const mid = p.get("mid") || p.get("appmsgid");
    const idx = p.get("idx") || p.get("itemidx");
    if (mid) return `${mid}_${idx || "1"}`;
    // /s/<shortid> 形式
    const m = parsed.pathname.match(/^\/s\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
  } catch (_) {}
  return null;
}

function beijingDate(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function beijingStamp(d) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "full",
    timeStyle: "medium",
  }).format(d);
}

function safeDirName(name) {
  return String(name || "unknown").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
}

function parseArticle(html, url) {
  // 标题
  let title = pick(
    html,
    /<h1[^>]*class="[^"]*rich_media_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i
  );
  title = stripTags(title);
  if (!title) title = pick(html, /<meta property="og:title" content="([^"]*)"/i);
  if (!title) title = pick(html, /var msg_title = '([^']*)'/i);

  // 公众号名：js_name 的 <a> 里通常先有一个 span，取纯文本再清洗
  let account = pick(html, /id="js_name"[^>]*>([\s\S]*?)<\/a>/i);
  account = stripTags(account).split("\n")[0].trim();
  if (!account) account = pick(html, /var nickname = "([^"]*)"/i);
  if (!account)
    account = pick(html, /<meta property="og:article:author" content="([^"]*)"/i);

  // 作者（署名，可能为空）：优先隐藏的纯文本节点
  let author = pick(
    html,
    /id="js_author_name_text"[^>]*>([\s\S]*?)<\/span>/i
  );
  author = stripTags(author).split("\n")[0].trim();
  if (!author) {
    author = pick(html, /<meta name="author" content="([^"]*)"/i);
  }

  // 发布时间
  let publish = pick(html, /id="publish_time"[^>]*>([\s\S]*?)<\/em>/i);
  if (!publish) publish = pick(html, /var ct = "(\d+)"/i);
  if (/^\d{9,}$/.test(publish)) {
    publish = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      dateStyle: "long",
      timeStyle: "short",
    }).format(new Date(+publish * 1000));
  }

  // 正文
  const bodyMatch = html.match(
    /<div[^>]*class="[^"]*rich_media_content[^"]*"[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>\s*<script/i
  ) || html.match(
    /<div[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>\s*<script/i
  );
  const rawBody = bodyMatch ? bodyMatch[1] : "";
  const text = stripTags(rawBody).slice(0, 40000);

  // 原文声明 / 转载声明
  const disclaimer = pick(
    html,
    /<div[^>]*class="[^"]*rich_media_tool[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );

  const imgCount = (rawBody.match(/<img\b/gi) || []).length;

  return {
    id: articleId(url),
    url,
    title: title || "(无标题)",
    account: account || "未知公众号",
    author: author || "",
    publish_time: publish || "",
    text,
    char_count: text.length,
    image_count: imgCount,
    disclaimer: stripTags(disclaimer).slice(0, 300),
  };
}

(async () => {
  let totalNew = 0;
  const results = [];

  for (const url of urls) {
    console.log(`\n[fetch] ${url}`);
    let html;
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Accept-Language": "zh-CN,zh;q=0.9",
          Referer: "https://mp.weixin.qq.com/",
        },
        redirect: "follow",
      });
      if (!resp.ok) {
        console.error(`  HTTP ${resp.status}`);
        continue;
      }
      html = await resp.text();
    } catch (e) {
      console.error(`  fetch error: ${e.message}`);
      continue;
    }

    const art = parseArticle(html, url);
    console.log(`  公众号: ${art.account}`);
    console.log(`  标题: ${art.title}`);
    console.log(`  发布: ${art.publish_time || "(未取到)"}`);
    console.log(`  正文: ${art.char_count} 字 / ${art.image_count} 图`);

    if (art.char_count < 50) {
      console.warn("  WARNING: 正文过短，可能被风控或需要验证，已跳过落盘");
      results.push({ ...art, saved: false });
      continue;
    }

    results.push({ ...art, saved: !jsonOnly });
    if (jsonOnly) continue;

    const now = new Date();
    const dir = path.join(
      process.cwd(),
      "data",
      "wechat",
      safeDirName(art.account)
    );
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${beijingDate(now)}.json`);

    let store = {
      account: art.account,
      account_dir: safeDirName(art.account),
      crawled_at_beijing: beijingStamp(now),
      article_count: 0,
      articles: [],
    };
    if (fs.existsSync(file)) {
      try {
        store = JSON.parse(fs.readFileSync(file, "utf8"));
        store.articles = store.articles || [];
      } catch (_) {}
    }
    const have = new Set(store.articles.map((a) => a.id || a.url));
    const key = art.id || art.url;
    if (!have.has(key)) {
      store.articles.push(art);
      totalNew++;
      console.log("  → 新增入库");
    } else {
      console.log("  → 已存在，跳过");
    }
    store.article_count = store.articles.length;
    store.crawled_at_beijing = beijingStamp(now);
    fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
    console.log(`  saved: ${file}`);
  }

  if (jsonOnly) {
    console.log("\n" + JSON.stringify(results, null, 2));
  } else {
    console.log(`\n完成：新增 ${totalNew} 篇。`);
  }
})();
