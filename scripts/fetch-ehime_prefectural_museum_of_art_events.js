// 愛媛県美術館のイベント一覧ページから詳細URLを収集し、
// 詳細ページの開催日とタイトルを抽出して既存の展覧会JSONへ統合するバッチ。
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

// 一覧ページから /event/info/ を含む詳細URLを抽出する。
function extractDetailUrls(listHtml) {
  const urls = new Set();
  const regex = /href=["']([^"']*\/event\/info\/[^"']*)["']/gi;
  let match = regex.exec(listHtml);
  while (match) {
    const href = match[1].trim();
    try {
      const absoluteUrl = new URL(href, LIST_URL).toString();
      urls.add(absoluteUrl);
    } catch (error) {
      // 無効なURLは安全側で無視する。
    }
    match = regex.exec(listHtml);
  }
  return Array.from(urls);
}

// HTML内からメイン見出しを優先してタイトルを抽出する。
function extractTitleFromHtml(html) {
  const headingTags = ["h1", "h2"];
  for (const tag of headingTags) {
    const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (match) {
      const heading = normalizeText(stripTags(match[1]));
      if (heading) return heading;
    }
  }

  const ogTitle = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  if (ogTitle) {
    const title = normalizeText(ogTitle[1]);
    if (title) return title;
  }

  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag) {
    const title = normalizeText(stripTags(titleTag[1]));
    if (title) return title;
  }

  return "";
}

// テキストから YYYY年M月D日 (年省略を許容) を順番に抽出する。
function extractDateTokens(text) {
  const normalized = normalizeDateText(text);
  const tokens = [];
  const regex = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  let match = regex.exec(normalized);
  while (match) {
    const year = match[1] ? Number(match[1]) : null;
    const month = Number(match[2]);
    const day = Number(match[3]);
    tokens.push({ year, month, day });
    match = regex.exec(normalized);
  }
  return tokens;
}

// 抽出した日付トークンから Date 配列を生成する。
function resolveDateTokens(tokens) {
  if (!tokens || tokens.length === 0) return null;
  const baseToken = tokens.find((token) => token.year);
  if (!baseToken || !baseToken.year) return null;

  const baseYear = baseToken.year;
  let startDate = null;
  const dates = [];

  for (const token of tokens) {
    let year = token.year || baseYear;
    let date = buildDate(year, token.month, token.day);
    if (!date) return null;

    if (!token.year && startDate && date < startDate) {
      year += 1;
      date = buildDate(year, token.month, token.day);
      if (!date) return null;
    }

    if (!startDate) startDate = date;
    dates.push(date);
  }

  return dates;
}

// ページ内の日付情報をまとめて開始日・終了日に変換する。
function extractDateRangeFromText(text) {
  const tokens = extractDateTokens(text);
  const dates = resolveDateTokens(tokens);
  if (!dates || dates.length === 0) return null;

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

  const detailUrls = extractDetailUrls(listHtml);
  console.log(`list_url_count: ${detailUrls.length}`);

  let detailFetchSuccess = 0;
  let detailFetchFailed = 0;
  let excludedInvalidCount = 0;

  const eventEvents = [];

  for (const detailUrl of detailUrls) {
    let detailHtml;
    try {
      detailHtml = await fetchHtml(detailUrl);
      detailFetchSuccess += 1;
    } catch (error) {
      detailFetchFailed += 1;
      console.warn(`[WARN] detail_fetch_failed: ${detailUrl}`, error);
      continue;
    }

    const title = extractTitleFromHtml(detailHtml);
    const textContent = htmlToText(detailHtml);
    const dateRange = extractDateRangeFromText(textContent);

    if (!title || !dateRange) {
      excludedInvalidCount += 1;
      continue;
    }

    if (dateRange.endDate < dateRange.startDate) {
      excludedInvalidCount += 1;
      continue;
    }

    eventEvents.push({
      title,
      date_from: dateRange.dateFrom,
      date_to: dateRange.dateTo,
      source_url: detailUrl,
    });
  }

  console.log(`detail_fetch_success: ${detailFetchSuccess}`);
  console.log(`detail_fetch_failed: ${detailFetchFailed}`);

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

  if (detailFetchFailed > 0) {
    console.warn(`[WARN] detail_fetch_failed が ${detailFetchFailed} 件ありました。`);
  }

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
}

main();
