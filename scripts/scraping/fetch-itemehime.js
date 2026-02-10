// itemehime のイベント一覧ページから詳細ページをたどって
// イベント情報を JSON に保存するバッチ。
// 使い方: node scripts/scraping/fetch-itemehime.js

const path = require("path");
const { URL } = require("url");

// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("../lib/http");
// JSON 保存処理を共通化する。
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { handleCliFatalError } = require("../lib/cli_error");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities, normalizeWhitespace, stripTags } = require("../lib/text");
// イベント詳細 URL 判定の共通ヘルパー。
const { isEventDetailUrl } = require("../lib/event_url");
// source_url の重複を排除するヘルパー。
const { dedupeEventsBySourceUrl } = require("../lib/dedupe");
const { mapWithConcurrencyLimit, sleep } = require("../lib/concurrency");

const VENUE_ID = "itemehime";
const DETAIL_CONCURRENCY = 3;
const DETAIL_JITTER_MS = 250;
const LIST_URL = "https://itemehime.com/event/";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", "itemehime.json");

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

// <h3 class="h3_title01"> の innerText をタイトルとして抽出する。
function extractTitleFromDetailHtml(detailHtml) {
  if (!detailHtml) return "";
  const match = /<h3 class="h3_title01[^"]*">([\s\S]*?)<\/h3>/i.exec(detailHtml);
  if (!match) return "";
  return normalizeWhitespace(decodeHtmlEntities(stripTags(match[1])));
}

// Map から「イベント開催期間」を取り出して日付範囲を作る。
function extractDateRangeFromMap(detailMap) {
  const dateText = detailMap.get("イベント開催期間") || detailMap.get("開催期間");
  if (!dateText) return null;

  const normalized = normalizeJapaneseText(normalizeWhitespace(dateText));

  // まず年あり日付を拾う
  const ymd = [...normalized.matchAll(/(\d{4})年(\d{1,2})月(\d{1,2})日/g)];
  if (ymd.length === 0) return null;

  const start = ymd[0];
  const startYear = Number(start[1]);
  const startIso = toIsoDate(start[1], start[2], start[3]);

  // 年ありが複数あるなら最後を終了日にする
  if (ymd.length >= 2) {
    const end = ymd[ymd.length - 1];
    return {
      date_from: startIso,
      date_to: toIsoDate(end[1], end[2], end[3]),
    };
  }

  // 年ありが1つだけの場合：後続の「M月D日」を終了日候補として拾う
  const tail = normalized.slice((start.index ?? 0) + start[0].length);
  const md = /(\d{1,2})月(\d{1,2})日/.exec(tail);

  if (!md) {
    // 終了日が書かれていない（単日）扱い
    return { date_from: startIso, date_to: startIso };
  }

  let endYear = startYear;
  let endIso = toIsoDate(String(endYear), md[1], md[2]);

  // 念のため逆転補正（年跨ぎを安全に処理）
  if (new Date(`${endIso}T00:00:00+09:00`) < new Date(`${startIso}T00:00:00+09:00`)) {
    endYear += 1;
    endIso = toIsoDate(String(endYear), md[1], md[2]);
  }

  return { date_from: startIso, date_to: endIso };
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
function shouldIncludeBody({ startTime, endTime, price, contact }) {
  return !startTime && !endTime && !price && !contact;
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
  // dl_postevent の dt/dd を HTML 構造ベースで読み取り、マップを作る。
  const detailMap = buildDetailMap(detailHtml);

  // タイトルは h3.h3_title01 の innerText を使う。
  const title = extractTitleFromDetailHtml(detailHtml);
  // 詳細ページの「イベント開催期間」から日付範囲を取得する。
  const range = extractDateRangeFromMap(detailMap);

  if (!title || !range) {
    return null;
  }

  // 「時間」から HH:MM を抽出し、先頭と末尾を開始/終了時刻として使う。
  const timeText = detailMap.get("時間") || "";
  const timeMatches = [...normalizeJapaneseText(timeText).matchAll(/(\d{1,2}):(\d{2})/g)];
  const startTime = timeMatches[0] ? parseTimeCandidate(timeMatches[0][0]) : null;
  const endTime =
    timeMatches.length >= 2 ? parseTimeCandidate(timeMatches[timeMatches.length - 1][0]) : null;

  // 入場料・問い合わせは対応する dd をそのまま使う。
  const price = detailMap.get("入場料") || "";
  const contact = detailMap.get("お問合せ先") || "";

  const event = {
    title,
    date_from: range.date_from,
    date_to: range.date_to,
    source_url: detailUrl,
  };

  if (startTime) event.start_time = startTime;
  if (endTime) event.end_time = endTime;
  if (price) event.price = price;
  if (contact) event.contact = contact;

  if (shouldIncludeBody({ startTime, endTime, price, contact })) {
    const rawBodyText = decodeHtmlEntities(stripTags(detailHtml));
    const formattedBody = formatBody(rawBodyText);
    if (formattedBody) {
      event.body = formattedBody;
    }
  }

  return event;
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

    const range = buildJstRange();

    // 詳細ページは同時数制限付きで並列取得し、先方負荷を抑えながら高速化する。
    const detailResults = await mapWithConcurrencyLimit(detailLinks, DETAIL_CONCURRENCY, async (detailUrl) => {
      // アクセスの瞬間集中を避けるため、各リクエスト前にジッターを入れる。
      await sleep(Math.floor(Math.random() * DETAIL_JITTER_MS));
      try {
        const detailHtml = await fetchText(detailUrl, {
          acceptEncoding: "identity",
          encoding: "utf-8",
        });
        const event = extractEventFromDetail(detailHtml, detailUrl);
        return { detailUrl, event, error: null };
      } catch (error) {
        return { detailUrl, event: null, error };
      }
    });

    const events = [];
    detailResults.forEach((result) => {
      if (result.error) {
        detailFetchFailed += 1;
        const message = result.error instanceof Error ? result.error.message : String(result.error);
        console.warn(`詳細取得に失敗: ${result.detailUrl} (${message})`);
        return;
      }

      if (!result.event) {
        excludedInvalid += 1;
        return;
      }

      if (!isDateInRange(result.event.date_from, range)) {
        excludedInvalid += 1;
        return;
      }

      events.push(result.event);
    });

    const dedupedEvents = dedupeEventsBySourceUrl(events);

    console.log(`[fetch] list_links: ${listLinks}`);
    console.log(`[fetch] detail_links_unique: ${detailLinksUnique}`);
    console.log(`[fetch] detail_concurrency: ${DETAIL_CONCURRENCY}`);
    console.log(`[fetch] excluded_invalid: ${excludedInvalid}`);
    console.log(`[fetch] detail_fetch_failed: ${detailFetchFailed}`);
    console.log(`[fetch] events_built: ${dedupedEvents.length}`);
    console.log(`[fetch] output_path: ${OUTPUT_PATH}`);

    if (dedupedEvents.length === 0) {
      throw new Error("events_built が 0 件のため中断します。");
    }

    saveEventsFile(dedupedEvents);
  } catch (error) {
    handleCliFatalError(error, { prefix: "失敗" });
  }
}

if (require.main === module) {
  main();
}
