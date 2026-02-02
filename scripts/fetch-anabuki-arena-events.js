// あなぶきアリーナ香川のイベント一覧ページから
// 詳細ページを辿って開催日を抽出し、JSONに保存するバッチ。
// 使い方: node scripts/fetch-anabuki-arena-events.js

const path = require("path");
const { URL } = require("url");

const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");
// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("./lib/http");
// JSON 保存処理を共通化する。
const { writeJsonPretty } = require("./lib/io");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities } = require("./lib/text");

const LIST_URL = "https://kagawa-arena.com/event/";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "anabuki_arena_kagawa.json");
const VENUE_ID = "anabuki_arena_kagawa";
const MONTH_RANGE = 7;

// タグを落としてプレーンテキスト化する。
function stripTags(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "");
}

// タイトルや本文に含まれる HTML をプレーンテキスト化する。
function htmlToText(html) {
  return stripTags(decodeHtmlEntities(html)).replace(/\s+/g, " ").trim();
}

// URL がイベント詳細ページかどうかを判定する。
function isDetailPageUrl(url) {
  const pathName = url.pathname;
  if (!pathName.startsWith("/event/")) {
    return false;
  }

  if (pathName === "/event" || pathName === "/event/") {
    return false;
  }

  if (pathName.startsWith("/event/page/")) {
    return false;
  }

  return true;
}

// 一覧ページのページング URL かどうかを判定する。
function isListPageUrl(url) {
  const pathName = url.pathname;
  if (!pathName.startsWith("/event/")) {
    return false;
  }

  if (pathName.startsWith("/event/page/")) {
    return true;
  }

  if (url.searchParams.has("paged") || url.searchParams.has("page")) {
    return true;
  }

  return false;
}

// 一覧 HTML から詳細ページリンクとページングリンクを抽出する。
function extractLinksFromList(html, baseUrl, stats) {
  const detailLinks = [];
  const pageLinks = [];
  const anchorRegex = /<a\b[^>]*href=['"]([^'"]+)['"][^>]*>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    const href = match[1];
    if (!href) {
      stats.excludedInvalid += 1;
      continue;
    }

    let absoluteUrl;
    try {
      absoluteUrl = new URL(href, baseUrl);
    } catch (error) {
      stats.excludedInvalid += 1;
      continue;
    }

    if (isDetailPageUrl(absoluteUrl)) {
      detailLinks.push(absoluteUrl.toString());
      continue;
    }

    if (isListPageUrl(absoluteUrl)) {
      pageLinks.push(absoluteUrl.toString());
    }
  }

  return { detailLinks, pageLinks };
}

// すべての一覧ページを巡回して詳細リンクを集める。
async function fetchAllDetailLinks() {
  const pending = [LIST_URL];
  const visited = new Set();
  const detailLinkSet = new Set();
  const stats = {
    listPages: 0,
    excludedInvalid: 0,
  };

  while (pending.length > 0) {
    const currentUrl = pending.shift();
    if (!currentUrl || visited.has(currentUrl)) {
      continue;
    }

    visited.add(currentUrl);
    stats.listPages += 1;

    const html = await fetchText(currentUrl, {
      acceptEncoding: "identity",
      encoding: "utf-8",
    });

    const { detailLinks, pageLinks } = extractLinksFromList(html, currentUrl, stats);

    for (const link of detailLinks) {
      if (!detailLinkSet.has(link)) {
        detailLinkSet.add(link);
      }
    }

    for (const pageLink of pageLinks) {
      if (!visited.has(pageLink)) {
        pending.push(pageLink);
      }
    }
  }

  return {
    detailLinks: Array.from(detailLinkSet),
    stats,
  };
}

// 詳細 HTML からタイトルを抽出する（h1 > og:title > title の順）。
function extractTitleFromHtml(html) {
  const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  if (ogMatch) {
    const ogTitle = htmlToText(ogMatch[1]);
    if (ogTitle) return ogTitle;
  }

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    const h1Title = htmlToText(h1Match[1]);
    if (h1Title) return h1Title;
  }

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const docTitle = htmlToText(titleMatch[1]);
    if (docTitle) return docTitle;
  }

  return "";
}

// 年月日を ISO 形式の文字列にする。
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

// 年が省略された日付を、対象期間内に収まる年へ補完する。
function resolveYearForMonthDay(month, day, startDate, endExclusive) {
  const baseYear = startDate.getFullYear();
  const candidates = [baseYear, baseYear + 1, baseYear - 1];

  for (const year of candidates) {
    const candidateDate = buildDate(year, month, day);
    if (!candidateDate) continue;
    if (candidateDate >= startDate && candidateDate < endExclusive) {
      return year;
    }
  }

  // 期間外しか無い場合は当年を返し、後続のフィルタで除外する。
  return baseYear;
}

