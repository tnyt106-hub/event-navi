// itemehime のイベント一覧ページから詳細ページをたどって
// イベント情報を JSON に保存するバッチ。
// 使い方: node scripts/fetch-itemehime.js

const path = require("path");
const { URL } = require("url");

// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("./lib/http");
// JSON 保存処理を共通化する。
const { writeJsonPretty } = require("./lib/io");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities, normalizeWhitespace, stripTagsWithLineBreaks } = require("./lib/text");
// イベント詳細 URL 判定の共通ヘルパー。
const { isEventDetailUrl } = require("./lib/event_url");
// HTML からイベントタイトルを抽出する共通ヘルパー。
const { extractEventTitleFromDetailHtml } = require("./lib/event_title");
// 価格・問い合わせ情報の正規化ヘルパー。
const { normalizePrice, normalizeContact } = require("./lib/event_fields");
// source_url の重複を排除するヘルパー。
const { dedupeEventsBySourceUrl } = require("./lib/dedupe");

const VENUE_ID = "itemehime";
const LIST_URL = "https://itemehime.com/event/";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "itemehime.json");

// 日本語の全角数字や記号を半角へ寄せて、解析しやすくする。
function normalizeJapaneseText(text) {
  if (!text) return "";
  return text
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ":")
    .replace(/[．]/g, ".")
    .replace(/[／]/g, "/")
    .replace(/[〜～]/g, "~")
    .replace(/[－–—]/g, "-");
}

// 年月日を ISO 形式 (YYYY-MM-DD) に変換する。
function toIsoDate(year, month, day) {
  const yyyy = String(year);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// テキストから日本語の日付を抽出する。
function extractDate(text) {
  const normalized = normalizeJapaneseText(normalizeWhitespace(text));
  const match = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(normalized);
  if (!match) return null;
  return toIsoDate(match[1], match[2], match[3]);
}

// 時刻表現を HH:MM 形式として解釈する。
function parseTimeCandidate(value) {
  if (!value) return null;
  const normalized = normalizeJapaneseText(value);
  const match = /(\d{1,2}):(\d{2})/.exec(normalized);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// ラベル付きの時刻を探して返す。
function extractTimeByLabels(lines, labels) {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const regex = new RegExp(`(${labelPattern})[^0-9]*([0-2]?\\d[:：][0-5]\\d)`);

  for (const line of lines) {
    const normalizedLine = normalizeJapaneseText(line);
    const match = regex.exec(normalizedLine);
    if (match) {
      const time = parseTimeCandidate(match[2]);
      if (time) {
        return time;
      }
    }
  }
  return null;
}

// ラベル付きの値（価格や問い合わせ先）を探す。
function extractLabeledValue(lines, labels) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const label of labels) {
      if (!line.includes(label)) {
        continue;
      }
      const normalizedLine = normalizeWhitespace(line);
      const labelRegex = new RegExp(`${label}[^:：]*[:：]?\s*(.+)`);
      const match = labelRegex.exec(normalizedLine);
      if (match && match[1]) {
        return match[1].trim();
      }
      const nextLine = lines[i + 1];
      if (nextLine) {
        const nextValue = normalizeWhitespace(nextLine);
        if (nextValue) {
          return nextValue;
        }
      }
    }
  }
  return null;
}

// body 用のテキストを整形する（改行単位でトリムし、最大 5000 文字に収める）。
function formatBody(text) {
  if (!text) return "";
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const maxLength = 5000;
  const resultLines = [];
  let totalLength = 0;

  for (const line of lines) {
    const separatorLength = resultLines.length > 0 ? 1 : 0;
    const nextLength = totalLength + separatorLength + line.length;

    if (nextLength > maxLength) {
      if (resultLines.length > 0) {
        if (totalLength + 1 <= maxLength) {
          resultLines[resultLines.length - 1] = `${resultLines[resultLines.length - 1]}…`;
        } else {
          const lastLine = resultLines[resultLines.length - 1];
          resultLines[resultLines.length - 1] = `${lastLine.slice(0, Math.max(0, lastLine.length - 1))}…`;
        }
      }
      break;
    }

    resultLines.push(line);
    totalLength = nextLength;
  }

  return resultLines.join("\n");
}

