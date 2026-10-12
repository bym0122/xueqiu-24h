const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const POST_URL = (process.env.XUEQIU_POST_URL || "").trim();
const COUNT = 20;
const MAX_COMMENT_PAGES = Number(process.env.MAX_COMMENT_PAGES || 100);
const MAX_REPLY_PAGES = Number(process.env.MAX_REPLY_PAGES || 50);
const SCROLL_ROUNDS = Number(process.env.SCROLL_ROUNDS || 12);
const DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 350);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const uniqueById = items => {
  const map = new Map();
  for (const item of items || []) {
    if (item && item.id != null) map.set(String(item.id), item);
  }
  return [...map.values()];
};
function extractPostId(url) {
  const u = new URL(url);
  if (!/(^|\.)xueqiu\.com$/i.test(u.hostname)) throw new Error("Only xueqiu.com post URLs are supported");
  const parts = u.pathname.split("/").filter(Boolean);
  const id = [...parts].reverse().find(x => /^\d{5,}$/.test(x));
  if (!id) throw new Error("Cannot extract numeric post ID from URL");
  return id;
}
function findArray(obj, preferredKeys) {
  if (!obj || typeof obj !== "object") return [];
  const roots = [obj, obj.data, obj.result, obj.data && obj.data.data].filter(x => x && typeof x === "object");
  for (const root of roots) {
    for (const key of preferredKeys) if (Array.isArray(root[key])) return root[key];
  }
  for (const root of roots) {
    for (const key of ["list", "items", "comments", "replies", "statuses", "results"]) {
      if (Array.isArray(root[key])) return root[key];
    }
  }
  return [];
}
function totalFrom(obj) {
  const roots = [obj, obj && obj.data, obj && obj.result].filter(Boolean);
  for (const root of roots) {
    for (const key of ["total", "total_count", "count", "totalCount", "reply_count", "comment_count"]) {
      const n = Number(root[key]);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}
function replyCount(item) {
  for (const key of ["reply_count", "replyCount", "reply_status_count", "reply_num", "child_count"]) {
    const n = Number(item && item[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}
function cleanUrl(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch (_) { return String(url || "").slice(0, 200); }
}

(async () => {
  let browser;
  const startedAt = new Date().toISOString();
  const errors = [];
  const observed = [];
  const rawCommentResponses = [];
  let postId = "unknown";
  let outputFile = "";
  const result = {
    schema_version: 1,
    platform: "xueqiu",
    post_url: POST_URL,
    post_id: null,
    started_at: startedAt,
    finished_at: null,
    status: "running",
    completeness: {
      claimed_complete: false,
      main_comment_pages_attempted: 0,
      main_comment_pages_successful: 0,
      reply_threads_attempted: 0,
      reply_threads_successful: 0,
      nested_threads_attempted: 0,
      comments_expected: null,
      main_comments_captured: 0,
      replies_captured: 0,
      missing_or_failed: []
    },
    post: null,
    comments: [],
    diagnostics: { observed_comment_api_urls: [], errors: [] }
  };

  try {
    if (!POST_URL) throw new Error("Missing XUEQIU_POST_URL");
    postId = extractPostId(POST_URL);
    result.post_id = postId;
    outputFile = path.join(process.cwd(), "data", "xueqiu_comments", postId + ".json");

    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
    });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: 1440, height: 1000 }
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);

    page.on("response", async response => {
      const url = response.url();
      if (!/xueqiu\.com/i.test(url) || !/(comment|repl|discussion|status)/i.test(url)) return;
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("json")) return;
      const safeUrl = cleanUrl(url);
      if (observed.length < 300 && !observed.includes(safeUrl)) observed.push(safeUrl);
      try {
        const json = await response.json();
        const list = findArray(json, ["list", "comments", "replies", "statuses", "items"]);
        if (list.length && /comment|repl|discussion/i.test(url)) {
          rawCommentResponses.push({ url: safeUrl, list, total: totalFrom(json), status: response.status() });
        }
      } catch (_) {}
    });

    console.log("[page] opening post", POST_URL);
    await page.goto(POST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(3500);
    try {
      result.post = await page.evaluate(() => {
        const title = document.title || "";
        const text = (document.body && document.body.innerText || "").slice(0, 6000);
        const canonical = document.querySelector('link[rel="canonical"]');
        return { title, canonical_url: canonical ? canonical.href : location.href, visible_text_excerpt: text };
      });
    } catch (e) { errors.push("post_metadata: " + e.message); }

    // Let the page load its own discussion requests. This is also a fallback source if the API changes.
    for (let i = 0; i < SCROLL_ROUNDS; i++) {
      try { await page.mouse.wheel(0, 1100); } catch (_) {}
      await sleep(700);
    }

    const requestJson = async (endpoint, params) => {
      const qs = new URLSearchParams(params).toString();
      const url = "https://xueqiu.com/" + endpoint + "?" + qs;
      return await page.evaluate(async url => {
        try {
          const r = await fetch(url, { credentials: "include", headers: { "x-requested-with": "XMLHttpRequest", "accept": "application/json, text/plain, */*" } });
          const text = await r.text();
          let json = null;
          try { json = JSON.parse(text); } catch (_) {}
          return { ok: r.ok, status: r.status, url: r.url, json, body_excerpt: json ? "" : text.slice(0, 240) };
        } catch (e) { return { ok: false, status: 0, url, error: String(e) }; }
      }, url);
    };

    const mainById = new Map();
    let expectedMain = null;
    let mainApiWorked = false;

    for (let p = 1; p <= MAX_COMMENT_PAGES; p++) {
      result.completeness.main_comment_pages_attempted++;
      let res = await requestJson("statuses/comments.json", { status_id: postId, page: String(p), count: String(COUNT), sort: "time" });
      let list = res.json ? findArray(res.json, ["list", "comments", "items"]) : [];
      if (!res.ok || !res.json || !list.length) {
        if (p === 1) {
          const alt = await requestJson("statuses/comments.json", { id: postId, page: String(p), count: String(COUNT) });
          const altList = alt.json ? findArray(alt.json, ["list", "comments", "items"]) : [];
          if (alt.ok && altList.length) { res = alt; list = altList; }
        }
      }
      if (res.ok && res.json && (list.length || totalFrom(res.json) === 0)) {
        mainApiWorked = true;
        result.completeness.main_comment_pages_successful++;
        const total = totalFrom(res.json);
        if (total !== null) expectedMain = total;
        for (const item of list) if (item && item.id != null) mainById.set(String(item.id), item);
        if (!list.length || list.length < COUNT || (expectedMain !== null && mainById.size >= expectedMain)) break;
      } else {
        const msg = "main_comments_page_" + p + ": HTTP " + res.status + (res.body_excerpt ? " " + res.body_excerpt : "");
        errors.push(msg);
        result.completeness.missing_or_failed.push(msg);
        break;
      }
      await sleep(DELAY_MS);
    }

    // Merge comments observed in the rendered page's own JSON responses.
    for (const batch of rawCommentResponses) {
      for (const item of batch.list) {
        if (item && item.id != null && !mainById.has(String(item.id)) &&
            (item.status_id == null || String(item.status_id) === postId || /comments\.json/i.test(batch.url))) {
          mainById.set(String(item.id), item);
        }
      }
      if (batch.total !== null && batch.total !== undefined) expectedMain = Math.max(expectedMain || 0, batch.total);
    }

    result.completeness.comments_expected = expectedMain;
    const comments = [...mainById.values()];
    const threadResults = new Map();
    const failedThreads = [];
    let replyCountCaptured = 0;

    async function fetchThread(parentId, parentItem, depth) {
      const key = String(parentId);
      if (threadResults.has(key)) return threadResults.get(key);
      if (depth > 8) {
        failedThreads.push({ parent_id: key, reason: "depth_limit" });
        return [];
      }
      if (depth === 1) result.completeness.reply_threads_attempted++;
      else result.completeness.nested_threads_attempted++;
      const found = new Map();
      let endpointWorked = false;
      let expected = replyCount(parentItem);
      for (let p = 1; p <= MAX_REPLY_PAGES; p++) {
        let res = await requestJson("statuses/replies.json", { comment_id: key, page: String(p), count: String(COUNT), sort: "time" });
        let list = res.json ? findArray(res.json, ["list", "replies", "comments", "items"]) : [];
        if ((!res.ok || !res.json || !list.length) && p === 1) {
          const alt = await requestJson("statuses/replies.json", { id: key, page: String(p), count: String(COUNT) });
          const altList = alt.json ? findArray(alt.json, ["list", "replies", "comments", "items"]) : [];
          if (alt.ok && altList.length) { res = alt; list = altList; }
        }
        if (res.ok && res.json && (list.length || totalFrom(res.json) === 0)) {
          endpointWorked = true;
          const total = totalFrom(res.json);
          if (total !== null) expected = Math.max(expected || 0, total);
          for (const item of list) if (item && item.id != null) found.set(String(item.id), item);
          if (!list.length || list.length < COUNT || (expected > 0 && found.size >= expected)) break;
        } else {
          if (p === 1 && expected === 0) break;
          const msg = "replies_for_" + key + "_page_" + p + ": HTTP " + res.status;
          errors.push(msg);
          failedThreads.push({ parent_id: key, reason: msg, expected_replies: expected });
          break;
        }
        await sleep(DELAY_MS);
      }
      const replies = [...found.values()];
      threadResults.set(key, replies);
      if (depth === 1 && endpointWorked) result.completeness.reply_threads_successful++;
      replyCountCaptured += replies.length;
      if (expected > replies.length) {
        failedThreads.push({ parent_id: key, reason: "reply_count_mismatch", expected_replies: expected, captured_replies: replies.length });
      }
      for (const child of replies) {
        if (replyCount(child) > 0) child.replies = await fetchThread(child.id, child, depth + 1);
        else child.replies = [];
      }
      return replies;
    }

    // Some Xueqiu endpoints expose the reply count only in a separate field; try every visible parent.
    for (const comment of comments) {
      comment.replies = await fetchThread(comment.id, comment, 1);
      await sleep(DELAY_MS);
    }

    result.comments = comments.map(c => ({ ...c, replies: c.replies || [] }));
    result.completeness.main_comments_captured = result.comments.length;
    result.completeness.replies_captured = replyCountCaptured;
    if (!mainApiWorked && result.comments.length === 0) {
      const msg = "No comment list could be read from the public page/API; this run is incomplete.";
      errors.push(msg);
      result.completeness.missing_or_failed.push(msg);
    }
    result.completeness.missing_or_failed.push(...failedThreads);
    const expectedReached = expectedMain === null || result.comments.length >= expectedMain;
    const threadsClean = failedThreads.length === 0;
    result.completeness.claimed_complete = Boolean(mainApiWorked && result.comments.length > 0 && expectedReached && threadsClean);
    result.status = result.completeness.claimed_complete ? "complete" : (result.comments.length ? "partial" : "failed");
    result.diagnostics.observed_comment_api_urls = observed;
    result.diagnostics.errors = errors;
  } catch (error) {
    result.status = "failed";
    errors.push(String(error && error.stack || error));
    result.diagnostics.errors = errors;
    result.completeness.missing_or_failed.push(String(error && error.message || error));
  } finally {
    if (browser) try { await browser.close(); } catch (_) {}
    result.finished_at = new Date().toISOString();
    if (!outputFile && postId !== "unknown") outputFile = path.join(process.cwd(), "data", "xueqiu_comments", postId + ".json");
    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, JSON.stringify(result, null, 2) + "\n", "utf8");
      console.log("[saved]", outputFile);
    }
    console.log("[summary]", JSON.stringify({
      status: result.status,
      post_id: result.post_id,
      expected_comments: result.completeness.comments_expected,
      captured_comments: result.completeness.main_comments_captured,
      replies: result.completeness.replies_captured,
      failed_threads: result.completeness.missing_or_failed.length,
      claimed_complete: result.completeness.claimed_complete
    }));
    if (result.status === "failed") process.exitCode = 1;
  }
})();
