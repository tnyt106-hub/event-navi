// 愛媛県美術館のイベント一覧ページだけを使って、
// 一覧内のタイトル・日付・詳細URLを抽出して既存の展覧会JSONへ統合するバッチ。
// 使い方: node scripts/fetch-ehime_prefectural_museum_of_art_events.js

"use strict";

const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("./lib/http");
// JSON 保存処理を共通化する。
const { finalizeAndSaveEvents } = require("./lib/fetch_output");
const { parseJsonOrThrowTyped } = require("./lib/json");
const { handleCliFatalError } = require("./lib/cli_error");
// HTML テキスト処理の共通関数を使う。
const { stripTagsCompact, normalizeDecodedText } = require("./lib/text");
const {
  normalizeJapaneseDateText,
  buildUtcDate,
  formatIsoDateFromUtcDate,
  getJstTodayUtcDate,
} = require("./lib/date");

// 一覧ページURLは運用側で末尾スラッシュ有無が切り替わることがあるため
// フォールバック候補を複数持つ。
const LIST_URL_CANDIDATES = [
  "https://www.ehime-art.jp/event",
  "https://www.ehime-art.jp/event/",
];
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "ehime_prefectural_museum_of_art.json");
const VENUE_ID = "ehime_prefectural_museum_of_art";
const VENUE_NAME = "愛媛県美術館";
// 終了日が「今日から365日より前」のイベントを除外するための基準日数。
const PAST_DAYS_LIMIT = 365;

// テキストの空白を整える。
function normalizeText(text) {
  // HTML エンティティのデコードと空白正規化は共通関数へ寄せる。
  return normalizeDecodedText(text);
}

// HTML内の改行タグをスペースに置き換えてテキスト化する。
function htmlToText(html) {
  if (!html) return "";
  const withBreaks = html.replace(/<br\s*\/?\s*>/gi, " ");
  return normalizeText(stripTagsCompact(withBreaks));
}

// 全角数字を半角に変換し、不要な括弧注記などを除去する。
function normalizeDateText(text) {
  // 一覧側のテキストは括弧内ノイズを除いてから日付抽出する。
  return normalizeJapaneseDateText(text, { removeParenthesizedText: true });
}

// YYYY-MM-DD 形式に整形する（UTCベース）。

function formatDate(date) {
  return formatIsoDateFromUtcDate(date);
}

// 年月日が妥当な日付かチェックする（UTCベース）。

function buildDate(year, month, day) {
  return buildUtcDate(year, month, day);
}

// JST基準の現在日を Date (UTC) に揃える。

function buildJstTodayUtc() {
  // JST基準日の算出は共通関数を利用して、他スクリプトと境界条件をそろえる。
  return getJstTodayUtcDate();
}

// 過去365日フィルタの閾値を作る（JST基準の日付で判定する）。
function buildPastThresholdUtc() {
  const todayJst = buildJstTodayUtc();
  const threshold = new Date(todayJst.getTime());
  threshold.setUTCDate(threshold.getUTCDate() - PAST_DAYS_LIMIT);
  return threshold;
}

