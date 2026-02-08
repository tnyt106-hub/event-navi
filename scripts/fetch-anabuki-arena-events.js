// あなぶきアリーナ香川のイベント情報を WordPress REST API から取得し、JSONに保存するバッチ。
// 使い方: node scripts/fetch-anabuki-arena-events.js

const path = require("path");
const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");
const { writeJsonPretty } = require("./lib/io");
const { decodeHtmlEntities } = require("./lib/text");

const REST_URL = "https://kagawa-arena.com/?rest_route=/wp/v2/event&_embed";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "anabuki_arena_kagawa.json");
const VENUE_ID = "anabuki_arena_kagawa";
const MONTH_RANGE = 7;
const PER_PAGE = 10;
const MAX_PAGES = 100;
const DEFAULT_TIMEOUT_MS = 30000;
const CONCURRENCY = 5; // 同時に5ページ分取得する

function stripTags(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "");
}

function htmlToText(html) {
  return stripTags(decodeHtmlEntities(html)).replace(/\s+/g, " ").trim();
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function parseDateString(value) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return buildDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function parseTimeStrict(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!/^\d{2}:\d{2}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function buildTargetRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const endExclusive = new Date(start);
  endExclusive.setMonth(endExclusive.getMonth() + MONTH_RANGE);
  return { start, endExclusive };
}

async function fetchJsonWithStatus(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, DEFAULT_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Referer: "https://kagawa-arena.com/",
        "Accept-Language": "ja,en-US;q=0.9",
      },
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`HTTP 取得に失敗しました。 (${error.message})`);
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await response.text();
  const status = response.status;

  // ログ出力を維持
  console.log(`[diagnose] status=${status}`);

  if (status === 200) {
    try {
      const data = JSON.parse(text);
      return { status, text, data };
    } catch (error) {
      throw new Error(`REST API JSON の解析に失敗しました。 (${error.message})`);
    }
  }
  return { status, text, data: null };
}

// 高速化版：全ページ取得
async function fetchAllPosts() {
  const allItems = [];
  let page = 1;
  let reachedEnd = false;

  // 並列リクエスト用のワーカー
  while (!reachedEnd && page <= MAX_PAGES) {
    const promises = [];
    const batchSize = Math.min(CONCURRENCY, MAX_PAGES - page + 1);

    for (let i = 0; i < batchSize; i++) {
      const currentPage = page + i;
      const url = `${REST_URL}&per_page=${PER_PAGE}&page=${currentPage}`;
      promises.push(fetchJsonWithStatus(url).then(res => ({ ...res, page: currentPage })));
    }

    const results = await Promise.all(promises);
    // ページ番号順にソートして処理（ログの順序を守るため）
    results.sort((a, b) => a.page - b.page);

    for (const result of results) {
      if (result.status === 200) {
        if (Array.isArray(result.data) && result.data.length > 0) {
          allItems.push(...result.data);
          page++;
        } else {
          reachedEnd = true;
          break;
        }
      } else {
        // 400エラー（終端）またはその他のエラー処理
        if (result.page > 1 && result.status === 400) {
          let errorData = null;
          try { errorData = JSON.parse(result.text); } catch { }
          if (errorData && errorData.code === "rest_post_invalid_page_number") {
            console.warn(`[fetch] reached end of pages: page=${result.page} code=${errorData.code}`);
            reachedEnd = true;
            break;
          }
        }
        // 1ページ目での失敗、または想定外のエラー
        throw new Error(`REST API HTTP ${result.status} で失敗しました: page=${result.page}`);
      }
    }
    if (reachedEnd) break;
  }

  if (page > MAX_PAGES) {
    console.warn(`[fetch] MAX_PAGES に到達したため打ち切り: ${MAX_PAGES}`);
  }

  console.log(`[fetch] pages_fetched: ${page - 1}, posts_total: ${allItems.length}`);
  return allItems;
}

function buildEventFromPost(post, summary, start, endExclusive) {
  const title = htmlToText(post?.title?.rendered || "");
  const sourceUrl = typeof post?.link === "string" ? post.link.trim() : "";
  const startDateRaw = typeof post?.acf?.start_date === "string" ? post.acf.start_date.trim() : "";

  if (!title || !sourceUrl || !startDateRaw) {
    summary.excludedInvalid += 1;
    return null;
  }

  const dateFrom = parseDateString(startDateRaw);
  if (!dateFrom) {
    summary.excludedInvalid += 1;
    return null;
  }

  if (dateFrom < start || dateFrom >= endExclusive) {
    summary.filteredOutCount += 1;
    return null;
  }

  let dateTo = dateFrom;
  const endDateRaw = typeof post?.acf?.end_date === "string" ? post.acf.end_date.trim() : "";
  if (endDateRaw) {
    const parsedEnd = parseDateString(endDateRaw);
    if (!parsedEnd) {
      summary.excludedInvalid += 1;
      return null;
    }
    dateTo = parsedEnd;
  }

  const detailGroup = post?.acf?.detail_group || {};
  const openTime = parseTimeStrict(detailGroup.e_start);
  const startTime = parseTimeStrict(detailGroup.e_start2);
  const endTime = parseTimeStrict(detailGroup.e_end);

  const price = typeof detailGroup.e_price === "string" ? detailGroup.e_price.trim() : "";
  const contact = typeof detailGroup.e_contact === "string" ? detailGroup.e_contact.trim() : "";

  return {
    title,
    date_from: formatDate(dateFrom),
    date_to: formatDate(dateTo),
    source_url: sourceUrl,
    open_time: openTime,
    start_time: startTime,
    end_time: endTime,
    price: price || null,
    contact: contact || null,
    source_type: "rest_api",
    tags: null,
  };
}

async function main() {
  const { start, endExclusive } = buildTargetRange();
  const summary = { excludedInvalid: 0, filteredOutCount: 0 };

  let posts;
  try {
    posts = await fetchAllPosts();
  } catch (error) {
    console.error(`REST API 取得エラー: ${error.message}`);
    process.exit(1);
    return;
  }

  const events = [];
  for (const post of posts) {
    const event = buildEventFromPost(post, summary, start, endExclusive);
    if (event) events.push(event);
  }

  console.log(`[fetch] excluded_invalid: ${summary.excludedInvalid}`);
  console.log(`[fetch] events_built: ${events.length}`);
  console.log(`[fetch] output_path: ${OUTPUT_PATH}`);

  if (events.length === 0) {
    console.warn("採用イベントが0件のため、published を更新しません。");
    process.exit(1);
    return;
  }

  const today = formatDate(new Date());
  const data = {
    venue_id: VENUE_ID,
    last_success_at: today,
    events: events.sort((a, b) => a.date_from.localeCompare(b.date_from)),
  };

  applyTagsToEventsData(data, { overwrite: false });
  writeJsonPretty(OUTPUT_PATH, data);
  console.log(`[OK] events: ${events.length} -> ${OUTPUT_PATH}`);
}

if (require.main === module) {
  main();
}
