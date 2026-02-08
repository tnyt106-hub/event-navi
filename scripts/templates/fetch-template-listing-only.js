// 一覧ページのみで完結する施設向けのスクレイピングテンプレート。
// 使い方: node scripts/templates/fetch-template-listing-only.js

const path = require("path");
const { URL } = require("url");

// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("../lib/http");
// JSON 保存処理と検証を共通化する。
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
// CLI エラー終了コードを共通化する。
const { handleCliFatalError } = require("../lib/cli_error");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities, normalizeWhitespace, stripTagsWithLineBreaks } = require("../lib/text");

// TODO: 施設ID、一覧URL、出力先を施設ごとに埋める。
const VENUE_ID = "your_venue_id";
const ENTRY_URL = "https://example.com/events";
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
    // 改行ごとに分割する。
    .split(/\r?\n/)
    // 各行の前後をトリムする。
    .map((line) => line.trim())
    // 空行は除外する。
    .filter((line) => line.length > 0);
  const maxLength = 5000;
  const resultLines = [];
  let totalLength = 0;

  for (const line of lines) {
    // 既存行がある場合は改行 1 文字を追加する。
    const separatorLength = resultLines.length > 0 ? 1 : 0;
    const nextLength = totalLength + separatorLength + line.length;

    if (nextLength > maxLength) {
      // 追加しない代わりに、直前の行へ … を付与する。
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

// 一覧 HTML から候補リンクを抽出する。
// TODO: 施設の HTML 構造に合わせて抽出ロジックを調整する。
function extractListItems(html) {
  const items = [];
  const anchorRegex = /<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    const href = match[1];
    const rawText = match[2];
    const text = normalizeWhitespace(decodeHtmlEntities(stripTagsWithLineBreaks(rawText)));
    if (!href || !text) {
      continue;
    }
    items.push({ href, text });
  }

  // TODO: 一覧に同一リンクが複数出る施設では、Set で重複除去する実装が必要になる可能性がある。
  return items;
}

// 候補リンクからイベント情報を作る。
function buildEvents(listItems) {
  const events = [];
  let excludedInvalid = 0;

  for (const item of listItems) {
    const title = item.text;
    const dateFrom = extractDate(item.text);
    // sourceUrl は後続の URL 解決で埋めるため、初期値は空文字にする。
    let sourceUrl = "";
    try {
      sourceUrl = new URL(item.href, ENTRY_URL).toString();
    } catch (error) {
      // URL として解釈できない場合は除外する。
      excludedInvalid += 1;
      continue;
    }

    // 必須項目が欠ける場合は除外する（安全側）。
    if (!title || !dateFrom || !sourceUrl) {
      excludedInvalid += 1;
      continue;
    }

    // TODO: 可能であれば構造化項目を抽出する。
    const openTime = null;
    const startTime = null;
    const endTime = null;
    const price = null;
    const contact = null;

    // TODO: body を使う場合は詳細説明テキストを抽出する。
    const bodyText = "";

    const event = {
      title,
      date_from: dateFrom,
      date_to: dateFrom,
      source_url: sourceUrl,
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

    events.push(event);
  }

  return { events, excludedInvalid };
}

// 成功時のみファイルを書き換える。
function saveEventsFile(events) {
  finalizeAndSaveEvents({
    venueId: VENUE_ID,
    outputPath: OUTPUT_PATH,
    events,
    // 一覧テンプレートでは title/date_from が構築できる前提で保存する。
    requireDateFrom: true,
  });
}

async function main() {
  let foundLinks = 0;
  let excludedInvalid = 0;
  let eventsBuilt = 0;

  try {
    const html = await fetchText(ENTRY_URL, {
      acceptEncoding: "identity",
      encoding: "utf-8",
    });

    const listItems = extractListItems(html);
    foundLinks = listItems.length;

    const result = buildEvents(listItems);
    excludedInvalid = result.excludedInvalid;
    eventsBuilt = result.events.length;

    console.log(`[fetch] found_links: ${foundLinks}`);
    console.log(`[fetch] excluded_invalid: ${excludedInvalid}`);
    console.log(`[fetch] events_built: ${eventsBuilt}`);
    console.log(`[fetch] output_path: ${OUTPUT_PATH}`);

    saveEventsFile(result.events);
  } catch (error) {
    handleCliFatalError(error, { prefix: `[${VENUE_ID}] 失敗` });
  }
}

main();
