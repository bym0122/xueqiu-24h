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
function nextCursorFrom(json, list, currentCursor) {
  const roots = [json, json && json.data, json && json.result, json && json.pagination,
    json && json.data && json.data.pagination, json && json.data && json.data.meta].filter(x => x && typeof x === "object");
  for (const root of roots) {
    for (const k of ["next_max_id", "nextMaxId", "next_cursor", "nextCursor"]) {
      if (root[k] != null) {
        const v = String(root[k]);
        if (v === "-1") {
          const last = list && list.length ? list[list.length - 1] : null;
          return last && last.id != null && String(last.id) !== String(currentCursor) ? String(last.id) : null;
        }
        if (v === String(currentCursor)) return null;
        return v;
      }
    }
  }
  for (const root of roots) {
    for (const k of ["max_id", "maxId"]) {
      if (root[k] != null) {
        const v = String(root[k]);
        if (v === "-1") {
          const last = list && list.length ? list[list.length - 1] : null;
          return last && last.id != null && String(last.id) !== String(currentCursor) ? String(last.id) : null;
        }
        if (v === String(currentCursor)) return null;
        return v;
      }
    }
  }
  const last = list && list.length ? list[list.length - 1] : null;
  return last && last.id != null && String(last.id) !== String(currentCursor) ? String(last.id) : null;
}
function discussionCountFrom(json) {
  const roots = [json, json && json.data, json && json.result].filter(x => x && typeof x === "object");
  for (const root of roots) {
    const n = Number(root.status_reply_count);
    if (root.status_reply_count != null && Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}
function uniqueTreeCount(items) {
  const seen = new Set();
  function walk(nodes) {
    for (const node of nodes || []) {
      if (!node || node.id == null) continue;
      const key = String(node.id);
      if (!seen.has(key)) seen.add(key);
      walk(node.replies || []);
    }
  }
  walk(items);
  return seen.size;
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
      comments_expected: null, discussion_items_expected: null, discussion_items_captured: 0,
      main_comments_captured: 0, replies_captured: 0, missing_or_failed: []
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
    const makePageUrl = (base, pageNo, targetId, cursor) => {
      const u = new URL(base);
      if (u.searchParams.has("max_id")) u.searchParams.set("max_id", String(cursor == null ? "-1" : cursor));
      else u.searchParams.set("page", String(pageNo));
      if (u.searchParams.has("count")) u.searchParams.set("count", String(PAGE_SIZE));
      else if (u.searchParams.has("size")) u.searchParams.set("size", String(PAGE_SIZE));
      else u.searchParams.set("size", String(PAGE_SIZE));
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
    let mainCursor = "-1";
    result.diagnostics.pagination_pages = [];
    
    for (let p = 1; p <= MAX_COMMENT_PAGES; p++) {
      result.completeness.main_comment_pages_attempted++;
      const requestUrl = makePageUrl(mainBase, p, postId, mainCursor);
      const res = await apiRequest(requestUrl);
      const list = res.json ? getList(res.json) : [];
      const nextCursor = res.json ? nextCursorFrom(res.json, list, mainCursor) : null;
      const discussionCount = res.json ? discussionCountFrom(res.json) : null;
      if (discussionCount !== null) result.completeness.discussion_items_expected = Math.max(result.completeness.discussion_items_expected || 0, discussionCount);
      result.diagnostics.pagination_pages.push({
        kind: "main", page: p, http_status: res.status, returned: list.length,
        first_id: list[0] && list[0].id != null ? String(list[0].id) : null,
        last_id: list.length && list[list.length - 1].id != null ? String(list[list.length - 1].id) : null,
        cursor_in: mainCursor, cursor_out: nextCursor,
        json_keys: res.json && typeof res.json === "object" ? Object.keys(res.json) : [],
        next_max_id: res.json && res.json.next_max_id != null ? res.json.next_max_id : (res.json && res.json.data && res.json.data.next_max_id != null ? res.json.data.next_max_id : null),
        comment_tl_count: res.json && res.json.comment_tl_count != null ? res.json.comment_tl_count : null,
        status_reply_count: res.json && res.json.status_reply_count != null ? res.json.status_reply_count : null,
        has_filtered: res.json && res.json.has_filtered != null ? res.json.has_filtered : null
      });
      if (res.ok && res.json && (list.length || totalFrom(res.json) === 0)) {
        mainApiWorked = true;
        result.completeness.main_comment_pages_successful++;
        const total = totalFrom(res.json);
        if (total !== null) expectedMain = total;
        const before = mainMap.size;
        for (const x of list) if (x && x.id != null) mainMap.set(String(x.id), { ...(mainMap.get(String(x.id)) || {}), ...x });
        if (!list.length) { mainPaginationExhausted = true; break; }
        if (mainMap.size === before) {
          result.diagnostics.notes.push("Main comments pagination stopped because a page repeated IDs; completeness cannot be inferred from this alone.");
          break;
        }
        if (expectedMain !== null && mainMap.size >= expectedMain) { mainPaginationExhausted = true; break; }
        if (nextCursor == null || String(nextCursor) === String(mainCursor)) {
          if (list.length < PAGE_SIZE) mainPaginationExhausted = true;
          else result.diagnostics.notes.push("Main comments API returned no usable next cursor; pagination is incomplete.");
          break;
        }
        mainCursor = String(nextCursor);
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
      if (depth === 1) result.completeness.reply_threads_attempted++;
      else result.completeness.nested_threads_attempted++;
      if (expected > 0 && seed.length >= expected) {
        threadCache.set(cacheKey, seed);
        for (const child of seed) {
          if (countReplies(child) > 0 || (child.child_comments && child.child_comments.length)) child.replies = await fetchThread(child, depth + 1);
          else child.replies = [];
        }
        totalRepliesCaptured += seed.length;
        return seed;
      }
      const found = mapById(seed);
      let endpointWorked = false;
      const targetId = parent.statusId || parent.status_id || parent.id;
      const replyBaseUrl = new URL(mainBase);
      replyBaseUrl.searchParams.set("id", String(targetId));
      replyBaseUrl.searchParams.delete("status_id");
      if (replyBaseUrl.searchParams.has("max_id")) replyBaseUrl.searchParams.set("max_id", "-1");
      else replyBaseUrl.searchParams.set("page", "1");
      const base = replyBaseUrl.toString();
      let replyCursor = "-1";
      if (!result.diagnostics.reply_pages) result.diagnostics.reply_pages = [];
      for (let p = 1; p <= MAX_REPLY_PAGES; p++) {
        let res = await apiRequest(makePageUrl(base, p, targetId, replyCursor));
        let list = res.json ? getList(res.json) : [];
        let nextCursor = res.json ? nextCursorFrom(res.json, list, replyCursor) : null;
        // Xueqiu's v3 endpoint can return next_max_id=-1 while the thread reports more replies.
        // Also query the legacy page-based replies endpoint and merge any distinct reply IDs.
        if (expected > 0 && found.size < expected) {
          const legacy = await apiRequest("https://xueqiu.com/statuses/replies.json?comment_id=" + encodeURIComponent(String(parent.id)) + "&page=" + p + "&count=" + PAGE_SIZE);
          const legacyList = legacy.json ? getList(legacy.json) : [];
          if (legacy.ok && legacy.json && legacyList.length) {
            const mergedList = mergeById(list, legacyList).filter(x => x && x.id != null && String(x.id) !== String(parent.id));
            const addsNew = mergedList.some(x => !found.has(String(x.id)));
            if (addsNew) {
              list = mergedList;
              if (nextCursor == null || String(nextCursor) === String(replyCursor)) {
                const last = list[list.length - 1];
                if (last && last.id != null && String(last.id) !== String(replyCursor)) nextCursor = String(last.id);
              }
            }
          }
        }
        const discussionCount = res.json ? discussionCountFrom(res.json) : null;
      if (discussionCount !== null) result.completeness.discussion_items_expected = Math.max(result.completeness.discussion_items_expected || 0, discussionCount);
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
          result.diagnostics.reply_pages.push({
            parent_id: cacheKey, page: p, http_status: res.status, returned: list.length,
            first_id: list[0] && list[0].id != null ? String(list[0].id) : null,
            last_id: list.length && list[list.length - 1].id != null ? String(list[list.length - 1].id) : null,
            cursor_in: replyCursor, cursor_out: nextCursor,
            json_keys: res.json && typeof res.json === "object" ? Object.keys(res.json) : [],
            next_max_id: res.json && res.json.next_max_id != null ? res.json.next_max_id : (res.json && res.json.data && res.json.data.next_max_id != null ? res.json.data.next_max_id : null),
            comment_tl_count: res.json && res.json.comment_tl_count != null ? res.json.comment_tl_count : null,
        status_reply_count: res.json && res.json.status_reply_count != null ? res.json.status_reply_count : null,
        has_filtered: res.json && res.json.has_filtered != null ? res.json.has_filtered : null
          });
          if (!list.length) break;
          if (found.size === before) break;
          if (expected > 0 && found.size >= expected) break;
          if (nextCursor == null || String(nextCursor) === String(replyCursor)) break;
          replyCursor = String(nextCursor);
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
      for (const child of replies) {
        if (countReplies(child) > 0 || (child.child_comments && child.child_comments.length)) child.replies = await fetchThread(child, depth + 1);
        else child.replies = [];
      }
      const capturedThreadItems = uniqueTreeCount(replies);
      if (expected > capturedThreadItems) failedThreads.push({ parent_id: cacheKey, reason: "reply_count_mismatch", expected_replies: expected, captured_replies: capturedThreadItems });
      return replies;
    }

    for (const comment of comments) {
      comment.replies = await fetchThread(comment, 1);
      await sleep(100);
    }
    result.comments = comments.map(c => ({ ...c, replies: c.replies || [] }));
    result.completeness.main_comments_captured = result.comments.length;
    const replyIdsSeen = new Set();
    function countReplyTree(items) {
      let count = 0;
      for (const item of items || []) {
        if (item && item.id != null && !replyIdsSeen.has(String(item.id))) {
          replyIdsSeen.add(String(item.id));
          count++;
          count += countReplyTree(item.replies || []);
        }
      }
      return count;
    }
    result.completeness.replies_captured = countReplyTree(result.comments.flatMap(c => c.replies || []));
    result.completeness.discussion_items_captured = result.completeness.main_comments_captured + result.completeness.replies_captured;
    if (!mainApiWorked) {
      const msg = "Direct v3 comment pagination did not return a confirmed successful page; rendered comments are retained but main pagination is unverified.";
      result.completeness.missing_or_failed.push(msg);
      result.diagnostics.notes.push(msg);
    }
    result.completeness.missing_or_failed.push(...failedThreads);
    const expectedReached = expectedMain !== null && result.comments.length >= expectedMain;
    const threadsClean = failedThreads.length === 0;
    const discussionCountReached = result.completeness.discussion_items_expected === null ||
      result.completeness.discussion_items_captured >= result.completeness.discussion_items_expected;
    result.completeness.claimed_complete = Boolean(mainApiWorked && expectedReached && mainPaginationExhausted && threadsClean && errors.length === 0 && discussionCountReached);
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
