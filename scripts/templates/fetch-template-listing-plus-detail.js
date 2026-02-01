// 一覧 → 詳細ページの2段構成施設向けスクレイピングテンプレート。
// 使い方: node scripts/templates/fetch-template-listing-plus-detail.js

const path = require("path");
const { URL } = require("url");

// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("../lib/http");
// JSON 保存処理を共通化する。
const { writeJsonPretty } = require("../lib/io");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities, normalizeWhitespace, stripTagsWithLineBreaks } = require("../lib/text");

// TODO: 施設ID、一覧URL、出力先を施設ごとに埋める。
const VENUE_ID = "your_venue_id";
const LIST_URL = "https://example.com/events";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", `${VENUE_ID}.json`);

// 日付文字列を ISO 形式 (YYYY-MM-DD) に変換する。
function toIsoDate(year, month, day) {
  const yyyy = String(year);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// テキストから日付を抽出する（必要に応じてパターンを追加する）。
function extractDate(text) {
  const normalized = normalizeWhitespace(text);
  const match = /([0-9]{4})[./年]([0-9]{1,2})[./月]([0-9]{1,2})日?/.exec(normalized);
  if (!match) return null;
  return toIsoDate(match[1], match[2], match[3]);
}

// body 用のテキストを整形する（改行単位でトリムし、最大 5000 文字に収める）。
function formatBody(text) {
  if (!text) return "";
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let result = lines.join("\n").trim();
  const maxLength = 5000;
  if (result.length > maxLength) {
    result = `${result.slice(0, maxLength - 1)}…`;
  }
  return result;
}

// body を入れるべきか判定する。
function shouldIncludeBody({ openTime, startTime, endTime, price, contact }) {
  return !openTime && !startTime && !endTime && !price && !contact;
}

// 一覧 HTML から詳細ページのリンク一覧を抽出する。
// TODO: 施設の HTML 構造に合わせて抽出ロジックを調整する。
function extractDetailLinks(html) {
  const links = [];
  const anchorRegex = /<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    const href = match[1];
    const text = normalizeWhitespace(decodeHtmlEntities(stripTagsWithLineBreaks(match[2])));
    if (!href || !text) {
      continue;
    }
    links.push({ href, text });
  }

  return links;
}

// 詳細 HTML からイベント情報を抽出する。
// TODO: 施設の HTML 構造に合わせて抽出ロジックを調整する。
function extractEventFromDetail(detailHtml, detailUrl) {
  const plainText = normalizeWhitespace(decodeHtmlEntities(stripTagsWithLineBreaks(detailHtml)));
  const title = plainText.split(" ")[0] || "";
  const dateFrom = extractDate(plainText);

  // TODO: 可能であれば構造化項目を抽出する。
  const openTime = null;
  const startTime = null;
  const endTime = null;
  const price = null;
  const contact = null;

  // TODO: body を使う場合は詳細説明テキストを抽出する。
  const bodyText = "";

  if (!title || !dateFrom) {
    return null;
  }

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

  if (bodyText && shouldIncludeBody({ openTime, startTime, endTime, price, contact })) {
    const formattedBody = formatBody(bodyText);
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
  let detailFetchSuccess = 0;
  let detailFetchFailed = 0;
  let eventsBuilt = 0;
  let excludedInvalid = 0;

  try {
    const listHtml = await fetchText(LIST_URL, {
      acceptEncoding: "identity",
      encoding: "utf-8",
    });

    const detailLinks = extractDetailLinks(listHtml);
    listLinks = detailLinks.length;

    const events = [];

    for (const link of detailLinks) {
      let detailUrl = "";
      try {
        detailUrl = new URL(link.href, LIST_URL).toString();
      } catch (error) {
        detailFetchFailed += 1;
        console.warn(`詳細URLが不正のため除外: ${link.href}`);
        continue;
      }

      try {
        const detailHtml = await fetchText(detailUrl, {
          acceptEncoding: "identity",
          encoding: "utf-8",
        });
        detailFetchSuccess += 1;
        const event = extractEventFromDetail(detailHtml, detailUrl);
        if (!event) {
          excludedInvalid += 1;
          continue;
        }
        events.push(event);
      } catch (error) {
        detailFetchFailed += 1;
        console.warn(`詳細取得に失敗: ${detailUrl} (${error.message})`);
      }
    }

    eventsBuilt = events.length;

    console.log(`[fetch] list_links: ${listLinks}`);
    console.log(`[fetch] detail_fetch_success: ${detailFetchSuccess}`);
    console.log(`[fetch] detail_fetch_failed: ${detailFetchFailed}`);
    console.log(`[fetch] excluded_invalid: ${excludedInvalid}`);
    console.log(`[fetch] events_built: ${eventsBuilt}`);
    console.log(`[fetch] output_path: ${OUTPUT_PATH}`);

    if (eventsBuilt === 0) {
      process.exit(1);
      return;
    }

    saveEventsFile(events);
  } catch (error) {
    console.error(`失敗: ${error.message}`);
    process.exit(1);
  }
}

main();
