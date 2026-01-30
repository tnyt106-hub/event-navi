// 丸亀市猪熊弦一郎現代美術館 (MIMOCA) の展覧会/イベントを取得し、
// docs/events/mimoca.json に統合保存するスクリプト。
// 使い方: node scripts/fetch-mimoca.js

const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const EXHIBITIONS_LIST_URL = "https://www.mimoca.jp/exhibitions/current/";
const EVENTS_LIST_URL = "https://www.mimoca.jp/events/";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "mimoca.json");
const VENUE_ID = "mimoca";
const JST_OFFSET_HOURS = 9;
const PAST_DAYS_LIMIT = 120;

// HTML を取得する。HTTP エラーは失敗として扱う。
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; event-navi-bot/1.0)",
          Accept: "text/html,application/xhtml+xml",
          // 圧縮レスポンスだと utf8 連結が壊れるため、明示的に無圧縮を要求する。
          "Accept-Encoding": "identity",
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} で失敗しました。`));
          response.resume();
          return;
        }

        // デバッグ用にレスポンスヘッダを短く記録する。
        console.log(
          `[fetchHtml] content-encoding: ${response.headers["content-encoding"] || "none"}, content-type: ${
            response.headers["content-type"] || "unknown"
          }`
        );

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (!body) {
            reject(new Error("HTML の取得結果が空でした。"));
            return;
          }
          // デバッグ用に body の先頭 200 文字を 1 行で記録する。
          const bodySnippet = body.replace(/\s+/g, " ").slice(0, 200);
          console.log(`[fetchHtml] body_head: ${bodySnippet}`);
          resolve(body);
        });
      }
    );

    request.on("error", (error) => {
      reject(error);
    });
  });
}

// HTML エンティティを最低限デコードする。
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
  return html.replace(/<[^>]*>/g, " ");
}

// 余分な空白を削除する。
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

// 全角数字を半角に変換する。
function normalizeNumbers(text) {
  return text.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

// YYYY-MM-DD 文字列を返す。
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// 年月日が妥当な日付かチェックする。
function buildDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

// JST の日付文字列 (YYYY-MM-DD) を返す。
function buildJstDateString() {
  const now = new Date();
  const jstNow = new Date(now.getTime() + JST_OFFSET_HOURS * 60 * 60 * 1000);
  const year = jstNow.getUTCFullYear();
  const month = String(jstNow.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jstNow.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// 過去フィルタのしきい値を JST で作る。
function buildPastThresholdJst() {
  const now = new Date();
  const jstNow = new Date(now.getTime() + JST_OFFSET_HOURS * 60 * 60 * 1000);
  const threshold = new Date(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate());
  threshold.setDate(threshold.getDate() - PAST_DAYS_LIMIT);
  return threshold;
}

// URL を絶対 URL に変換する。
function toAbsoluteUrl(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString();
  } catch (error) {
    return "";
  }
}

// 一覧 HTML から href を抽出する。
function extractHrefList(html) {
  const links = [];
  const regex = /href=["']([^"']+)["']/gi;
  let match = null;
  while ((match = regex.exec(html)) !== null) {
    links.push(match[1]);
  }
  return links;
}

// 展覧会一覧の詳細 URL を抽出する。
function extractExhibitionDetailUrls(html) {
  const hrefs = extractHrefList(html);
  const result = new Set();

  hrefs.forEach((href) => {
    if (!href.startsWith("/exhibitions/")) return;
    const cleaned = href.replace(/[#?].*$/, "");
    if (/^\/exhibitions\/(current|upcoming|past)\/?$/.test(cleaned)) return;
    if (/^\/exhibitions\/20\d{2}\/?$/.test(cleaned)) return;
    if (!/^\/exhibitions\/[^/]+\/?$/.test(cleaned)) return;

    result.add(toAbsoluteUrl(EXHIBITIONS_LIST_URL, cleaned));
  });

  return { urls: Array.from(result), totalHrefCount: hrefs.length };
}

// イベント一覧の詳細 URL を抽出する。
function extractEventDetailUrls(html) {
  const hrefs = extractHrefList(html);
  const result = new Set();

  hrefs.forEach((href) => {
    if (!href.startsWith("/events/")) return;
    const cleaned = href.replace(/[#?].*$/, "");
    if (/^\/events\/?$/.test(cleaned)) return;
    if (/^\/events\/\d{4}\/?$/.test(cleaned)) return;
    if (!/^\/events\/[^/]+\/?$/.test(cleaned)) return;

    result.add(toAbsoluteUrl(EVENTS_LIST_URL, cleaned));
  });

  return { urls: Array.from(result), totalHrefCount: hrefs.length };
}

// 詳細ページの代表見出しからタイトルを抽出する。
function extractTitle(html) {
  const headingRegex = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  let mainTitle = "";
  let match = null;
  while ((match = headingRegex.exec(html)) !== null) {
    const text = normalizeWhitespace(decodeHtmlEntities(stripTags(match[1])));
    if (text) {
      mainTitle = text;
      break;
    }
  }

  if (!mainTitle) return "";

  // サブタイトルらしき要素を追加する。
  const subtitleMatch = html.match(
    /<h[2-3][^>]*(class=["'][^"']*(sub|subtitle)[^"']*["'])[^>]*>([\s\S]*?)<\/h[2-3]>/i
  );
  if (subtitleMatch) {
    const subtitle = normalizeWhitespace(decodeHtmlEntities(stripTags(subtitleMatch[3])));
    if (subtitle && subtitle !== mainTitle) {
      return `${mainTitle} ${subtitle}`;
    }
  }

  return mainTitle;
}

// 詳細ページの本文から日付を抽出する。
function extractDateRange(html) {
  const text = normalizeNumbers(stripTags(html));
  const dates = [];

  for (const match of text.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = buildDate(year, month, day);
    if (date) {
      dates.push(date);
    }
  }

  if (dates.length === 0) return null;

  dates.sort((a, b) => a - b);
  return {
    dateFrom: formatDate(dates[0]),
    dateTo: formatDate(dates[dates.length - 1]),
  };
}

// 時刻レンジ (HH:MM-HH:MM) を抽出する。
function extractTimeRange(html) {
  const text = normalizeNumbers(stripTags(html));
  const normalized = text.replace(/[−―ー－〜～]/g, "-");
  const match = normalized.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  if (!match) return null;
  return {
    start: match[1],
    end: match[2],
  };
}

// 料金や連絡先らしき行を抽出する。
function extractLineByKeywords(html, keywords) {
  const text = decodeHtmlEntities(stripTags(html));
  const lines = text
    .split(/\n|\r/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line);

  for (const line of lines) {
    if (keywords.some((keyword) => line.includes(keyword))) {
      return line;
    }
  }

  return "";
}

// 詳細ページからイベント情報を組み立てる。
function buildEventFromDetail(detailUrl, html) {
  const title = extractTitle(html);
  if (!title) return null;

  const dateRange = extractDateRange(html);
  if (!dateRange) return null;

  const eventItem = {
    title,
    date_from: dateRange.dateFrom,
    date_to: dateRange.dateTo,
    source_url: detailUrl,
  };

  const timeRange = extractTimeRange(html);
  if (timeRange) {
    eventItem.open_time = timeRange.start;
    eventItem.start_time = null;
    eventItem.end_time = timeRange.end;
  }

  const priceLine = extractLineByKeywords(html, ["料金", "観覧料", "入館料"]);
  if (priceLine) {
    eventItem.price = priceLine;
  }

  const contactLine = extractLineByKeywords(html, ["お問い合わせ", "TEL", "電話"]);
  if (contactLine) {
    eventItem.contact = contactLine;
  }

  return eventItem;
}

// 既存 JSON を読み込む。
function loadExistingData() {
  if (!fs.existsSync(OUTPUT_PATH)) {
    return { venue_id: VENUE_ID, last_success_at: null, events: [] };
  }

  const raw = fs.readFileSync(OUTPUT_PATH, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return {
      venue_id: parsed.venue_id || VENUE_ID,
      last_success_at: parsed.last_success_at || null,
      events: Array.isArray(parsed.events) ? parsed.events : [],
    };
  } catch (error) {
    return { venue_id: VENUE_ID, last_success_at: null, events: [] };
  }
}

// 重複キー用の文字列を作る。
function buildEventKey(eventItem) {
  return `${eventItem.title}__${eventItem.date_from}__${eventItem.date_to}`;
}

// 既存イベントと新規イベントをマージする。
function mergeEvents(existingEvents, newEvents) {
  const merged = new Map();

  existingEvents.forEach((eventItem) => {
    merged.set(buildEventKey(eventItem), { ...eventItem });
  });

  newEvents.forEach((eventItem) => {
    const key = buildEventKey(eventItem);
    if (!merged.has(key)) {
      merged.set(key, { ...eventItem });
      return;
    }

    const existing = merged.get(key);
    const updated = { ...existing, ...eventItem };

    if (existing.tags && !eventItem.tags) {
      updated.tags = existing.tags;
    }

    merged.set(key, updated);
  });

  return Array.from(merged.values());
}

// 同一キーの重複を除去する。
function dedupeEvents(events) {
  const result = [];
  const seen = new Set();

  events.forEach((eventItem) => {
    const key = buildEventKey(eventItem);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(eventItem);
  });

  return result;
}

async function fetchDetails(urls, label) {
  const results = [];
  let successCount = 0;
  let failedCount = 0;
  let excludedInvalidCount = 0;

  for (const url of urls) {
    try {
      const html = await fetchHtml(url);
      const eventItem = buildEventFromDetail(url, html);
      if (!eventItem) {
        excludedInvalidCount += 1;
        continue;
      }

      results.push(eventItem);
      successCount += 1;
    } catch (error) {
      failedCount += 1;
    }
  }

  console.log(`${label}_detail_fetch_success: ${successCount}`);
  console.log(`${label}_detail_fetch_failed: ${failedCount}`);

  return { events: results, excludedInvalidCount };
}

async function main() {
  const existingData = loadExistingData();
  let excludedInvalidCount = 0;

  const exhibitionsHtml = await fetchHtml(EXHIBITIONS_LIST_URL);
  const exhibitionHrefResult = extractExhibitionDetailUrls(exhibitionsHtml);
  const exhibitionUrls = exhibitionHrefResult.urls;
  console.log(`exhibitions_list_href_total: ${exhibitionHrefResult.totalHrefCount}`);
  console.log(`exhibitions_list_links: ${exhibitionUrls.length}`);

  const exhibitionResult = await fetchDetails(exhibitionUrls, "exhibitions");
  const exhibitionEvents = exhibitionResult.events;
  excludedInvalidCount += exhibitionResult.excludedInvalidCount;

  const eventsHtml = await fetchHtml(EVENTS_LIST_URL);
  const eventHrefResult = extractEventDetailUrls(eventsHtml);
  const eventUrls = eventHrefResult.urls;
  console.log(`events_list_href_total: ${eventHrefResult.totalHrefCount}`);
  console.log(`events_list_links: ${eventUrls.length}`);

  const eventResult = await fetchDetails(eventUrls, "events");
  const eventEvents = eventResult.events;
  excludedInvalidCount += eventResult.excludedInvalidCount;

  const collectedEvents = dedupeEvents([...exhibitionEvents, ...eventEvents]);
  const threshold = buildPastThresholdJst();
  let filteredOldCount = 0;

  const filteredEvents = collectedEvents.filter((eventItem) => {
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

  const dedupedTotal = filteredEvents.length;
  console.log(`deduped_total: ${dedupedTotal}`);

  if (dedupedTotal === 0) {
    console.error("[ERROR] deduped_total が 0 件のため中断します。");
    process.exit(1);
    return;
  }

  const mergedEvents = mergeEvents(existingData.events || [], filteredEvents);
  const data = {
    venue_id: existingData.venue_id || VENUE_ID,
    last_success_at: buildJstDateString(),
    events: mergedEvents,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2));

  console.log(`merged_total: ${data.events.length}`);
}

main().catch((error) => {
  console.error("[ERROR] スクリプト実行中に失敗しました。", error);
  process.exit(1);
});