// HTML内の日時表示パーツから月日を抜き出す。
function extractDateRangeFromHtml(html, startDate, endExclusive) {
  // raw HTMLから span の中身を直接見ることで、画像URLなどの誤検知を避ける。
  const startMatch = html.match(/class="date_start">(\d{1,2})\.(\d{1,2})/);
  if (!startMatch) {
    return { dateFrom: null, dateTo: null, reason: "missing-date_start" };
  }

  const startMonth = Number(startMatch[1]);
  const startDay = Number(startMatch[2]);
  const startYear = resolveYearForMonthDay(startMonth, startDay, startDate, endExclusive);
  const dateFrom = buildDate(startYear, startMonth, startDay);
  if (!dateFrom) {
    return { dateFrom: null, dateTo: null, reason: "invalid-date_start" };
  }

  const endMatch = html.match(/class="date_end">(\d{1,2})\.(\d{1,2})/);
  if (!endMatch) {
    return { dateFrom, dateTo: dateFrom, reason: null };
  }

  const endMonth = Number(endMatch[1]);
  const endDay = Number(endMatch[2]);
  const endYear = resolveYearForMonthDay(endMonth, endDay, startDate, endExclusive);
  const dateTo = buildDate(endYear, endMonth, endDay);
  if (!dateTo) {
    return { dateFrom: null, dateTo: null, reason: "invalid-date_end" };
  }

  return { dateFrom, dateTo, reason: null };
}

// 詳細ページ内の <dl class="list-detail"> から dt/dd を抽出する。
function extractDetailItems(html) {
  const listMatch = html.match(/<dl class="list-detail">([\s\S]*?)<\/dl>/);
  if (!listMatch) {
    return [];
  }

  const items = [];
  const detailHtml = listMatch[1];
  const pairRegex = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g;
  let match = pairRegex.exec(detailHtml);
  while (match) {
    const rawLabel = htmlToText(match[1]);
    const rawValue = match[2];
    if (rawLabel) {
      items.push({ label: rawLabel, valueHtml: rawValue });
    }
    match = pairRegex.exec(detailHtml);
  }

  return items;
}

// 詳細情報の値をプレーンテキスト化し、空白を整える。
function normalizeDetailValue(valueHtml) {
  if (!valueHtml) return "";
  const withBreaks = valueHtml.replace(/<br\s*\/?>/gi, " ");
  return htmlToText(withBreaks).replace(/\s+/g, " ").trim();
}

// 詳細情報のラベルを検索して該当する dd を返す。
function findDetailValue(detailItems, labels) {
  return detailItems.find((item) => labels.some((label) => item.label.includes(label))) || null;
}

// dd のテキストから時刻を抜き出す。
function extractTimeFromText(text) {
  if (!text) return null;
  const normalized = text.replace(/：/g, ":");
  const match = normalized.match(/(\d{1,2}:\d{2})/);
  return match ? match[1] : null;
}

// 問い合わせ dd から連絡先を取り出し、理由を付けて返す。
function extractContactFromDetail(valueHtml, summary) {
  if (!valueHtml) {
    return { contact: null, reason: "missing-contact" };
  }

  const text = normalizeDetailValue(valueHtml);
  if (!text) {
    return { contact: null, reason: "empty-contact" };
  }

  const linkPhrases = ["主催者の方はこちら", "お問い合わせはこちら", "こちら", "詳細はこちら"];
  if (linkPhrases.some((phrase) => text === phrase)) {
    summary.contactLinkInvalidatedCount += 1;
    return { contact: null, reason: "link-text-only" };
  }

  const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const phonePattern = /\d{2,4}-\d{2,4}-\d{3,4}/;

  const emailMatch = text.match(emailPattern);
  if (emailMatch) {
    return { contact: emailMatch[0], reason: null };
  }

  const phoneMatch = text.match(phonePattern);
  if (phoneMatch) {
    return { contact: phoneMatch[0], reason: null };
  }

  return { contact: text, reason: null };
}

// 現在月の月初と、そこから7か月後の排他終点を作る。
function buildTargetRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const endExclusive = new Date(start);
  endExclusive.setMonth(endExclusive.getMonth() + MONTH_RANGE);
  return { start, endExclusive };
}

// 日付の配列から最小/最大を返す。
function findDateRange(dates) {
  if (!dates || dates.length === 0) return null;
  const sorted = [...dates].sort((a, b) => a - b);
  return { min: sorted[0], max: sorted[sorted.length - 1] };
}

