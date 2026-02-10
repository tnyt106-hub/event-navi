// ハイスタッフホール（高松市文化芸術ホール）のイベント情報ページから
// 「開催予定の自主事業」セクションだけを抽出して保存するバッチ。
// 使い方: node scripts/scraping/fetch-highstaff-hall-events.js

const path = require("path");
const { URL } = require("url");

// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("../lib/http");
// 保存前検証と総件数ログを含む共通保存処理を使う。
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { handleCliFatalError } = require("../lib/cli_error");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities, stripTags, normalizeWhitespace } = require("../lib/text");
const { normalizeHeadingLikeTitle } = require("../lib/scraping");

const ENTRY_URL = "https://www.kanon-kaikan.jp/event/";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", "highstaff_hall.json");
const VENUE_ID = "highstaff_hall";
const SECTION_TITLE = "開催予定の自主事業";
// セクション終端候補を配列化し、文言変更に追従しやすくする。
const SECTION_END_MARKERS = ["お預かりチケット", "開催終了", "自主事業アーカイブ"];

// 見出しテキストから対象セクションのHTML断片を抽出する。
function extractSection(html, headingText) {
  const headingRegex = new RegExp(
    `<h[1-6][^>]*>[\\s\\S]*?${headingText}[\\s\\S]*?<\\/h[1-6]>`,
    "i"
  );
  const headingMatch = html.match(headingRegex);
  if (!headingMatch || headingMatch.index === undefined) {
    throw new Error(`${headingText} の見出しが見つかりません。`);
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const tail = html.slice(sectionStart);

  // 次の見出し（対象外のセクション）より前までを抽出する。
  let sectionEnd = tail.length;

  for (const marker of SECTION_END_MARKERS) {
    const markerRegex = new RegExp(`(<h[1-6][^>]*>[\\s\\S]*?${marker}[\\s\\S]*?<\\/h[1-6]>)`, "i");
    const markerMatch = tail.match(markerRegex);
    if (markerMatch && markerMatch.index !== undefined) {
      sectionEnd = Math.min(sectionEnd, markerMatch.index);
    }
  }

  return tail.slice(0, sectionEnd);
}

// 日付文字列を ISO 形式 (YYYY-MM-DD) に変換する。
function buildIsoDate(yearText, monthText, dayText) {
  const year = String(yearText);
  const month = String(monthText).padStart(2, "0");
  const day = String(dayText).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// テキスト内の日付を検出してISO日付と一致情報を返す。
function extractDateMatch(text) {
  const patterns = [/([0-9]{4})[./年]([0-9]{1,2})[./月]([0-9]{1,2})日?/];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return {
        dateIso: buildIsoDate(match[1], match[2], match[3]),
        match,
      };
    }
  }

  return { dateIso: null, match: null };
}

// 日付部分を除いてタイトル文字列を生成する。
function removeDateFromTitle(originalText, dateMatch) {
  if (!dateMatch) {
    return normalizeHeadingLikeTitle(originalText);
  }

  const before = originalText.slice(0, dateMatch.index);
  let after = originalText.slice(dateMatch.index + dateMatch[0].length);
  // 日付の直後に曜日表記がある場合は取り除く。
  after = after.replace(/^\s*[（(][^）)]+[）)]/, "");
  const combined = `${before} ${after}`;
  return normalizeHeadingLikeTitle(combined);
}

// 対象セクション内のリンクからイベント情報を作る。
function buildEventsFromSection(sectionHtml) {
  const events = [];
  const anchorRegex = /<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
  const baseUrl = ENTRY_URL;

  for (const match of sectionHtml.matchAll(anchorRegex)) {
    const href = match[1];
    // 共通 stripTags は空白を残す実装のため、従来挙動（空白圧縮 + trim）を維持する。
    const rawText = normalizeWhitespace(stripTags(match[2]));
    const decodedText = decodeHtmlEntities(rawText);
    const { dateIso, match: dateMatch } = extractDateMatch(decodedText);

    if (!dateIso) {
      // 日付が無いリンクはイベントとして扱わない。
      continue;
    }

    const title = removeDateFromTitle(decodedText, dateMatch);
    if (!title) {
      // タイトルが空になる場合は除外する。
      continue;
    }

    const sourceUrl = href ? new URL(href, baseUrl).toString() : null;

    events.push({
      title,
      date_from: dateIso,
      date_to: dateIso,
      source_url: sourceUrl,
      open_time: null,
      start_time: null,
      end_time: null,
      price: null,
      contact: null,
    });
  }

  return events;
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
    const html = await fetchText(ENTRY_URL, {
      acceptEncoding: "identity",
      encoding: "utf-8",
    });
    const sectionHtml = extractSection(html, SECTION_TITLE);
    const events = buildEventsFromSection(sectionHtml);
    const sortedEvents = sortEventsByDate(events);
    saveEventsFile(sortedEvents);
  } catch (error) {
    handleCliFatalError(error, { prefix: "失敗" });
  }
}

if (require.main === module) {
  main();
}
