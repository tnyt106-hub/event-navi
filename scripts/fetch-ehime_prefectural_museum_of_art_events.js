// 愛媛県美術館のイベント一覧ページだけを使って、
// 一覧内のタイトル・日付・詳細URLを抽出して既存の展覧会JSONへ統合するバッチ。
// 使い方: node scripts/fetch-ehime_prefectural_museum_of_art_events.js

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");

const LIST_URL = "https://www.ehime-art.jp/event";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "ehime_prefectural_museum_of_art.json");
const VENUE_ID = "ehime_prefectural_museum_of_art";
const VENUE_NAME = "愛媛県美術館";
const PAST_DAYS_LIMIT = 120;

// HTML を取得する。HTTPエラーや明らかなエラーページはハード失敗とする。
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; event-navi-bot/1.0)",
          Accept: "text/html,application/xhtml+xml",
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} で失敗しました。`));
          response.resume();
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (!body) {
            reject(new Error("HTMLの取得結果が空でした。"));
            return;
          }

          const errorIndicators = ["Access Denied", "Forbidden", "Service Unavailable"];
          if (errorIndicators.some((indicator) => body.includes(indicator))) {
            reject(new Error("明らかなエラーページの可能性があります。"));
            return;
          }

          resolve(body);
        });
      }
    );

    request.on("error", (error) => {
      reject(error);
    });
  });
}

// HTMLエンティティを最低限デコードする。
function decodeHtmlEntities(text) {
  if (!text) return "";
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

// タグを落としてプレーンテキスト化する。
function stripTags(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "");
}

// テキストの空白を整える。
function normalizeText(text) {
  return decodeHtmlEntities(text).replace(/\s+/g, " ").trim();
}

// HTML内の改行タグをスペースに置き換えてテキスト化する。
function htmlToText(html) {
  if (!html) return "";
  const withBreaks = html.replace(/<br\s*\/?\s*>/gi, " ");
  return normalizeText(stripTags(withBreaks));
}

// 全角数字を半角に変換し、不要な括弧注記などを除去する。
function normalizeDateText(text) {
  if (!text) return "";
  const halfWidth = text.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  return halfWidth
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/[／]/g, "/")
    .replace(/[．]/g, ".")
    .replace(/[〜～]/g, "~")
    .replace(/[－–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// YYYY-MM-DD 形式に整形する（UTCベース）。
function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// 年月日が妥当な日付かチェックする（UTCベース）。
function buildDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

// JST基準の現在日を Date (UTC) に揃える。
function buildJstTodayUtc() {
  const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(nowJst.getUTCFullYear(), nowJst.getUTCMonth(), nowJst.getUTCDate()));
}

// 過去120日フィルタの閾値を作る。
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
function extractHrefFromBlock(blockHtml) {
  const hrefMatch = blockHtml.match(/href=["']([^"']+)["']/i);
  if (!hrefMatch) return "";
  try {
    return new URL(hrefMatch[1], LIST_URL).toString();
  } catch (error) {
    return "";
  }
}

// event-item ブロック内のタイトルを抽出する。
function extractTitleFromBlock(blockHtml) {
  const titleMatch = blockHtml.match(/<h2[^>]*class=["'][^"']*event-item__title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
  if (!titleMatch) return "";
  return normalizeText(stripTags(titleMatch[1]));
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
    const parsed = JSON.parse(raw);
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
  try {
    listHtml = await fetchHtml(LIST_URL);
  } catch (error) {
    console.error("[ERROR] LIST_URL の取得に失敗しました。", error);
    process.exit(1);
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

    const sourceUrl = extractHrefFromBlock(blockHtml);
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
    console.error("[ERROR] extracted_event_items が 0 件のため中断します。");
    process.exit(1);
    return;
  }

  const threshold = buildPastThresholdUtc();
  let filteredOldCount = 0;
  const filteredEvents = eventEvents.filter((eventItem) => {
    const [year, month, day] = eventItem.date_to.split("-").map(Number);
    const dateTo = buildDate(year, month, day);
    if (!dateTo) {
      excludedInvalidCount += 1;
      return false;
    }
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
  const data = {
    venue_id: VENUE_ID,
    venue_name: VENUE_NAME,
    events: mergedEvents,
  };

  applyTagsToEventsData(data, { overwrite: false });

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2));
  console.log(`merged_total_count: ${data.events.length}`);

  const previewItems = data.events.slice(0, 2);
  if (previewItems.length > 0) {
    console.log("preview:");
    previewItems.forEach((item, index) => {
      console.log(
        `  [${index + 1}] title="${item.title}" date="${item.date_from}~${item.date_to}" source_url="${item.source_url}"`
      );
    });
  }
}

main();
