// 愛媛県美術館の展覧会一覧ページから
// 開催中と直近過去の展覧会情報を抽出して JSON に保存するバッチ。
// 使い方: node scripts/fetch-ehime_prefectural_museum_of_art.js

"use strict";

const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");
// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("./lib/http");
// JSON 保存処理を共通化する。
const { finalizeAndSaveEvents } = require("./lib/fetch_output");
const { handleCliFatalError } = require("./lib/cli_error");
// HTML テキスト処理の共通関数を使う。
const { stripTagsCompact, normalizeDecodedText } = require("./lib/text");
const { buildPastCutoffDate, evaluateEventAgainstPastCutoff } = require("./lib/date_window");
const {
  normalizeJapaneseDateText,
  extractDatePartsFromJapaneseText,
  buildUtcDate,
  formatIsoDateFromUtcDate,
} = require("./lib/date");

const ENTRY_URL = "https://www.ehime-art.jp/exhibition/";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "ehime_prefectural_museum_of_art.json");
const VENUE_ID = "ehime_prefectural_museum_of_art";
const VENUE_NAME = "愛媛県美術館";

// テキストの空白を整える。
function normalizeText(text) {
  // HTML エンティティのデコードと空白正規化は共通関数へ寄せる。
  return normalizeDecodedText(text);
}

// 全角数字を半角に変換し、日付の区切り記号を正規化する。
function normalizeDateText(text) {
  // この施設は括弧内ノイズと「から/まで」の表記揺れを吸収して既存挙動を維持する。
  return normalizeJapaneseDateText(text, {
    removeParenthesizedText: true,
    replaceRangeWords: true,
  });
}

// YYYY-MM-DD 形式に整形する（UTCベース）。

function formatDate(date) {
  return formatIsoDateFromUtcDate(date);
}

// 年月日が妥当な日付かチェックする（UTCベース）。

function buildDate(year, month, day) {
  return buildUtcDate(year, month, day);
}

// 日付文字列から年月日の配列を抽出する。

function extractDateParts(text) {
  // 既存と同じく「年あり + 年なし(月日)」の順で取り出す。
  return extractDatePartsFromJapaneseText(normalizeDateText(text), {
    allowYearlessMonthDay: true,
  });
}

// 日付情報を正規化して開始日・終了日を返す。

function parseDateRange(text) {
  if (!text) return null;
  const normalized = normalizeDateText(text);
  const hasRangeSeparator = /[~\-]/.test(normalized);
  if (!hasRangeSeparator) return null;

  const dateParts = extractDateParts(normalized);
  if (dateParts.length < 2) return null;

  const startPart = dateParts[0];
  if (!startPart.year) {
    return null;
  }

  const startDate = buildDate(startPart.year, startPart.month, startPart.day);
  if (!startDate) return null;

  const endPart = dateParts[1];
  let endYear = endPart.year || startPart.year;
  let endDate = buildDate(endYear, endPart.month, endPart.day);
  if (!endDate) return null;

  if (!endPart.year && endDate < startDate) {
    endYear += 1;
    endDate = buildDate(endYear, endPart.month, endPart.day);
    if (!endDate) return null;
  }

  if (endDate < startDate) return null;

  return {
    dateFrom: formatDate(startDate),
    dateTo: formatDate(endDate),
    startDate,
    endDate,
  };
}

// ブロックごとに切り出すことで HTML 構造の変化に強くする。
function extractBlocks(html, pattern) {
  const matches = html.match(pattern);
  return matches ? matches : [];
}

