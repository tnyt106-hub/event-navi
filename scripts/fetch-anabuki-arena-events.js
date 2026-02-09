// あなぶきアリーナ香川のイベント情報を WordPress REST API と 詳細ページHTML のハイブリッドで取得するバッチ。
// 使い方: node scripts/fetch-anabuki-arena-events.js

const path = require("path");
// HTTP 取得は共通ユーティリティへ寄せて、リトライ/タイムアウト/エラー分類を統一する。
const { fetchText } = require("./lib/http");
const { finalizeAndSaveEvents } = require("./lib/fetch_output");
const { handleCliFatalError } = require("./lib/cli_error");
const { mapWithConcurrencyLimit } = require("./lib/concurrency");
const { decodeHtmlEntities, stripTagsCompact, normalizeDecodedText } = require("./lib/text");
const { formatIsoDateFromLocalDate, parseIsoDateAsLocalStrict } = require("./lib/date");
const { ERROR_TYPES } = require("./lib/error_types");
const { parseJsonOrThrowTyped } = require("./lib/json");

const REST_URL = "https://kagawa-arena.com/?rest_route=/wp/v2/event&_embed";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "anabuki_arena_kagawa.json");
const VENUE_ID = "anabuki_arena_kagawa";
const MONTH_RANGE = 7;
const PER_PAGE = 20; // 1ページあたりの件数を増やして効率化
const MAX_PAGES = 50;
const CONCURRENCY = 5; // 並列数

/**
 * ユーティリティ関数
 */
function htmlToText(html) {
  // HTML タグ除去 + 空白正規化は共通ユーティリティに統一する。
  return normalizeDecodedText(stripTagsCompact(decodeHtmlEntities(html)));
}

function formatDate(date) {
  // Date から ISO 文字列へ整形する処理は共通関数を使って統一する。
  return formatIsoDateFromLocalDate(date);
}

function parseDateString(value) {
  // 入力形式と実在日付を厳密チェックして、無効値を早期に除外する。
  return parseIsoDateAsLocalStrict(value);
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
 * REST APIから全投稿を取得
 */
async function fetchAllPostsFromApi() {
  const allPosts = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${REST_URL}&per_page=${PER_PAGE}&page=${page}`;
    console.log(`[fetch] API page ${page}...`);
    let text = "";
    try {
      text = await fetchText(url, {
        headers: { Accept: "application/json,text/html" },
        checkErrorIndicators: false,
      });
    } catch (error) {
      // WordPress REST API は最終ページ到達時に 400 を返すことがある。
      // 旧実装の「invalid page で終了」を維持するため、ここだけ打ち切り扱いにする。
      if (error?.type === ERROR_TYPES.NETWORK && error?.statusCode === 400) {
        break;
      }
      throw error;
    }

    const data = parseJsonOrThrowTyped(text, `anabuki arena REST API page=${page}`);
    if (!data.length) break;
    allPosts.push(...data);
  }
  return allPosts;
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
  const events = await mapWithConcurrencyLimit(posts, CONCURRENCY, async (post) => {
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
      const html = await fetchText(sourceUrl).catch(() => null);
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
  });

  console.log(`\n[Summary]`);
  console.log(`- API Total: ${posts.length}`);
  console.log(`- Refined from HTML: ${summary.refined}`);
  console.log(`- Output Events: ${validEvents.length}`);
  console.log(`[OK] Saved to: ${OUTPUT_PATH}`);
}

if (require.main === module) {
  main().catch(err => {
    handleCliFatalError(err, { prefix: "[ERROR]" });
  });
}