// メイン処理。
async function main() {
  const { start, endExclusive } = buildTargetRange();
  const summary = {
    listCount: 0,
    detailCount: 0,
    adoptedCount: 0,
    missingDateCount: 0,
    filteredOutCount: 0,
    maxDateFrom: null,
    dateStartMissingCount: 0,
    contactLinkInvalidatedCount: 0,
  };

  let detailLinksResult;
  try {
    detailLinksResult = await fetchAllDetailLinks();
  } catch (error) {
    console.error(`一覧ページ取得エラー: ${error.message}`);
    console.error("0件のため published を更新しません。");
    process.exit(1);
    return;
  }

  const entries = detailLinksResult.detailLinks.map((link) => ({
    title: "",
    link,
  }));

  summary.listCount = entries.length;
  console.log(`list_links 件数: ${summary.listCount}`);

  const events = [];
  const datesFound = [];

  let debugLogged = 0;
  for (const entry of entries) {
    if (!entry.link) {
      continue;
    }

    let html;
    try {
      html = await fetchText(entry.link, {
        acceptEncoding: "identity",
        encoding: "utf-8",
      });
    } catch (error) {
      console.warn(`詳細ページ取得失敗: ${entry.link} (${error.message})`);
      continue;
    }

    summary.detailCount += 1;

    const extractedTitle = extractTitleFromHtml(html);
    const dateRange = extractDateRangeFromHtml(html, start, endExclusive);
    if (!dateRange.dateFrom || !dateRange.dateTo) {
      summary.missingDateCount += 1;
      if (dateRange.reason === "missing-date_start") {
        summary.dateStartMissingCount += 1;
      }
      continue;
    }

    const dateFrom = dateRange.dateFrom;
    const dateTo = dateRange.dateTo;

    // 開始日ベースで期間フィルタをかける。
    if (dateFrom < start || dateFrom >= endExclusive) {
      summary.filteredOutCount += 1;
      continue;
    }

    const detailItems = extractDetailItems(html);
    const openDetail = findDetailValue(detailItems, ["開場時間"]);
    const startDetail = findDetailValue(detailItems, ["開演時間"]);
    const endDetail = findDetailValue(detailItems, ["終演時間"]);

    const openTime = openDetail ? extractTimeFromText(normalizeDetailValue(openDetail.valueHtml)) : null;
    const startTime = startDetail ? extractTimeFromText(normalizeDetailValue(startDetail.valueHtml)) : null;
    const endTime = endDetail ? extractTimeFromText(normalizeDetailValue(endDetail.valueHtml)) : null;

    const priceDetail = findDetailValue(detailItems, ["料金", "入場料", "参加費", "チケット"]);
    const price = priceDetail ? normalizeDetailValue(priceDetail.valueHtml) : null;

    const contactDetail = findDetailValue(detailItems, ["お問い合わせ", "問合せ", "問い合わせ", "連絡先", "電話", "TEL"]);
    const contactResult = extractContactFromDetail(contactDetail?.valueHtml, summary);
    const contact = contactResult.contact;

    const event = {
      title: extractedTitle || entry.title || htmlToText(entry.link),
      date_from: formatDate(dateFrom),
      date_to: formatDate(dateTo),
      source_url: entry.link,
      open_time: openTime,
      start_time: startTime,
      end_time: endTime,
      price: price || null,
      contact: contact || null,
      source_type: "html",
      tags: null,
    };

    events.push(event);
    datesFound.push(dateFrom);

    if (debugLogged < 3) {
      const priceStatus = price ? "found" : "missing";
      const contactReason = contact ? "ok" : contactResult.reason || "unknown";
      console.log(
        `[debug] url=${entry.link} date_from=${event.date_from} date_to=${event.date_to} open_time=${
          openTime || "null"
        } price=${priceStatus} contact_reason=${contactReason}`
      );
      debugLogged += 1;
    }
  }

  summary.adoptedCount = events.length;

  if (datesFound.length > 0) {
    summary.maxDateFrom = formatDate(datesFound.sort((a, b) => a - b)[datesFound.length - 1]);
  }

  console.log(`詳細ページ取得件数: ${summary.detailCount}`);
  console.log(`採用イベント件数: ${summary.adoptedCount}`);
  console.log(`max date_from: ${summary.maxDateFrom || "なし"}`);
  console.log(`date_start 欠落件数: ${summary.dateStartMissingCount}`);
  console.log(`contactリンク文言無効化: ${summary.contactLinkInvalidatedCount}`);
  console.log(`[fetch] list_links: ${summary.listCount}`);
  console.log(`[fetch] excluded_invalid: ${detailLinksResult.stats.excludedInvalid}`);
  console.log(`[fetch] events_built: ${events.length}`);
  console.log(`[fetch] output_path: ${OUTPUT_PATH}`);

  if (events.length === 0 || datesFound.length === 0) {
    console.warn("採用イベントが0件のため、published を更新しません。");
    console.warn(
      `内訳: 日付抽出失敗=${summary.missingDateCount}, 期間外除外=${summary.filteredOutCount}`
    );
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
