// あなぶきアリーナ香川のイベント情報を WordPress REST API から取得し、JSONに保存するバッチ。
// 使い方: node scripts/fetch-anabuki-arena-events.js

const path = require("path");

const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");
// 共通 HTTP 取得ユーティリティで JSON を取得する。
const { fetchText } = require("./lib/http");
// JSON 保存処理を共通化する。
const { writeJsonPretty } = require("./lib/io");
// HTML エンティティをデコードする。
const { decodeHtmlEntities } = require("./lib/text");

const REST_URL = "https://kagawa-arena.com/?rest_route=/wp/v2/event&_embed";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "anabuki_arena_kagawa.json");
const VENUE_ID = "anabuki_arena_kagawa";
const MONTH_RANGE = 7;
const PER_PAGE = 10;
const MAX_PAGES = 100;

// タグを落としてプレーンテキスト化する。
function stripTags(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "");
}

// タイトルなど HTML を含むテキストをプレーンテキスト化する。
function htmlToText(html) {
  return stripTags(decodeHtmlEntities(html)).replace(/\s+/g, " ").trim();
}

// ISO 形式 (YYYY-MM-DD) の日付文字列にする。
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// 日付が有効かどうかをチェックする。
function buildDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

// YYYY-MM-DD 文字列を Date に変換する。
function parseDateString(value) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return buildDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

// HH:MM のみ許容する時刻パーサー。
function parseTimeStrict(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!/^\d{2}:\d{2}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

// 現在月の月初と、そこから7か月後の排他終点を作る。
function buildTargetRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const endExclusive = new Date(start);
  endExclusive.setMonth(endExclusive.getMonth() + MONTH_RANGE);
  return { start, endExclusive };
}

// JSON を HTTP で取得してパースする。
async function fetchJson(url) {
  const text = await fetchText(url, {
    acceptEncoding: "identity",
    encoding: "utf-8",
    headers: {
      Accept: "application/json",
    },
  });
  return JSON.parse(text);
}

// ヘッダーに依存せずに全ページ分の投稿を取得する。
async function fetchAllPosts() {
  const items = [];
  let pagesFetched = 0;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${REST_URL}&per_page=${PER_PAGE}&page=${page}`;
    const data = await fetchJson(url);

    if (!Array.isArray(data)) {
      throw new Error(`REST API 応答が配列ではありません: page=${page}`);
    }

    if (data.length === 0) {
      break;
    }

    items.push(...data);
    pagesFetched += 1;
  }

  if (pagesFetched >= MAX_PAGES) {
    console.warn(`[fetch] MAX_PAGES に到達したため打ち切り: ${MAX_PAGES}`);
  }

  console.log(`[fetch] pages_fetched: ${pagesFetched}, posts_total: ${items.length}`);
  return items;
}

// 投稿データからイベント情報を組み立てる。
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

  // 開始日ベースで期間フィルタをかける。
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

  // 文字列が厳密に HH:MM でない場合は null にする。
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

// メイン処理。
async function main() {
  const { start, endExclusive } = buildTargetRange();
  const summary = {
    excludedInvalid: 0,
    filteredOutCount: 0,
  };

  let posts;
  try {
    posts = await fetchAllPosts();
  } catch (error) {
    console.error(`REST API 取得エラー: ${error.message}`);
    console.error("0件のため published を更新しません。");
    process.exit(1);
    return;
  }

  const events = [];
  for (const post of posts) {
    const event = buildEventFromPost(post, summary, start, endExclusive);
    if (event) {
      events.push(event);
    }
  }

  console.log(`[fetch] excluded_invalid: ${summary.excludedInvalid}`);
  console.log(`[fetch] events_built: ${events.length}`);
  console.log(`[fetch] output_path: ${OUTPUT_PATH}`);

  if (events.length === 0) {
    console.warn("採用イベントが0件のため、published を更新しません。");
    console.warn(`内訳: 無効データ除外=${summary.excludedInvalid}, 期間外除外=${summary.filteredOutCount}`);
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