// 一覧ページから event-item ブロックを抽出する。
function extractEventBlocks(listHtml) {
  const blocks = [];
  const regex = /<a\b[^>]*class=["'][^"']*event-item[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
  let match = regex.exec(listHtml);
  while (match) {
    blocks.push(match[0]);
    match = regex.exec(listHtml);
  }
  return blocks;
}

// ブロック内の href を絶対URLに変換する。
function extractHrefFromBlock(blockHtml, baseUrl) {
  const hrefMatch = blockHtml.match(/href=["']([^"']+)["']/i);
  if (!hrefMatch) return "";
  try {
    return new URL(hrefMatch[1], baseUrl).toString();
  } catch (error) {
    return "";
  }
}

// 候補URLを順に試し、最初に取得できたHTMLと採用URLを返す。
async function fetchListHtmlWithFallback() {
  // 取得元の切り替えに対応できるよう、環境変数でも上書き可能にする。
  const envUrl = process.env.EHIME_ART_EVENT_URL;
  const candidates = envUrl ? [envUrl, ...LIST_URL_CANDIDATES] : LIST_URL_CANDIDATES;
  const tried = [];

  for (const url of candidates) {
    try {
      const html = await fetchText(url, {
        acceptEncoding: "identity",
        encoding: "utf-8",
      });
      return { html, listUrl: url };
    } catch (error) {
      // どのURLで失敗したか把握できるようにログ文字列として保持しておく。
      tried.push(`${url}: ${error.message}`);
    }
  }

  throw new Error(`一覧ページの取得に失敗しました。 tried=${tried.join(" | ")}`);
}

// event-item ブロック内のタイトルを抽出する。
function extractTitleFromBlock(blockHtml) {
  const titleMatch = blockHtml.match(/<h2[^>]*class=["'][^"']*event-item__title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
  if (!titleMatch) return "";
  return normalizeText(stripTagsCompact(titleMatch[1]));
}

// event-item ブロック内の日付テキストを抽出する。
function extractDateTextFromBlock(blockHtml) {
  const dateMatch = blockHtml.match(/<p[^>]*class=["'][^"']*post-term[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
  if (!dateMatch) return "";
  return htmlToText(dateMatch[1]);
}

// YYYY年M月D日 をすべて拾い、最小・最大日付を開始日・終了日にする。
function extractDateRangeFromListText(text) {
  const normalized = normalizeDateText(text);
  const regex = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  const dates = [];
  let match = regex.exec(normalized);
  while (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = buildDate(year, month, day);
    if (!date) return null;
    dates.push(date);
    match = regex.exec(normalized);
  }

  if (dates.length === 0) return null;

  let minDate = dates[0];
  let maxDate = dates[0];
  for (const date of dates) {
    if (date < minDate) minDate = date;
    if (date > maxDate) maxDate = date;
  }

  if (maxDate < minDate) return null;

  return {
    dateFrom: formatDate(minDate),
    dateTo: formatDate(maxDate),
    startDate: minDate,
    endDate: maxDate,
  };
}

// 既存JSONを読み込み、無ければ空として扱う。
function loadExistingEvents() {
  if (!fs.existsSync(OUTPUT_PATH)) {
    return { venue_id: VENUE_ID, venue_name: VENUE_NAME, events: [] };
  }

  try {
    const raw = fs.readFileSync(OUTPUT_PATH, "utf8");
    const parsed = parseJsonOrThrowTyped(raw, `existing data (${OUTPUT_PATH})`);
    const events = Array.isArray(parsed.events) ? parsed.events : [];
    return {
      venue_id: VENUE_ID,
      venue_name: VENUE_NAME,
      events,
    };
  } catch (error) {
    console.warn("[WARN] 既存JSONの読み込みに失敗したため空として扱います。", error);
    return { venue_id: VENUE_ID, venue_name: VENUE_NAME, events: [] };
  }
}

// 重複判定キーを作る。
function buildEventKey(eventItem) {
  return `${eventItem.title}__${eventItem.date_from}__${eventItem.date_to}`;
}

// 詳細ページURLかどうかを判定する。
function isDetailUrl(url) {
  if (!url) return false;
  return url.includes("/event/info/") || url.includes("/exhibition/detail/");
}

// 既存・新規イベントを統合し、詳細URLを優先する。
function mergeEvents(existingEvents, newEvents) {
  const mergedMap = new Map();

  for (const eventItem of existingEvents) {
    if (!eventItem || !eventItem.title) continue;
    mergedMap.set(buildEventKey(eventItem), { ...eventItem });
  }

  for (const eventItem of newEvents) {
    if (!eventItem || !eventItem.title) continue;
    const key = buildEventKey(eventItem);
    const current = mergedMap.get(key);

    if (!current) {
      mergedMap.set(key, { ...eventItem });
      continue;
    }

    const currentUrl = current.source_url || "";
    const newUrl = eventItem.source_url || "";
    let preferredUrl = currentUrl;

    if (isDetailUrl(newUrl) && !isDetailUrl(currentUrl)) {
      preferredUrl = newUrl;
    }

    mergedMap.set(key, { ...current, source_url: preferredUrl });
  }

  return Array.from(mergedMap.values());
}

async function main() {
  let listHtml;
  let listUrl;
  try {
    const fetched = await fetchListHtmlWithFallback();
    listHtml = fetched.html;
    listUrl = fetched.listUrl;
    console.log(`used_list_url: ${listUrl}`);
  } catch (error) {
    handleCliFatalError(error, { prefix: "[ERROR] LIST_URL の取得に失敗しました。" });
    return;
  }

  const eventBlocks = extractEventBlocks(listHtml);
  console.log(`found_event_blocks: ${eventBlocks.length}`);

  let excludedInvalidCount = 0;
  const eventEvents = [];

  for (const blockHtml of eventBlocks) {
    const title = extractTitleFromBlock(blockHtml);
    if (!title) {
      excludedInvalidCount += 1;
      continue;
    }

    const dateText = extractDateTextFromBlock(blockHtml);
    const dateRange = extractDateRangeFromListText(dateText);
    if (!dateRange) {
      excludedInvalidCount += 1;
      continue;
    }

    const sourceUrl = extractHrefFromBlock(blockHtml, listUrl);
    if (!sourceUrl) {
      excludedInvalidCount += 1;
      continue;
    }

    eventEvents.push({
      title,
      date_from: dateRange.dateFrom,
      date_to: dateRange.dateTo,
      source_url: sourceUrl,
    });
  }

  const extractedCount = eventEvents.length;
  console.log(`extracted_event_items: ${extractedCount}`);

  if (extractedCount === 0) {
    handleCliFatalError(new Error("extracted_event_items が 0 件のため中断します。"), { prefix: "[ERROR]" });
    return;
  }

  const threshold = buildPastThresholdUtc();
  let filteredOldCount = 0;
  const filteredEvents = eventEvents.filter((eventItem) => {
    // 終了日が取れていないイベントは、既存ロジックに委ねて残す。
    if (!eventItem.date_to) return true;

    const [year, month, day] = eventItem.date_to.split("-").map(Number);
    const dateTo = buildDate(year, month, day);
    if (!dateTo) {
      return false;
    }
    // 終了日が「今日 - 365日」より古ければ除外する。
    if (dateTo < threshold) {
      filteredOldCount += 1;
      return false;
    }
    return true;
  });

  console.log(`filtered_old_count: ${filteredOldCount}`);
  console.log(`excluded_invalid_count: ${excludedInvalidCount}`);

  const existingData = loadExistingEvents();
  const mergedEvents = mergeEvents(existingData.events || [], filteredEvents);
  finalizeAndSaveEvents({
    venueId: VENUE_ID,
    venueName: VENUE_NAME,
    outputPath: OUTPUT_PATH,
    events: mergedEvents,
  });

  const previewItems = mergedEvents.slice(0, 2);
  if (previewItems.length > 0) {
    console.log("preview:");
    previewItems.forEach((item, index) => {
      console.log(
        `  [${index + 1}] title="${item.title}" date="${item.date_from}~${item.date_to}" source_url="${item.source_url}"`
      );
    });
  }
}

if (require.main === module) {
  main();
}
