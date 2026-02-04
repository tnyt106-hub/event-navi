// 愛媛県武道館のイベント一覧ページから詳細ページを取得し、
// HTML 構造ベースでイベント情報を抽出して JSON に保存するバッチ。
// 使い方: node scripts/fetch-ehime-budoukan-events.js

const path = require("path");
const { URL } = require("url");

// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchHtml } = require("./lib/http");
// 日付解析の共通関数を使う。
const { extractDateRange, isDateInRange } = require("./lib/date");
// JSON 保存処理を共通化する。
const { saveEventJson } = require("./lib/io");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities, normalizeWhitespace, stripTags } = require("./lib/text");

const VENUE_ID = "ehime-budoukan";
const LIST_URL = "https://ehime-spa.jp/budoukan_event/";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "ehime-budoukan.json");

// <dl class="dl_postevent"> 内の dt/dd を Map 化する。
function buildDetailMap(detailHtml) {
  const map = new Map();
  if (!detailHtml) return map;

  // dl_postevent ブロックを抽出して、その中の dt/dd を 1:1 で対応付ける。
  const dlRegex = /<dl class="dl_postevent[^"]*">[\s\S]*?<\/dl>/g;
  for (const dlMatch of detailHtml.matchAll(dlRegex)) {
    const dlHtml = dlMatch[0];
    const pairRegex = /<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g;
    for (const pair of dlHtml.matchAll(pairRegex)) {
      const key = normalizeWhitespace(decodeHtmlEntities(stripTags(pair[1])));
      const value = normalizeWhitespace(decodeHtmlEntities(stripTags(pair[2])));
      if (key) {
        map.set(key, value);
      }
    }
  }

  return map;
}

// <h1> を補助的に使ってタイトルを取得する。
function extractTitleFromH1(detailHtml) {
  if (!detailHtml) return "";
  const match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(detailHtml);
  if (!match) return "";
  return normalizeWhitespace(decodeHtmlEntities(stripTags(match[1])));
}