// body を入れるべきか判定する。
function shouldIncludeBody({ openTime, startTime, endTime, price, contact }) {
  return !openTime && !startTime && !endTime && !price && !contact;
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

// ISO 日付が対象範囲内か判定する。
function isDateInRange(isoDate, range) {
  if (!isoDate) return false;
  const date = new Date(`${isoDate}T00:00:00+09:00`);
  return date >= range.start && date <= range.end;
}

// 一覧 HTML から詳細ページのリンク一覧を抽出する。
function extractDetailLinks(html) {
  const detailLinks = [];
  const seen = new Set();
  let listLinks = 0;
  const anchorRegex = /<a\b[^>]*href=['"]([^'"]+)['"][^>]*>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    const href = match[1];
    if (!href) {
      continue;
    }

    let absoluteUrl = "";
    try {
      absoluteUrl = new URL(href, LIST_URL).toString();
    } catch (error) {
      continue;
    }

    // /event/ を含むリンクは集計にカウントする。
    if (absoluteUrl.includes("/event/")) {
      listLinks += 1;
    }

    // イベント詳細ページと判定できない URL は除外する。
    if (!isEventDetailUrl(absoluteUrl)) {
      continue;
    }

    if (seen.has(absoluteUrl)) {
      continue;
    }

    seen.add(absoluteUrl);
    detailLinks.push(absoluteUrl);
  }

  return {
    detailLinks,
    listLinks,
    detailLinksUnique: detailLinks.length,
  };
}

// 詳細 HTML からイベント情報を抽出する。
function extractEventFromDetail(detailHtml, detailUrl) {
  const textWithBreaks = decodeHtmlEntities(stripTagsWithLineBreaks(detailHtml));
  const lines = textWithBreaks
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const plainText = normalizeWhitespace(textWithBreaks);

  const title = extractEventTitleFromDetailHtml(detailHtml);
  const dateFrom = extractDate(plainText);

  if (!title || !dateFrom) {
    return null;
  }

  const openTime = extractTimeByLabels(lines, ["開場"]);
  const startTime = extractTimeByLabels(lines, ["開演", "開始"]);
  const endTime = extractTimeByLabels(lines, ["終演", "終了"]);

  const price = normalizePrice(extractLabeledValue(lines, ["料金", "参加費", "入場料"]));
  const contact = normalizeContact(extractLabeledValue(lines, ["問い合わせ", "お問い合わせ", "連絡先"]));

  const event = {
    title,
    date_from: dateFrom,
    date_to: dateFrom,
    source_url: detailUrl,
  };

  if (openTime) event.open_time = openTime;
  if (startTime) event.start_time = startTime;
  if (endTime) event.end_time = endTime;
  if (price) event.price = price;
  if (contact) event.contact = contact;

  if (shouldIncludeBody({ openTime, startTime, endTime, price, contact })) {
    const formattedBody = formatBody(textWithBreaks);
    if (formattedBody) {
      event.body = formattedBody;
    }
  }

  return event;
}

// 成功時のみファイルを書き換える。
function saveEventsFile(events) {
  const today = new Date().toISOString().slice(0, 10);
  const data = {
    venue_id: VENUE_ID,
    last_success_at: today,
    events,
  };

  writeJsonPretty(OUTPUT_PATH, data);
}

async function main() {
  let listLinks = 0;
  let detailLinksUnique = 0;
  let excludedInvalid = 0;
  let detailFetchFailed = 0;

  try {
    const listHtml = await fetchText(LIST_URL, {
      acceptEncoding: "identity",
      encoding: "utf-8",
    });

    const detailLinkResult = extractDetailLinks(listHtml);
    const detailLinks = detailLinkResult.detailLinks;
    listLinks = detailLinkResult.listLinks;
    detailLinksUnique = detailLinkResult.detailLinksUnique;

    const events = [];
    const range = buildJstRange();

    // 詳細ページは逐次取得して、負荷とログの追跡を安定させる。
    for (const detailUrl of detailLinks) {
      try {
        const detailHtml = await fetchText(detailUrl, {
          acceptEncoding: "identity",
          encoding: "utf-8",
        });
        const event = extractEventFromDetail(detailHtml, detailUrl);
        if (!event) {
          excludedInvalid += 1;
          continue;
        }
        if (!isDateInRange(event.date_from, range)) {
          excludedInvalid += 1;
          continue;
        }
        events.push(event);
      } catch (error) {
        detailFetchFailed += 1;
        console.warn(`詳細取得に失敗: ${detailUrl} (${error.message})`);
      }
    }

    const dedupedEvents = dedupeEventsBySourceUrl(events);

    console.log(`[fetch] list_links: ${listLinks}`);
    console.log(`[fetch] detail_links_unique: ${detailLinksUnique}`);
    console.log(`[fetch] excluded_invalid: ${excludedInvalid}`);
    console.log(`[fetch] detail_fetch_failed: ${detailFetchFailed}`);
    console.log(`[fetch] events_built: ${dedupedEvents.length}`);
    console.log(`[fetch] output_path: ${OUTPUT_PATH}`);

    if (dedupedEvents.length === 0) {
      process.exit(1);
      return;
    }

    saveEventsFile(dedupedEvents);
  } catch (error) {
    console.error(`失敗: ${error.message}`);
    process.exit(1);
  }
}

main();
