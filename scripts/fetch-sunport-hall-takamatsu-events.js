// サンポートホール高松のホールイベント一覧ページから
// 直近Nか月分のイベントを抽出して保存するバッチ。
// 使い方: node scripts/fetch-sunport-hall-takamatsu-events.js

const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("./lib/http");
// JSON 保存処理を共通化する。
const { finalizeAndSaveEvents } = require("./lib/fetch_output");
const { handleCliFatalError } = require("./lib/cli_error");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities, stripTagsCompact } = require("./lib/text");
const { normalizeHeadingLikeTitle, extractLabeledValue: extractLabeledValueFromLines } = require("./lib/scraping");

const ENTRY_URL = "https://www.sunport-hall.jp/hall/";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "sunport_hall_takamatsu.json");
const VENUE_ID = "sunport_hall_takamatsu";
const MONTH_LIMIT = 7;

// HTML断片を行単位のテキスト配列に変換する。
function htmlToLines(html) {
  if (!html) return [];
  const normalized = decodeHtmlEntities(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]*>/g, "");

  return normalized
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// 行の中から日付を ISO 形式 (YYYY-MM-DD) に変換する。
function extractDateFromLine(line) {
  const datePattern = /([0-9]{4})年\s*([0-9]{1,2})月\s*([0-9]{1,2})日/;
  const match = datePattern.exec(line);
  if (!match) {
    return { dateIso: null, match: null };
  }

  const year = match[1];
  const month = match[2].padStart(2, "0");
  const day = match[3].padStart(2, "0");
  return { dateIso: `${year}-${month}-${day}`, match };
}

// 行の中から開始・終了時刻と開場時刻を抽出する。
function extractTimeFromLine(line) {
  const timeRangePattern = /(\d{1,2}:\d{2})\s*[〜～\-–—]\s*(\d{1,2}:\d{2})/;
  const openPattern = /開場\s*(\d{1,2}:\d{2})/;
  const rangeMatch = timeRangePattern.exec(line);
  const openMatch = openPattern.exec(line);
  const startTime = rangeMatch ? rangeMatch[1] : null;
  const endTime = rangeMatch ? rangeMatch[2] : null;
  const openTime = openMatch ? openMatch[1] : null;

  if (startTime || endTime || openTime) {
    return { startTime, endTime, openTime };
  }

  const singleTimeMatch = /(\d{1,2}:\d{2})/.exec(line);
  return {
    startTime: singleTimeMatch ? singleTimeMatch[1] : null,
    endTime: null,
    openTime: null,
  };
}

// 日付行から会場名らしき文字列を抽出する。
function extractVenueName(line, dateMatch) {
  if (!line) return null;
  let remaining = line;

  if (dateMatch?.match) {
    remaining = remaining.replace(dateMatch.match[0], "");
  }

  // 曜日表記や開場時刻などの補足を除去する。
  remaining = remaining.replace(/[（(][^）)]+[）)]/g, "");
  remaining = remaining.replace(/開場\s*\d{1,2}:\d{2}/g, "");
  remaining = remaining.replace(/(\d{1,2}:\d{2})\s*[〜～\-–—]\s*(\d{1,2}:\d{2})/g, "");
  remaining = remaining.replace(/\d{1,2}:\d{2}/g, "");

  const normalized = remaining.replace(/\s+/g, " ").trim();
  return normalized || null;
}

// ラベル付き情報（入場料等・お問合せ）を抽出する。
function extractLabeledValue(lines, labels) {
  // 共通ラベル抽出は空文字を返すため、このスクリプトの従来仕様（未検出は null）へ変換する。
  const value = extractLabeledValueFromLines(lines, labels);
  if (!value) return null;
  return value.replace(/\s+/g, " ").trim() || null;
}

// 月別ページに含まれる「来月のイベント」リンクを探す。
function findNextMonthUrl(html, baseUrl) {
  const anchorRegex = /<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    const href = match[1];
    const text = normalizeHeadingLikeTitle(stripTagsCompact(match[2]));
    if (text.includes("来月のイベント") || text.includes("次月のイベント") || text.includes("翌月のイベント")) {
      return href ? new URL(href, baseUrl).toString() : null;
    }
  }

  return null;
}

// HTMLのh4見出しを起点にイベントブロックを抽出する。
function extractEventBlocks(html) {
  const blocks = [];
  const headingRegex = /<h4\b[^>]*>([\s\S]*?)<\/h4>/gi;
  const matches = Array.from(html.matchAll(headingRegex));

  matches.forEach((match, index) => {
    const headingHtml = match[1];
    const startIndex = match.index + match[0].length;
    const endIndex = matches[index + 1]?.index ?? html.length;
    const bodyHtml = html.slice(startIndex, endIndex);

    blocks.push({ headingHtml, bodyHtml });
  });

  return blocks;
}

