// サンポートホール高松のホールイベント一覧ページから
// 直近Nか月分のイベントを抽出して保存するバッチ。
// 使い方: node scripts/fetch-sunport-hall-takamatsu-events.js

const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");
// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("./lib/http");
// JSON 保存処理を共通化する。
const { writeJsonPretty } = require("./lib/io");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities } = require("./lib/text");

const ENTRY_URL = "https://www.sunport-hall.jp/hall/";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "sunport_hall_takamatsu.json");
const VENUE_ID = "sunport_hall_takamatsu";
const MONTH_LIMIT = 7;

// タグを落としてプレーンテキスト化する。
function stripTags(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "");
}

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

// タイトル用に文字列を整形する。
function normalizeTitle(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—―~〜～:：・|｜]+/, "")
    .trim();
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
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const label of labels) {
      if (line.includes(label)) {
        const cleaned = line.replace(label, "").replace(/[:：\-–—]/g, " ").trim();
        if (cleaned) {
          return cleaned.replace(/\s+/g, " ");
        }
        const nextLine = lines[i + 1];
        if (nextLine) {
          return nextLine.replace(/\s+/g, " ").trim();
        }
      }
    }
  }
  return null;
}

// 月別ページに含まれる「来月のイベント」リンクを探す。
function findNextMonthUrl(html, baseUrl) {
  const anchorRegex = /<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    const href = match[1];
    const text = normalizeTitle(stripTags(match[2]));
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

// 見出しと本文からイベントデータを構築する。
// 見出しと本文からイベントデータを構築する。
function buildEventFromBlock(block, baseUrl) {
  const headingText = normalizeTitle(stripTags(block.headingHtml));
  if (!headingText) return null;

  // --- 【修正箇所】URL取得とフォールバック（救済措置） ---
  
  // 1. まずは見出し(h4)の中からリンクを探す
  let linkMatch = block.headingHtml.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>/i);

  // 2. 見出しになければ本文(bodyHtml)から「詳細」という文字を含むリンクを探す
  if (!linkMatch) {
    const allLinks = Array.from(block.bodyHtml.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi));
    const detailLink = allLinks.find(m => {
      const href = m[1];
      const text = m[2];
      return text.includes("詳細") || href.includes("/event/");
    });
    linkMatch = detailLink || allLinks[0] || null;
  }

  // 3. 【重要】URLが取得できなかった場合は baseUrl (一覧ページ) を代入する
  const sourceUrl = (linkMatch && linkMatch[1]) 
    ? new URL(linkMatch[1], baseUrl).toString() 
    : baseUrl; // null の場合は https://www.sunport-hall.jp/hall/ が入る

  // ----------------------------------------------------

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
    source_url: sourceUrl, // 取得に失敗していても baseUrl がセットされる
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
  const today = new Date().toISOString().slice(0, 10);
  const data = {
    venue_id: VENUE_ID,
    last_success_at: today,
    events,
  };

  applyTagsToEventsData(data, { overwrite: false });

  writeJsonPretty(OUTPUT_PATH, data);
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
    console.log(`完了: ${sortedEvents.length} 件のイベントを保存しました。`);
  } catch (error) {
    console.error(`失敗: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
