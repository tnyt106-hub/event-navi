#!/usr/bin/env node
"use strict";

const path = require("path");
const { URL } = require("url");

// 共通モジュールの読み込み
const { fetchText } = require("../lib/http");
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { handleCliFatalError } = require("../lib/cli_error");
const { stripTagsCompact, normalizeDecodedText, decodeHtmlEntities } = require("../lib/text");
const {
  normalizeJapaneseDateText,
  getJstTodayUtcDate,
  buildUtcDate,
  formatIsoDateFromUtcDate,
} = require("../lib/date");

const EXHIBITION_URL = "https://www.ehime-art.jp/exhibition/";
const EVENT_LIST_URL_CANDIDATES = ["https://www.ehime-art.jp/event", "https://www.ehime-art.jp/event/"];
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", "ehime_prefectural_museum_of_art.json");
const VENUE_ID = "ehime_prefectural_museum_of_art";
const VENUE_NAME = "愛媛県美術館";

// パフォーマンス向上のため並列数を調整
const CONCURRENCY = 5;
// 終了日が「今日から365日より前」のイベントを除外するための基準日数。
const PAST_DAYS_LIMIT = 365;

// 正規表現のプリコンパイル（展覧会ページ用）
const REGEX_BLOCK = /<(?:section|li) class="exhibition-(?:lg-box|simple-item|item)"[^>]*>([\s\S]*?)<\/(?:section|li)>/gi;
const REGEX_TITLE = /<h[34][^>]*>([\s\S]*?)<\/h[34]>/i;
const REGEX_LINK = /<a[^>]*href="([^"]+)"/i;
const REGEX_DATE = /<p class="(?:post-term|exhibition-simple-item__date)">([\s\S]*?)<\/p>/i;
const REGEX_TIME_DL = /開館時間<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i;
const REGEX_HALL_DL = /会場<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i;
const REGEX_PRICE_DL = /料金<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i;
const REGEX_TIME_RANGE = /(\d{1,2}:\d{2})[～~](\d{1,2}:\d{2})/;
// 「一般」の後に空白や&nbsp;、改行があっても次の<td>を狙い撃つ
const REGEX_GENERAL_PRICE = /<th[^>]*>一般<\/th>[\s\S]*?<td[^>]*>\s*([^<]+?)\s*<\/td>/i;

/**
 * 連続する空白、改行、タブを1つの半角スペースに整理
 */
function cleanWhitespace(text) {
  if (!text) return "";
  return text.replace(/\s+/g, " ").replace(/&nbsp;/g, "").trim();
}

/**
 * 日本語の日付文字列からISO形式を生成
 */
function robustParseDate(dateStr) {
  if (!dateStr) return null;
  const base = dateStr.replace(/[（(][^）)]*[）)]/g, "").replace(/\s+/g, "");
  const match = base.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/);
  if (match) {
    const utc = buildUtcDate(parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10));
    return utc ? formatIsoDateFromUtcDate(utc) : null;
  }
  return null;
}

/**
 * 展覧会ページの期間テキストを開始日・終了日に分解する。
 *
 * なぜ専用関数にするか:
 * - これまで `-` で単純 split していたため、`2025-01-01` のような
 *   日付表記自体のハイフンで誤分割される可能性があった。
 * - 期間区切りとして使われる記号（~ / ～ / 〜）だけを優先して分割することで、
 *   誤判定を防ぐ。
 */
function extractExhibitionDateRange(dateText) {
  const cleaned = cleanWhitespace(dateText);

  // 期間区切りの代表記号のみを優先して分割する。
  const rangeParts = cleaned.split(/\s*[~～〜]\s*/);
  const dateFrom = robustParseDate(rangeParts[0]);
  if (!dateFrom) return null;

  // 終了日がない（または解析失敗）場合は開始日と同日にそろえる。
  const parsedDateTo = rangeParts.length > 1 ? robustParseDate(rangeParts[1]) : null;
  return {
    dateFrom,
    dateTo: parsedDateTo || dateFrom,
  };
}

