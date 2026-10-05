const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// Weibo 24h crawler — harvest m.weibo.cn user timeline.
// UID from https://weibo.com/u/3962719063  (挖地瓜的超级鹿鼎公)
const USER_ID = process.env.WEIBO_USER_ID || "3962719063";
const PROFILE_URL = `https://m.weibo.cn/u/${USER_ID}`;
const API_BASE =
  `https://m.weibo.cn/api/container/getIndex?type=uid&value=${USER_ID}&containerid=107603${USER_ID}`;
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const WINDOW_MS = 24 * 3600 * 1000;

function beijingStamp(d) {
  return {
    date: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d),
    time: new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      dateStyle: "full",
      timeStyle: "medium",
    }).format(d),
  };
}

function parseWeiboTime(s) {
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  return null;
}

function normalizeCard(card) {
  const m = card.mblog || card;
  if (!m || m.id == null) return null;
  const createdMs = parseWeiboTime(m.created_at);
  const text = String(m.text || m.raw_text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim()
    .slice(0, 3000);
  const kind = m.retweeted_status
    ? "retweet"
    : m.isLongText
      ? "long"
      : "status";
  return {
    id: String(m.id),
    mid: m.mid ? String(m.mid) : String(m.id),
    created_at: createdMs
      ? new Date(createdMs).toISOString()
      : String(m.created_at || ""),
    kind,
    url: `https://weibo.com/${USER_ID}/${m.bid || m.id}`,
    text,
    source: (m.source || "").replace(/<[^>]+>/g, "").trim(),
    reposts: m.reposts_count ?? null,
    comments: m.comments_count ?? null,
    attitudes: m.attitudes_count ?? null,
  };
}

function extractPostsFromJson(j) {
  const out = [];
  const cards = (j && j.data && j.data.cards) || [];
  for (const c of cards) {
    const group = c.card_group || [c];
    for (const item of group) {
      const n = normalizeCard(item);
      if (n) out.push(n);
    }
  }
  const statuses = (j && j.data && j.data.statuses) || [];
  for (const s of statuses) {
    const n = normalizeCard(s);
    if (n) out.push(n);
  }
  return out;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    extraHTTPHeaders: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();

  const harvested = [];
  let apiHits = 0;

  page.on("response", async (resp) => {
    const url = resp.url();
    if (!/m\.weibo\.cn\/api\/container\/getIndex/i.test(url)) return;
    try {
      const j = await resp.json();
      const posts = extractPostsFromJson(j);
      if (posts.length) {
        apiHits++;
        harvested.push(...posts);
      }
    } catch (_) {}
  });

  let posts = [];
  let freshSource = "none";

  try {
    console.log("Seeding m.weibo.cn home...");
    await page.goto("https://m.weibo.cn/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(2000);
    console.log("Home title:", await page.title());
    console.log(
      "Home URL:",
      page.url(),
      "cookies:",
      (await context.cookies()).map((c) => c.name).join(",")
    );

    const cookies = await context.cookies();
    if (!cookies.some((c) => c.name === "SUB" || c.name === "SUBP")) {
      console.log("No SUB cookie; trying visitor gen...");
      try {
        await page.goto(
          "https://passport.weibo.com/visitor/genvisitor?cb=visitor_gray",
          { waitUntil: "domcontentloaded", timeout: 30000 }
        );
        await page.waitForTimeout(1500);
        const body = await page.content();
        const m = body.match(/"tid":"([^"]+)"/);
        if (m) {
          console.log("visitor tid:", m[1].slice(0, 20) + "...");
          await page.goto(
            `https://passport.weibo.com/visitor/visitor?a=incarnate&t=${m[1]}&w=2&c=095&gc=&cb=cross_domain&from=weibo&_rand=${Math.random()}`,
            { waitUntil: "domcontentloaded", timeout: 30000 }
          );
          await page.waitForTimeout(1500);
        }
      } catch (e) {
        console.warn("visitor flow error:", e.message);
      }
      console.log(
        "cookies after visitor:",
        (await context.cookies()).map((c) => c.name).join(",")
      );
    }

    console.log("Opening profile:", PROFILE_URL);
    await page.goto(PROFILE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(4000);
    console.log("Profile title:", await page.title());
    console.log("Profile URL:", page.url());

    const snippet = await page.evaluate(() => {
      const t = document.body ? document.body.innerText : "";
      return t.slice(0, 300).replace(/\s+/g, " ");
    });
    console.log("Page snippet:", snippet);

    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(900);
    }
    await page.waitForTimeout(1500);

    const cutoff = Date.now() - WINDOW_MS;
    let sinceId = null;
    for (let pageNo = 1; pageNo <= 12; pageNo++) {
      let apiUrl = `${API_BASE}&page=${pageNo}`;
      if (sinceId) apiUrl += `&since_id=${encodeURIComponent(sinceId)}`;
      console.log(`[api] page ${pageNo}`);
      let resp;
      try {
        resp = await context.request.get(apiUrl, {
          headers: {
            Referer: PROFILE_URL,
            "X-Requested-With": "XMLHttpRequest",
            Accept: "application/json, text/plain, */*",
            "MWeibo-Pwa": "1",
            "X-XSRF-TOKEN":
              (await context.cookies()).find((c) => c.name === "XSRF-TOKEN")
                ?.value || "",
          },
          timeout: 30000,
        });
      } catch (e) {
        console.warn(`[api] request error: ${e.message}`);
        break;
      }
      const status = resp.status();
      const text = await resp.text();
      console.log(
        `[api] http ${status} bodyHead=${text.slice(0, 120).replace(/\s+/g, " ")}`
      );
      if (status !== 200) break;
      let j;
      try {
        j = JSON.parse(text);
      } catch (_) {
        console.warn("[api] not json");
        break;
      }
      const batch = extractPostsFromJson(j);
      const cardlistInfo = (j.data && j.data.cardlistInfo) || {};
      sinceId = cardlistInfo.since_id || null;
      let oldest = Infinity;
      for (const p of batch) {
        harvested.push(p);
        const ms = parseWeiboTime(p.created_at);
        if (ms) oldest = Math.min(oldest, ms);
      }
      console.log(
        `[api] posts=${batch.length} since_id=${sinceId} ok=${j.ok}`
      );
      if (batch.length === 0) break;
      if (oldest !== Infinity && oldest < cutoff) break;
      if (!sinceId && pageNo > 1) break;
      await page.waitForTimeout(500);
    }

    const map = new Map();
    for (const p of harvested) {
      if (!map.has(p.id)) map.set(p.id, p);
    }
    const all = [...map.values()];
    const withTs = all.filter((p) => /^\d{4}-/.test(String(p.created_at)));
    if (withTs.length) {
      posts = withTs.filter(
        (p) => new Date(p.created_at).getTime() >= cutoff
      );
      freshSource = "api+xhr";
    } else if (all.length) {
      posts = all;
      freshSource = "api-no-ts";
    }

    console.log(
      `Source=${freshSource}; harvested=${all.length}; in-24h=${posts.length}; apiHits=${apiHits}`
    );
    if (posts.length) {
      console.log(`Sample: ${JSON.stringify(posts[0]).slice(0, 280)}`);
    } else {
      console.warn("WARNING: no posts in 24h window.");
    }
  } catch (error) {
    console.error("Crawler failed:");
    console.error(error);
  } finally {
    const dataDir = path.join(process.cwd(), "data", "weibo", USER_ID);
    const existing = new Set();
    if (fs.existsSync(dataDir)) {
      for (const f of fs.readdirSync(dataDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const d = JSON.parse(
            fs.readFileSync(path.join(dataDir, f), "utf8")
          );
          for (const p of d.posts || []) existing.add(String(p.id));
        } catch (_) {}
      }
    }
    const newPosts = posts.filter((p) => !existing.has(p.id));

    const now = new Date();
    const stamp = beijingStamp(now);
    fs.mkdirSync(dataDir, { recursive: true });
    const output = {
      user_id: USER_ID,
      profile_url: `https://weibo.com/u/${USER_ID}`,
      window: "last-24h",
      source: freshSource,
      crawled_at_beijing: stamp.time,
      crawled_date: stamp.date,
      post_count: newPosts.length,
      posts: newPosts,
    };
    const outputFile = path.join(dataDir, `${stamp.date}.json`);
    let mergedFile = output;
    if (fs.existsSync(outputFile)) {
      try {
        const prev = JSON.parse(fs.readFileSync(outputFile, "utf8"));
        const have = new Set((prev.posts || []).map((p) => String(p.id)));
        for (const p of newPosts) if (!have.has(p.id)) prev.posts.push(p);
        prev.post_count = (prev.posts || []).length;
        prev.crawled_at_beijing = stamp.time;
        prev.source = freshSource;
        mergedFile = prev;
      } catch (_) {}
    }
    fs.writeFileSync(outputFile, JSON.stringify(mergedFile, null, 2), "utf8");
    console.log(
      `Posts: source=${freshSource} captured=${posts.length} new=${newPosts.length}.`
    );
    console.log(`Saved to: ${outputFile}`);
    await browser.close();
  }
})();