// 見出し・本文からイベントの優先リンクを選ぶ。
// 優先順: 見出しリンク > 本文の「詳細」リンク > 本文の /event/ リンク > 本文先頭リンク。
// 実装意図: 競合解消時に「リンク抽出ロジック」と「イベント組み立てロジック」を分離し、
// どちらの変更意図も失わない形で保守しやすくする。
function extractPrimaryEventUrl(block, baseUrl) {
  // まずは見出し(h4)内のリンクを使う。ここが最もイベント代表URLになりやすい。
  const headingLinkMatch = block.headingHtml.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (headingLinkMatch?.[1]) {
    return new URL(headingLinkMatch[1], baseUrl).toString();
  }

  // 次に本文内のリンクを探索する。リンク文言とURLパターンの両方で優先度を決める。
  const bodyLinks = Array.from(
    block.bodyHtml.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)
  );
  if (bodyLinks.length === 0) {
    return null;
  }

  // リンクテキストはタグ除去+整形して判定する。
  const candidates = bodyLinks.map((match) => ({
    href: match[1],
    text: normalizeHeadingLikeTitle(stripTagsCompact(match[2])),
  }));

  const detailTextLink = candidates.find((item) => item.text.includes("詳細"));
  if (detailTextLink?.href) {
    return new URL(detailTextLink.href, baseUrl).toString();
  }

  const eventPathLink = candidates.find((item) => item.href.includes("/event/"));
  if (eventPathLink?.href) {
    return new URL(eventPathLink.href, baseUrl).toString();
  }

  // 最後のフォールバックとして本文先頭リンクを使う。
  return candidates[0]?.href ? new URL(candidates[0].href, baseUrl).toString() : null;
}

// 見出しと本文からイベントデータを構築する。
function buildEventFromBlock(block, baseUrl) {
  const headingText = normalizeHeadingLikeTitle(stripTagsCompact(block.headingHtml));
  if (!headingText) return null;
  // source_url は「イベント固有URL」を優先して設定する。
  // 取得できない場合でも、データ参照先を失わないために一覧ページURLを必ず設定する。
  // （運用要件: source_url を null にしない）
  const sourceUrl = extractPrimaryEventUrl(block, baseUrl) || baseUrl;

  const lines = htmlToLines(block.bodyHtml);
  const dateLine = lines[0] || "";
  const dateMatch = extractDateFromLine(dateLine);
  if (!dateMatch.dateIso) {
    return null;
  }

  const { startTime, endTime, openTime } = extractTimeFromLine(dateLine);
  const venueName = extractVenueName(dateLine, dateMatch);
  const price = extractLabeledValue(lines, ["入場料等", "入場料", "料金"]);
  const contact = extractLabeledValue(lines, ["お問合せ", "お問い合わせ", "問合せ", "問い合わせ"]);

  return {
    title: headingText,
    date_from: dateMatch.dateIso,
    date_to: dateMatch.dateIso,
    venue_name: venueName,
    source_url: sourceUrl,
    open_time: openTime,
    start_time: startTime,
    end_time: endTime,
    price: price || null,
    contact: contact || null,
  };
}

// 複数月ページを取得して結合する。
async function fetchMonthlyPages(entryUrl, limit) {
  const pages = [];
  const visited = new Set();
  let currentUrl = entryUrl;

  for (let i = 0; i < limit && currentUrl; i += 1) {
    if (visited.has(currentUrl)) {
      break;
    }

    const html = await fetchText(currentUrl, {
      acceptEncoding: "identity",
      encoding: "utf-8",
    });
    pages.push({ url: currentUrl, html });
    visited.add(currentUrl);

    currentUrl = findNextMonthUrl(html, currentUrl);
  }

  return pages;
}

// 重複イベントを除去する（title + date_from + venue_name + start_time）。
function dedupeEvents(events) {
  const seen = new Set();
  const unique = [];

  for (const event of events) {
    const key = [event.title, event.date_from, event.venue_name, event.start_time].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(event);
  }

  return unique;
}

// イベント配列を日付昇順で並べ替える。
function sortEventsByDate(events) {
  return [...events].sort((a, b) => {
    if (a.date_from === b.date_from) {
      return String(a.title).localeCompare(String(b.title));
    }
    return String(a.date_from).localeCompare(String(b.date_from));
  });
}

// 成功時のみファイルを書き換える。
function saveEventsFile(events) {
  finalizeAndSaveEvents({
    venueId: VENUE_ID,
    outputPath: OUTPUT_PATH,
    events,
  });
}

async function main() {
  try {
    const pages = await fetchMonthlyPages(ENTRY_URL, MONTH_LIMIT);
    const events = [];

    for (const page of pages) {
      const blocks = extractEventBlocks(page.html);
      for (const block of blocks) {
        const event = buildEventFromBlock(block, page.url);
        if (event) {
          events.push(event);
        }
      }
    }

    const uniqueEvents = dedupeEvents(events);
    const sortedEvents = sortEventsByDate(uniqueEvents);
    const dateCount = sortedEvents.filter((event) => event.date_from).length;

    if (sortedEvents.length === 0) {
      throw new Error("イベントが0件のため上書きしません。");
    }

    if (dateCount === 0) {
      throw new Error("date_from が1件も作成できませんでした。");
    }

    saveEventsFile(sortedEvents);
  } catch (error) {
    handleCliFatalError(error, { prefix: "失敗" });
  }
}

if (require.main === module) {
  main();
}