// HTMLブロックから class 指定の要素内テキストを取り出す。
function extractTextByClass(blockHtml, tagName, className) {
  const regex = new RegExp(
    `<${tagName}[^>]*class=["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "i"
  );
  const match = blockHtml.match(regex);
  return match ? normalizeText(stripTagsCompact(match[1])) : "";
}

// タイトルとURLを h4 > a から抽出する。
function extractTitleAndUrlFromAnchor(blockHtml, anchorRegex) {
  const match = blockHtml.match(anchorRegex);
  if (!match) return { title: "", href: "" };
  const href = match[1].trim();
  const title = normalizeText(stripTagsCompact(match[2]));
  return { title, href };
}

// 詳細URLを絶対URL化する。欠落時は ENTRY_URL にフォールバック。
function resolveUrl(href) {
  if (!href) return ENTRY_URL;
  try {
    return new URL(href, ENTRY_URL).toString();
  } catch (error) {
    return ENTRY_URL;
  }
}

// 重複キーごとにより適切な URL を選ぶ。
function choosePreferredUrl(currentUrl, candidateUrl) {
  const preferredKeyword = "/exhibition/detail/";
  const currentHasPreferred = currentUrl.includes(preferredKeyword);
  const candidateHasPreferred = candidateUrl.includes(preferredKeyword);
  if (candidateHasPreferred && !currentHasPreferred) {
    return candidateUrl;
  }
  return currentUrl || candidateUrl;
}

async function main() {
  const html = await fetchText(ENTRY_URL, {
    acceptEncoding: "identity",
    encoding: "utf-8",
  });

  const currentBlocks = extractBlocks(
    html,
    /<section[^>]*class=["'][^"']*exhibition-lg-box[^"']*["'][\s\S]*?<\/section>/g
  );
  const pastBlocks = extractBlocks(
    html,
    /<li[^>]*class=["'][^"']*exhibition-simple-item[^"']*["'][\s\S]*?<\/li>/g
  );

  console.log(`found_ing_count=${currentBlocks.length}`);
  console.log(`found_past_count=${pastBlocks.length}`);

  const events = [];
  let excludedInvalidCount = 0;
  let filteredOldCount = 0;

  const pushEvent = ({ title, dateFrom, dateTo, sourceUrl }) => {
    if (!title || !dateFrom || !dateTo) {
      excludedInvalidCount += 1;
      return;
    }
    events.push({ title, date_from: dateFrom, date_to: dateTo, source_url: sourceUrl });
  };

  for (const block of currentBlocks) {
    const mainTitle = extractTextByClass(block, "h3", "post-main-title");
    const subTitle = extractTextByClass(block, "p", "post-sub-title");
    const title = normalizeText([mainTitle, subTitle].filter(Boolean).join(" "));

    const dateText = extractTextByClass(block, "p", "post-term");
    const dateRange = parseDateRange(dateText);
    if (!dateRange) {
      excludedInvalidCount += 1;
      continue;
    }

    const anchorMatch = block.match(/<a[^>]*class=["'][^"']*btn-primary[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/i);
    const sourceUrl = resolveUrl(anchorMatch ? anchorMatch[1] : "");

    pushEvent({
      title,
      dateFrom: dateRange.dateFrom,
      dateTo: dateRange.dateTo,
      sourceUrl,
    });
  }

  for (const block of pastBlocks) {
    const { title, href } = extractTitleAndUrlFromAnchor(
      block,
      /<h4[^>]*class=["'][^"']*exhibition-simple-item__title[^"']*["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h4>/i
    );

    const dateText = extractTextByClass(block, "p", "exhibition-simple-item__date");
    const dateRange = parseDateRange(dateText);
    if (!dateRange || !title) {
      excludedInvalidCount += 1;
      continue;
    }

    const sourceUrl = resolveUrl(href);
    pushEvent({
      title,
      dateFrom: dateRange.dateFrom,
      dateTo: dateRange.dateTo,
      sourceUrl,
    });
  }

  const dedupedMap = new Map();
  for (const event of events) {
    const key = `${event.title}__${event.date_from}__${event.date_to}`;
    if (!dedupedMap.has(key)) {
      dedupedMap.set(key, { ...event });
      continue;
    }

    const existing = dedupedMap.get(key);
    existing.source_url = choosePreferredUrl(existing.source_url, event.source_url);
  }

  const dedupedEvents = Array.from(dedupedMap.values());
  // 過去365日フィルタの閾値は共通モジュールから取得する。
  const cutoffDate = buildPastCutoffDate();
  const filteredEvents = dedupedEvents.filter((eventItem) => {
    // 既存仕様維持: date_to 欠損イベントは残す。
    const evaluation = evaluateEventAgainstPastCutoff(eventItem, cutoffDate, {
      fallbackToDateFrom: false,
      keepOnMissingDate: true,
      keepOnInvalidDate: false,
    });
    if (!evaluation.keep && evaluation.reason === "expired") {
      filteredOldCount += 1;
    }
    return evaluation.keep;
  });
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  finalizeAndSaveEvents({
    venueId: VENUE_ID,
    venueName: VENUE_NAME,
    outputPath: OUTPUT_PATH,
    events: filteredEvents,
    beforeWrite(data) {
      applyTagsToEventsData(data, { overwrite: false });
    },
  });

  console.log(`kept_count=${filteredEvents.length}`);
  console.log(`filtered_old_count: ${filteredOldCount}`);
  console.log(`excluded_invalid_count=${excludedInvalidCount}`);

  const previewEvents = filteredEvents.slice(0, 2);
  for (const event of previewEvents) {
    const titlePreview = event.title.length > 40 ? `${event.title.slice(0, 40)}...` : event.title;
    console.log(
      `preview: ${titlePreview} | ${event.date_from} - ${event.date_to} | ${event.source_url}`
    );
  }

  if (filteredEvents.length === 0) {
    throw new Error("kept_count が 0 です。ページ構造の変化を疑ってください。");
  }
}

main().catch((error) => {
  handleCliFatalError(error, { prefix: "fetch に失敗しました" });
});