// 年月日を ISO 形式 (YYYY-MM-DD) に変換する。
function toIsoDate(year, month, day) {
  const yyyy = String(year);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// 日付テキストの「年なし」を開始年で補完し、年跨ぎ補正を行う。
function adjustDateRangeByText(dateText, baseRange) {
  if (!dateText || !baseRange) return baseRange;

  const dateRegex = /(\d{4}年)?(\d{1,2})月(\d{1,2})日/g;
  const matches = [...dateText.matchAll(dateRegex)];
  if (matches.length === 0) return baseRange;

  const baseYear = Number(String(baseRange.date_from || "").slice(0, 4));
  const startMatch = matches[0];
  const startYear = startMatch[1] ? parseInt(startMatch[1].replace("年", ""), 10) : baseYear;
  const startDate = toIsoDate(startYear, startMatch[2], startMatch[3]);

  const endMatch = matches.length > 1 ? matches[matches.length - 1] : startMatch;
  let endYear = endMatch[1] ? parseInt(endMatch[1].replace("年", ""), 10) : startYear;
  let endDate = toIsoDate(endYear, endMatch[2], endMatch[3]);

  // 年跨ぎ補正: date_to < date_from の場合は date_to の年を +1 する。
  if (endDate < startDate) {
    endYear += 1;
    endDate = toIsoDate(endYear, endMatch[2], endMatch[3]);
  }

  return {
    date_from: startDate,
    date_to: endDate,
  };
}

// 時刻テキストから HH:MM を抽出する。
function extractTimeRange(timeText) {
  if (!timeText) {
    return { start_time: null, end_time: null };
  }

  const matches = [...timeText.matchAll(/(\d{1,2})[:：](\d{2})/g)];
  if (matches.length === 0) {
    return { start_time: null, end_time: null };
  }

  const toTime = (match) => {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  };

  const startTime = toTime(matches[0]);
  const endTime = matches.length >= 2 ? toTime(matches[matches.length - 1]) : null;

  return {
    start_time: startTime,
    end_time: endTime,
  };
}

// 一覧 HTML から詳細ページのリンク一覧を抽出する。
function extractDetailLinks(html) {
  const detailLinks = [];
  const seen = new Set();
  const blocks = [];
  const blockRegex = /<([a-z0-9]+)\b[^>]*class=["'][^"']*shisetsu_event_list[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;

  for (const match of html.matchAll(blockRegex)) {
    blocks.push(match[2]);
  }

  const sourceHtml = blocks.length > 0 ? blocks.join("\n") : html;
  const anchorRegex = /<a\b[^>]*href=['"]([^'"]+)['"][^>]*>/gi;

  for (const match of sourceHtml.matchAll(anchorRegex)) {
    const href = match[1];
    if (!href) continue;

    let absoluteUrl = "";
    try {
      absoluteUrl = new URL(href, LIST_URL).toString();
    } catch (error) {
      continue;
    }

    if (!absoluteUrl.includes("https://ehime-spa.jp/budoukan_event/")) {
      continue;
    }

    if (seen.has(absoluteUrl)) {
      continue;
    }

    seen.add(absoluteUrl);
    detailLinks.push(absoluteUrl);
  }

  console.log("[debug] detailLinks:", detailLinks);
  return detailLinks;
}

// 詳細 HTML からイベント情報を抽出する。
function extractEventFromDetail(detailHtml, detailUrl) {
  // dl_postevent の dt/dd を HTML 構造ベースで読み取り、マップを作る。
  const detailMap = buildDetailMap(detailHtml);
  console.log("[debug] detailMap:", Object.fromEntries(detailMap));

  // タイトルは「イベント名」を最優先し、無ければ h1 を補助的に使う。
  const title = detailMap.get("イベント名") || extractTitleFromH1(detailHtml);
  const dateText = detailMap.get("イベント開催期間") || "";
  const baseRange = extractDateRange(dateText);
  if (!baseRange) {
    console.log(`[debug] date parse failed: ${dateText}`);
  }
  const range = adjustDateRangeByText(dateText, baseRange);

  // タイトルや日付が取得できない場合はスキップする。
  if (!title || !range?.date_from) {
    return null;
  }

  // 「時間」から HH:MM を抽出し、開始/終了時刻に割り当てる。
  const timeText = detailMap.get("時間") || "";
  const timeRange = extractTimeRange(timeText);

  const event = {
    title,
    date_from: range.date_from,
    date_to: range.date_to,
    source_url: detailUrl,
    venue_id: VENUE_ID,
  };

  if (timeRange.start_time) event.start_time = timeRange.start_time;
  if (timeRange.end_time) event.end_time = timeRange.end_time;

  return event;
}

// JST の今日を基準に、過去/未来 1 年の範囲を作る。
function buildJstRange() {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const jstToday = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate()));
  const start = new Date(jstToday);
  const end = new Date(jstToday);
  start.setDate(start.getDate() - 365);
  end.setDate(end.getDate() + 365);
  return { start, end };
}

async function main() {
  try {
    const listHtml = await fetchHtml(LIST_URL, {
      acceptEncoding: "identity",
      encoding: "utf-8",
    });

    const detailLinks = extractDetailLinks(listHtml);
    const events = [];
    const range = buildJstRange();

    // 詳細ページは逐次取得して、負荷とログの追跡を安定させる。
    for (const detailUrl of detailLinks) {
      try {
        const detailHtml = await fetchHtml(detailUrl, {
          acceptEncoding: "identity",
          encoding: "utf-8",
        });
        const event = extractEventFromDetail(detailHtml, detailUrl);
        if (!event) {
          continue;
        }
        if (!isDateInRange(event.date_from, range)) {
          continue;
        }
        events.push(event);
      } catch (error) {
        console.warn(`詳細取得に失敗: ${detailUrl} (${error.message})`);
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const data = {
      venue_id: VENUE_ID,
      last_success_at: today,
      events,
    };

    // 0 件の場合は既存ファイルを破壊しない。
    if (!saveEventJson(OUTPUT_PATH, data)) {
      return;
    }
  } catch (error) {
    console.error(`失敗: ${error.message}`);
    process.exit(1);
  }
}

main();