/**
 * 日付テキストを正規化して YYYY年M月D日 の抽出精度を上げる。
 */
function normalizeDateText(text) {
  return normalizeJapaneseDateText(text, { removeParenthesizedText: true });
}

/**
 * 一覧ページの日付文から開始日・終了日を抽出する。
 * 複数日付が含まれる場合は最小日付を開始日、最大日付を終了日にする。
 */
function extractDateRangeFromListText(text) {
  const normalized = normalizeDateText(text);
  const regex = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  const dates = [];

  let match = regex.exec(normalized);
  while (match) {
    const date = buildUtcDate(Number(match[1]), Number(match[2]), Number(match[3]));
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

  return {
    dateFrom: formatIsoDateFromUtcDate(minDate),
    dateTo: formatIsoDateFromUtcDate(maxDate),
  };
}

/**
 * しきい値日付を作る（JST基準）。
 */
function buildPastThresholdUtc() {
  const todayJst = getJstTodayUtcDate();
  const threshold = new Date(todayJst.getTime());
  threshold.setUTCDate(threshold.getUTCDate() - PAST_DAYS_LIMIT);
  return threshold;
}

/**
 * イベントを一意に判定するキーを作る。
 */
function buildEventKey(eventItem) {
  return `${eventItem.title}__${eventItem.date_from}__${eventItem.date_to}`;
}

/**
 * 詳細ページURLかどうかを判定する。
 */
function isDetailUrl(url) {
  if (!url) return false;
  return url.includes("/event/info/") || url.includes("/exhibition/detail/");
}

/**
 * 展覧会詳細ページから時間・会場・料金を抽出
 */
async function enrichEventDetail(item) {
  try {
    const html = await fetchText(item.source_url);
    const cleanHtml = decodeHtmlEntities(html);

    // 1. 開館時間の抽出
    const timeMatch = REGEX_TIME_DL.exec(cleanHtml);
    if (timeMatch) {
      const timeText = cleanWhitespace(stripTagsCompact(timeMatch[1]));
      const rangeMatch = REGEX_TIME_RANGE.exec(timeText);
      if (rangeMatch) {
        item.start_time = rangeMatch[1].padStart(5, "0");
        item.end_time = rangeMatch[2].padStart(5, "0");
      }
      item.body += `\n開館時間: ${timeText}`;
    }

    // 2. 会場の抽出（具体的な展示室名）
    const hallMatch = REGEX_HALL_DL.exec(cleanHtml);
    if (hallMatch) {
      const hallName = cleanWhitespace(stripTagsCompact(hallMatch[1]));
      item.venue_name = `${VENUE_NAME} ${hallName}`;
    }

    // 3. 料金の抽出
    const priceMatch = REGEX_PRICE_DL.exec(cleanHtml);
    if (priceMatch) {
      const priceHtml = priceMatch[1];
      const priceText = cleanWhitespace(stripTagsCompact(priceHtml));

      const generalMatch = REGEX_GENERAL_PRICE.exec(priceHtml);
      const detectedPrice = generalMatch ? cleanWhitespace(generalMatch[1]) : null;

      if (detectedPrice && /\d/.test(detectedPrice)) {
        // 数字が含まれていればその金額（340円など）を採用
        item.price = detectedPrice;
      } else if (/^無料$|観覧料：?無料/.test(priceText) || (detectedPrice && /無料/.test(detectedPrice))) {
        // 明確に無料と判断できる場合
        item.price = "無料";
      } else {
        // 特定できない場合は null（誤った無料判定を避ける）
        item.price = null;
      }

      item.body += `\n料金詳細: ${priceText}`;
    } else {
      item.price = null;
    }

    return item;
  } catch (err) {
    console.error(`[WARN] 詳細取得失敗: ${item.source_url}`);
    return item;
  }
}

/**
 * 展覧会ページ(/exhibition/)からイベントを抽出し、詳細ページで補完する。
 */
async function fetchExhibitionEvents() {
  const html = await fetchText(EXHIBITION_URL);
  const initialItems = [];

  // /g フラグ付き正規表現は lastIndex を持つため、毎回明示的にリセットする。
  // 将来この関数を複数回呼ぶ形に変わっても安全にするための防御策。
  REGEX_BLOCK.lastIndex = 0;

  // 一覧から各展覧会のブロックを抽出
  let match;
  while ((match = REGEX_BLOCK.exec(html)) !== null) {
    const content = match[1];
    const titleMatch = REGEX_TITLE.exec(content);
    const linkMatch = REGEX_LINK.exec(content);
    const dateMatch = REGEX_DATE.exec(content);

    if (titleMatch && linkMatch) {
      initialItems.push({
        title: cleanWhitespace(normalizeDecodedText(stripTagsCompact(titleMatch[1]))),
        url: new URL(linkMatch[1], EXHIBITION_URL).href,
        dateText: cleanWhitespace(stripTagsCompact(dateMatch ? dateMatch[1] : "")),
      });
    }
  }

  // 日付パースと重複排除
  const preparedEvents = [];
  const seenUrls = new Set();
  for (const item of initialItems) {
    if (seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);

    const dateRange = extractExhibitionDateRange(item.dateText);
    if (!dateRange) continue;

    preparedEvents.push({
      title: item.title,
      date_from: dateRange.dateFrom,
      date_to: dateRange.dateTo,
      source_url: item.url,
      venue_name: VENUE_NAME,
      source_type: "web",
      body: `期間原文: ${item.dateText}`,
      price: null,
    });
  }

  // 詳細情報をチャンクごとに並列取得
  const finalEvents = [];
  for (let i = 0; i < preparedEvents.length; i += CONCURRENCY) {
    const chunk = preparedEvents.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map((ev) => enrichEventDetail(ev)));
    finalEvents.push(...results);
  }

  return finalEvents;
}

