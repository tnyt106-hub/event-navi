// あなぶきアリーナ香川のイベント情報を WordPress REST API と 詳細ページHTML のハイブリッドで取得するバッチ。
// 使い方: node scripts/fetch-anabuki-arena-events.js

const path = require("path");
const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");
const { finalizeAndSaveEvents } = require("./lib/fetch_output");
const { decodeHtmlEntities } = require("./lib/text");

const REST_URL = "https://kagawa-arena.com/?rest_route=/wp/v2/event&_embed";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "anabuki_arena_kagawa.json");
const VENUE_ID = "anabuki_arena_kagawa";
const MONTH_RANGE = 7;
const PER_PAGE = 20; // 1ページあたりの件数を増やして効率化
const MAX_PAGES = 50;
const CONCURRENCY = 5; // 並列数
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * ユーティリティ関数
 */
function stripTags(html) {
  if (!html) return "";
  // HTML タグを削除して、タイトル比較に使えるプレーンテキストへ変換する。
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

function parseDateString(value) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return isNaN(date.getTime()) ? null : date;
}

function parseTimeStrict(value) {
  if (!value) return null;
  const trimmed = String(value).trim().replace(/[０-９：]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
  const match = trimmed.match(/(\d{1,2}:\d{2})/);
  return match ? match[1].padStart(5, "0") : null;
}

/**
 * 詳細ページHTMLから時刻情報を抽出する
 */
function extractTimesFromDetailHtml(html) {
  const result = { open: null, start: null, end: null };
  if (!html) return result;

  // dl/dt/dd 構造を考慮したラベルベースの抽出
  const timeLabels = [
    { key: "open", patterns: ["開場"] },
    { key: "start", patterns: ["開演", "開始"] },
    { key: "end", patterns: ["終演", "終了"] }
  ];

  for (const label of timeLabels) {
    for (const p of label.patterns) {
      // ラベルの直後（同一行または次のdd内）にある時刻を探す
      const regex = new RegExp(`${p}[^<]*?(?:<[^>]+>)*\\s*(\\d{1,2}:\\d{2})`, "i");
      const match = html.match(regex);
      if (match) {
        result[label.key] = parseTimeStrict(match[1]);
        break;
      }
    }
  }
  return result;
}

/**
 * HTTP 取得
 */
async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html,application/json" },
      signal: controller.signal
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * REST APIから全投稿を取得
 */
async function fetchAllPostsFromApi() {
  const allPosts = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${REST_URL}&per_page=${PER_PAGE}&page=${page}`;
    console.log(`[fetch] API page ${page}...`);
    const { status, text } = await fetchWithTimeout(url);
    console.log(`[diagnose] status=${status}`);

    if (status !== 200) {
      if (status === 400 && text.includes("rest_post_invalid_page_number")) break;
      throw new Error(`API error: ${status}`);
    }
    const data = JSON.parse(text);
    if (!data.length) break;
    allPosts.push(...data);
  }
  return allPosts;
}

/**
 * 並列実行制御関数
 */
async function mapWithConcurrency(items, concurrency, fn) {
  const results = [];
  const batches = [];
  for (let i = 0; i < items.length; i += concurrency) {
    batches.push(items.slice(i, i + concurrency));
  }
  for (const batch of batches) {
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

async function main() {
  const now = new Date();
  const rangeStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const rangeEnd = new Date(rangeStart);
  rangeEnd.setMonth(rangeEnd.getMonth() + MONTH_RANGE);

  const summary = { excludedInvalid: 0, filteredOut: 0, refined: 0 };

  // 1. APIから全件一括取得
  const posts = await fetchAllPostsFromApi();
  console.log(`[fetch] API total posts: ${posts.length}`);

  // 2. 詳細補完を含めた並列処理
  const events = await mapWithConcurrency(posts, CONCURRENCY, async (post) => {
    const title = htmlToText(post?.title?.rendered || "");
    const sourceUrl = post?.link?.trim() || "";
    const startDateRaw = post?.acf?.start_date?.trim() || "";
    
    if (!title || !sourceUrl || !startDateRaw) {
      summary.excludedInvalid++;
      return null;
    }

    const dateFrom = parseDateString(startDateRaw);
    if (!dateFrom || dateFrom < rangeStart || dateFrom >= rangeEnd) {
      summary.filteredOut++;
      return null;
    }

    // 基本データ作成
    let dateTo = parseDateString(post?.acf?.end_date?.trim()) || dateFrom;
    const detailGroup = post?.acf?.detail_group || {};
    
    let openTime = parseTimeStrict(detailGroup.e_start);
    let startTime = parseTimeStrict(detailGroup.e_start2);
    let endTime = parseTimeStrict(detailGroup.e_end);

    // 時刻が欠けている場合のみ詳細ページをスクレイピング
    if (!startTime || !openTime) {
      const { text: html } = await fetchWithTimeout(sourceUrl).catch(() => ({ text: null }));
      if (html) {
        const refined = extractTimesFromDetailHtml(html);
        if (!openTime && refined.open) openTime = refined.open;
        if (!startTime && refined.start) startTime = refined.start;
        if (!endTime && refined.end) endTime = refined.end;
        if (refined.start || refined.open) {
          summary.refined++;
          console.log(`[refine] Found times for: ${title}`);
        }
      }
    }

    return {
      title,
      date_from: formatDate(dateFrom),
      date_to: formatDate(dateTo),
      source_url: sourceUrl,
      open_time: openTime,
      start_time: startTime,
      end_time: endTime,
      price: post?.acf?.detail_group?.e_price?.trim() || null,
      contact: post?.acf?.detail_group?.e_contact?.trim() || null,
      source_type: "hybrid_api_scraping",
      tags: null
    };
  });

  const validEvents = events.filter(e => e !== null).sort((a, b) => a.date_from.localeCompare(b.date_from));

  finalizeAndSaveEvents({
    venueId: VENUE_ID,
    outputPath: OUTPUT_PATH,
    events: validEvents,
    lastSuccessAt: formatDate(new Date()),
    beforeWrite(data) {
      applyTagsToEventsData(data, { overwrite: false });
    },
  });

  console.log(`\n[Summary]`);
  console.log(`- API Total: ${posts.length}`);
  console.log(`- Refined from HTML: ${summary.refined}`);
  console.log(`- Output Events: ${validEvents.length}`);
  console.log(`[OK] Saved to: ${OUTPUT_PATH}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
