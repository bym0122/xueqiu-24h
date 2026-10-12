const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const POST_URL = (process.env.XUEQIU_POST_URL || "").trim();
const PAGE_SIZE = 20;
const DELAY_MS = 250;
const MAX_COMMENT_PAGES = Math.max(1, Number(process.env.MAX_COMMENT_PAGES || 100));
const MAX_REPLY_PAGES = Math.max(1, Number(process.env.MAX_REPLY_PAGES || 50));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function postIdFrom(url) {
  const u = new URL(url);
  if (!/(^|\.)xueqiu\.com$/i.test(u.hostname)) throw new Error("Only xueqiu.com post URLs are supported");
  const id = u.pathname.split("/").filter(Boolean).reverse().find(x => /^\d{5,}$/.test(x));
  if (!id) throw new Error("Cannot extract numeric post ID from URL");
  return id;
}
function arraysIn(obj, out, depth) {
  if (!obj || typeof obj !== "object" || depth > 5) return out;
  if (Array.isArray(obj)) { if (obj.length && obj.some(x => x && typeof x === "object" && x.id != null)) out.push(obj); return out; }
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && /list|comment|repl|status|item|result/i.test(k) && v.some(x => x && typeof x === "object" && x.id != null)) out.push(v);
    else if (v && typeof v === "object") arraysIn(v, out, depth + 1);
  }
  return out;
}
function getList(json) {
  const candidates = arraysIn(json, [], 0);
  candidates.sort((a,b) => b.length - a.length);
  return candidates[0] || [];
}
function totalFrom(obj) {
  const roots = [
    obj,
    obj && obj.data,
    obj && obj.result,
    obj && obj.pagination,
    obj && obj.meta,
    obj && obj.data && obj.data.pagination,
    obj && obj.data && obj.data.meta
  ].filter(x => x && typeof x === "object" && !Array.isArray(x));
  for (const root of roots) {
    for (const k of ["total", "total_count", "totalCount", "total_num", "totalNum", "comments_count", "comment_count"]) {
      const n = Number(root[k]);
      if (root[k] != null && Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}
function countReplies(x) {
  for (const k of ["reply_count", "comment_reply_count", "replyCount", "reply_num", "child_count"]) {
    const n = Number(x && x[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}
function safeObservedUrl(raw) {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (/token|cookie|secret|authorization|access_key/i.test(k)) u.searchParams.set(k, "[redacted]");
    return u.toString();
  } catch (_) { return String(raw || "").slice(0, 300); }
}
function mapById(items) {
  const m = new Map();
  for (const x of items || []) if (x && x.id != null) m.set(String(x.id), x);
  return m;
}
function mergeById(...arrays) {
  const m = new Map();
  for (const a of arrays) for (const x of a || []) if (x && x.id != null) {
    const key = String(x.id);
    m.set(key, { ...(m.get(key) || {}), ...x });
  }
  return [...m.values()];
}

(async () => {
  let browser = null;
  let outputFile = null;
  let postId = null;
  const errors = [];
  const observedUrls = [];
  const commentResponses = [];
  const startedAt = new Date().toISOString();
  const result = {
    schema_version: 3, platform: "xueqiu", post_url: POST_URL, post_id: null,
    started_at: startedAt, finished_at: null, status: "running",
    completeness: {
      claimed_complete: false, main_comment_pages_attempted: 0, main_comment_pages_successful: 0,
      reply_threads_attempted: 0, reply_threads_successful: 0, nested_threads_attempted: 0,
      comments_expected: null, main_comments_captured: 0, replies_captured: 0, missing_or_failed: []
    },
    post: null, comments: [],
    diagnostics: { observed_comment_api_urls: [], errors: [], notes: [] }
  };

  try {
    if (!POST_URL) throw new Error("Missing XUEQIU_POST_URL");
    postId = postIdFrom(POST_URL);
    result.post_id = postId;
    outputFile = path.join(process.cwd(), "data", "xueqiu_comments", postId + ".json");

    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"] });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "zh-CN", timezoneId: "Asia/Shanghai", viewport: { width: 1440, height: 1000 }
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
      if (!/xueqiu\.com/i.test(url) || !/(comment|repl|discussion)/i.test(url)) return;
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("json")) return;
      const safeUrl = safeObservedUrl(url);
      if (!observedUrls.includes(safeUrl) && observedUrls.length < 500) observedUrls.push(safeUrl);
      try {
        const json = await response.json();
        const list = getList(json);
        if (list.length) commentResponses.push({ url: safeUrl, list, total: totalFrom(json), status: response.status() });
      } catch (_) {}
    });

    console.log("[page] opening post " + POST_URL);
    await page.goto(POST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(2500);
    result.post = await page.evaluate(() => {
      const canonical = document.querySelector('link[rel="canonical"]');
      return {
        title: document.title || "",
        canonical_url: canonical ? canonical.href : location.href,
        visible_text_excerpt: (document.body && document.body.innerText || "").slice(0, 6000)
      };
    }).catch(e => ({ error: e.message }));
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 1000).catch(() => {});
      await sleep(500);
    }
    await sleep(700);

    const apiRequest = async url => {
      try {
        const response = await context.request.get(url, {
          timeout: 20000,
          headers: { referer: POST_URL, accept: "application/json, text/plain, */*", "x-requested-with": "XMLHttpRequest" }
        });
        const body = await response.text();
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        return { ok: response.ok(), status: response.status(), url, json, excerpt: json ? "" : body.slice(0, 180) };
      } catch (e) { return { ok: false, status: 0, url, json: null, error: e.message }; }
    };
    const makePageUrl = (base, pageNo, targetId) => {
      const u = new URL(base);
      u.searchParams.set("page", String(pageNo));
      if (u.searchParams.has("count")) u.searchParams.set("count", String(PAGE_SIZE));
      else if (u.searchParams.has("size")) u.searchParams.set("size", String(PAGE_SIZE));
      else u.searchParams.set("count", String(PAGE_SIZE));
      if (targetId != null) {
        if (u.searchParams.has("status_id")) u.searchParams.set("status_id", String(targetId));
        else u.searchParams.set("id", String(targetId));
      }
      return u.toString();
    };

    const capturedMain = commentResponses.filter(x => /\/statuses\/v3\/comments\.json/i.test(x.url) || /\/statuses\/comments\.json/i.test(x.url));
    const mainBase = capturedMain.length
      ? capturedMain[0].url
      : "https://xueqiu.com/statuses/v3/comments.json?id=" + postId + "&count=" + PAGE_SIZE + "&page=1&sort=created_at";
    let expectedMain = null;
    const mainMap = new Map();
    let mainApiWorked = false;
    let mainPaginationExhausted = false;

    for (let p = 1; p <= MAX_COMMENT_PAGES; p++) {
      result.completeness.main_comment_pages_attempted++;
      const res = await apiRequest(makePageUrl(mainBase, p, postId));
      const list = res.json ? getList(res.json) : [];
      if (res.ok && res.json && (list.length || totalFrom(res.json) === 0)) {
        mainApiWorked = true;
        result.completeness.main_comment_pages_successful++;
        const total = totalFrom(res.json);
        if (total !== null) expectedMain = total;
        const before = mainMap.size;
        for (const x of list) if (x && x.id != null) mainMap.set(String(x.id), { ...(mainMap.get(String(x.id)) || {}), ...x });
        if (!list.length || list.length < PAGE_SIZE) { mainPaginationExhausted = true; break; }
        if (mainMap.size === before) {
          result.diagnostics.notes.push("Main comments pagination stopped because a page repeated IDs; completeness cannot be inferred from this alone.");
          break;
        }
        if (expectedMain !== null && mainMap.size >= expectedMain) { mainPaginationExhausted = true; break; }
      } else {
        const msg = "main_comments_page_" + p + ": HTTP " + res.status + (res.error ? " " + res.error : "") + (res.excerpt ? " " + res.excerpt : "");
        errors.push(msg);
        result.completeness.missing_or_failed.push(msg);
        break;
      }
      await sleep(DELAY_MS);
    }

    // Merge main comments found in the rendered page's v3/comments responses, not reply-endpoint responses.
    for (const batch of capturedMain) {
      for (const x of batch.list) if (x && x.id != null) mainMap.set(String(x.id), { ...(mainMap.get(String(x.id)) || {}), ...x });
      if (batch.total !== null && batch.total !== undefined) expectedMain = Math.max(expectedMain || 0, batch.total);
    }
    const comments = [...mainMap.values()];
    if (expectedMain === null && mainPaginationExhausted) expectedMain = comments.length;
    result.completeness.comments_expected = expectedMain;

    const threadCache = new Map();
    const failedThreads = [];
    let totalRepliesCaptured = 0;
    async function fetchThread(parent, depth) {
      const cacheKey = String(parent.id);
      if (threadCache.has(cacheKey)) return threadCache.get(cacheKey);
      if (depth > 8) { failedThreads.push({ parent_id: cacheKey, reason: "depth_limit" }); return []; }
      const seed = mergeById(parent.child_comments || [], parent.replies || [], parent.reply_comment ? [parent.reply_comment] : []);
      const expected = countReplies(parent);
      if (expected === 0 && seed.length === 0) { threadCache.set(cacheKey, []); return []; }
      if (expected > 0 && seed.length >= expected) {
        threadCache.set(cacheKey, seed);
        totalRepliesCaptured += seed.length;
        return seed;
      }
      if (depth === 1) result.completeness.reply_threads_attempted++;
      else result.completeness.nested_threads_attempted++;
      const found = mapById(seed);
      let endpointWorked = false;
      const targetId = parent.statusId || parent.status_id || parent.id;
      const base = "https://xueqiu.com/statuses/v3/comments.json?id=" + encodeURIComponent(String(targetId)) + "&count=" + PAGE_SIZE + "&page=1&sort=created_at";
      for (let p = 1; p <= MAX_REPLY_PAGES; p++) {
        let res = await apiRequest(makePageUrl(base, p, targetId));
        let list = res.json ? getList(res.json) : [];
        if (!res.ok || !res.json || (!list.length && totalFrom(res.json) !== 0)) {
          const legacy = await apiRequest("https://xueqiu.com/statuses/replies.json?comment_id=" + encodeURIComponent(String(parent.id)) + "&page=" + p + "&count=" + PAGE_SIZE);
          const legacyList = legacy.json ? getList(legacy.json) : [];
          if (legacy.ok && legacy.json && (legacyList.length || totalFrom(legacy.json) === 0)) { res = legacy; list = legacyList; }
        }
        if (res.ok && res.json && (list.length || totalFrom(res.json) === 0)) {
          endpointWorked = true;
          const before = found.size;
          for (const x of list) {
            if (!x || x.id == null || String(x.id) === String(parent.id)) continue;
            if (x.in_reply_to_comment_id != null && String(x.in_reply_to_comment_id) !== String(parent.id) &&
                String(x.root_in_reply_to_status_id || "") !== String(postId)) continue;
            found.set(String(x.id), { ...(found.get(String(x.id)) || {}), ...x });
          }
          if (!list.length || list.length < PAGE_SIZE) break;
          if (found.size === before) break;
          if (expected > 0 && found.size >= expected) break;
        } else {
          if (p === 1 && seed.length) break;
          if (expected > 0) failedThreads.push({ parent_id: cacheKey, reason: "reply_endpoint_unavailable", http_status: res.status, expected_replies: expected });
          break;
        }
        await sleep(DELAY_MS);
      }
      const replies = [...found.values()];
      threadCache.set(cacheKey, replies);
      if (depth === 1 && endpointWorked) result.completeness.reply_threads_successful++;
      totalRepliesCaptured += replies.length;
      if (expected > replies.length) failedThreads.push({ parent_id: cacheKey, reason: "reply_count_mismatch", expected_replies: expected, captured_replies: replies.length });
      for (const child of replies) {
        if (countReplies(child) > 0 || (child.child_comments && child.child_comments.length)) child.replies = await fetchThread(child, depth + 1);
        else child.replies = [];
      }
      return replies;
    }

    for (const comment of comments) {
      comment.replies = await fetchThread(comment, 1);
      await sleep(100);
    }
    result.comments = comments.map(c => ({ ...c, replies: c.replies || [] }));
    result.completeness.main_comments_captured = result.comments.length;
    result.completeness.replies_captured = totalRepliesCaptured;
    if (!mainApiWorked) {
      const msg = "Direct v3 comment pagination did not return a confirmed successful page; rendered comments are retained but main pagination is unverified.";
      result.completeness.missing_or_failed.push(msg);
      result.diagnostics.notes.push(msg);
    }
    result.completeness.missing_or_failed.push(...failedThreads);
    const expectedReached = expectedMain !== null && result.comments.length >= expectedMain;
    const threadsClean = failedThreads.length === 0;
    result.completeness.claimed_complete = Boolean(mainApiWorked && expectedReached && mainPaginationExhausted && threadsClean && errors.length === 0);
    result.status = result.completeness.claimed_complete ? "complete" : (result.comments.length ? "partial" : "failed");
    result.diagnostics.observed_comment_api_urls = observedUrls;
    result.diagnostics.errors = errors;
  } catch (error) {
    result.status = "failed";
    errors.push(String(error && error.stack || error));
    result.diagnostics.errors = errors;
    result.completeness.missing_or_failed.push(String(error && error.message || error));
  } finally {
    if (browser) try { await browser.close(); } catch (_) {}
    result.finished_at = new Date().toISOString();
    if (!outputFile && postId) outputFile = path.join(process.cwd(), "data", "xueqiu_comments", postId + ".json");
    if (outputFile) {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
      fs.writeFileSync(outputFile, JSON.stringify(result, null, 2) + "\n", "utf8");
      console.log("[saved] " + outputFile);
    }
    console.log("[summary] " + JSON.stringify({
      status: result.status, post_id: result.post_id,
      expected_comments: result.completeness.comments_expected,
      captured_comments: result.completeness.main_comments_captured,
      replies: result.completeness.replies_captured,
      failed_threads: result.completeness.missing_or_failed.length,
      claimed_complete: result.completeness.claimed_complete
    }));
    if (result.status === "failed") process.exitCode = 1;
  }
})();