/**
 * イベント一覧(/event)のHTMLを、候補URLを順に試して取得する。
 */
async function fetchEventListHtmlWithFallback() {
  const envUrl = process.env.EHIME_ART_EVENT_URL;
  const candidates = envUrl ? [envUrl, ...EVENT_LIST_URL_CANDIDATES] : EVENT_LIST_URL_CANDIDATES;
  const tried = [];

  for (const url of candidates) {
    try {
      const html = await fetchText(url, {
        acceptEncoding: "identity",
        encoding: "utf-8",
      });
      return { html, listUrl: url };
    } catch (error) {
      tried.push(`${url}: ${error.message}`);
    }
  }

  throw new Error(`一覧ページの取得に失敗しました。 tried=${tried.join(" | ")}`);
}

/**
 * イベント一覧(/event)から event-item を抽出する。
 */
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

/**
 * ブロック内の href を絶対URLに変換する。
 */
function extractHrefFromBlock(blockHtml, baseUrl) {
  const hrefMatch = blockHtml.match(/href=["']([^"']+)["']/i);
  if (!hrefMatch) return "";
  try {
    return new URL(hrefMatch[1], baseUrl).toString();
  } catch (_error) {
    return "";
  }
}

/**
 * event-item ブロックからタイトルを抽出する。
 */
function extractTitleFromBlock(blockHtml) {
  const titleMatch = blockHtml.match(/<h2[^>]*class=["'][^"']*event-item__title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
  if (!titleMatch) return "";
  return normalizeDecodedText(stripTagsCompact(titleMatch[1]));
}

/**
 * HTML内の改行タグをスペース化しつつテキスト抽出する。
 */
function htmlToText(html) {
  if (!html) return "";
  const withBreaks = html.replace(/<br\s*\/?\s*>/gi, " ");
  return normalizeDecodedText(stripTagsCompact(withBreaks));
}

/**
 * event-item ブロックから日付文字列を抽出する。
 */
function extractDateTextFromBlock(blockHtml) {
  const dateMatch = blockHtml.match(/<p[^>]*class=["'][^"']*post-term[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
  if (!dateMatch) return "";
  return htmlToText(dateMatch[1]);
}

/**
 * イベント一覧(/event)からイベントを抽出し、古すぎるデータを除外する。
 */
async function fetchListEvents() {
  const fetched = await fetchEventListHtmlWithFallback();
  const listHtml = fetched.html;
  const listUrl = fetched.listUrl;
  console.log(`used_list_url: ${listUrl}`);

  const eventBlocks = extractEventBlocks(listHtml);
  console.log(`found_event_blocks: ${eventBlocks.length}`);

  let excludedInvalidCount = 0;
  const listEvents = [];
  const seenKeys = new Set();

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

    const eventItem = {
      title,
      date_from: dateRange.dateFrom,
      date_to: dateRange.dateTo,
      source_url: sourceUrl,
      venue_name: VENUE_NAME,
      source_type: "web",
      body: `期間原文: ${dateText}`,
    };

    // 一覧内に同一イベントが重複掲載されるケースに備え、ここで重複除去する。
    const dedupeKey = buildEventKey(eventItem);
    if (seenKeys.has(dedupeKey)) {
      continue;
    }
    seenKeys.add(dedupeKey);
    listEvents.push(eventItem);
  }

  if (listEvents.length === 0) {
    throw new Error("イベント一覧(/event)から有効データを抽出できませんでした。");
  }

  const threshold = buildPastThresholdUtc();
  let filteredOldCount = 0;
  const filteredEvents = listEvents.filter((eventItem) => {
    if (!eventItem.date_to) return true;

    const [year, month, day] = eventItem.date_to.split("-").map(Number);
    const dateTo = buildUtcDate(year, month, day);
    if (!dateTo) return false;

    if (dateTo < threshold) {
      filteredOldCount += 1;
      return false;
    }

    return true;
  });

  console.log(`extracted_event_items: ${listEvents.length}`);
  console.log(`filtered_old_count: ${filteredOldCount}`);
  console.log(`excluded_invalid_count: ${excludedInvalidCount}`);

  return filteredEvents;
}

/**
 * 2系統のイベント配列を統合する。
 * 同一キー(title/date_from/date_to)なら、詳細URLを優先して source_url を採用する。
 */
function mergeEvents(exhibitionEvents, listEvents) {
  const mergedMap = new Map();

  for (const eventItem of exhibitionEvents) {
    if (!eventItem || !eventItem.title) continue;
    mergedMap.set(buildEventKey(eventItem), { ...eventItem });
  }

  for (const eventItem of listEvents) {
    if (!eventItem || !eventItem.title) continue;
    const key = buildEventKey(eventItem);
    const current = mergedMap.get(key);

    if (!current) {
      mergedMap.set(key, { ...eventItem });
      continue;
    }

    const currentUrl = current.source_url || "";
    const newUrl = eventItem.source_url || "";
    const preferredUrl = isDetailUrl(newUrl) && !isDetailUrl(currentUrl) ? newUrl : currentUrl;

    // 既存（展覧会側）の詳細情報は維持しつつ、URLだけ優先ロジックで上書きする。
    mergedMap.set(key, { ...current, source_url: preferredUrl });
  }

  return Array.from(mergedMap.values());
}

async function main() {
  console.log(`[START] ${VENUE_NAME} の更新を開始します...`);
  console.time("Performance");

  try {
    // 1) 展覧会ページのイベントを収集（詳細情報あり）
    const exhibitionEvents = await fetchExhibitionEvents();
    console.log(`exhibition_events: ${exhibitionEvents.length}`);

    // 2) イベント一覧ページのイベントを収集
    const listEvents = await fetchListEvents();
    console.log(`list_events: ${listEvents.length}`);

    // 3) 2系統を統合して1つのJSONに保存
    const mergedEvents = mergeEvents(exhibitionEvents, listEvents);

    finalizeAndSaveEvents({
      venueId: VENUE_ID,
      venueName: VENUE_NAME,
      outputPath: OUTPUT_PATH,
      events: mergedEvents,
      requireDateFrom: true,
    });

    console.log(`[FINISH] 更新完了: ${mergedEvents.length}件`);
    console.timeEnd("Performance");
  } catch (error) {
    handleCliFatalError(error, { prefix: `[${VENUE_ID} Fatal]` });
  }
}

main();
