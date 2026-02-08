// あかがねミュージアムのイベント一覧（?method=list）と詳細ページを解析し、
// docs/events/akagane-museum.json に保存するバッチ。
// 使い方: node scripts/fetch-akagane-museum-events.js

const path = require("path");
const { URL } = require("url");

// 共通 HTTP 取得ユーティリティ。
const { fetchText } = require("./lib/http");
// JSON 保存を共通化。
const { writeJsonPretty } = require("./lib/io");
// テキスト整形の共通関数。
const { decodeHtmlEntities, normalizeWhitespace, stripTagsWithLineBreaks, stripTags } = require("./lib/text");
// イベントの標準スキーマ生成。
const { createEvent, createRootStructure } = require("./lib/schema");
// 価格・問い合わせの正規化。
const { normalizePrice, normalizeContact } = require("./lib/event_fields");
// source_url 重複の除去。
const { dedupeEventsBySourceUrl } = require("./lib/dedupe");

const VENUE_ID = "akagane-museum";
const LIST_URL = "https://akaganemuseum.jp/event/?method=list";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "akagane-museum.json");
const DETAIL_CONCURRENCY = 3;

// Date から YYYY-MM-DD を返す。
function toIsoDateFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// YYYY年MM月DD日 を YYYY-MM-DD に変換する。
function toIsoDateFromJpDateText(text) {
  if (!text) return null;
  const normalized = text.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  const match = normalized.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return toIsoDateFromDate(date);
}

// テキスト中の最初の YYYY年MM月DD日 を抽出する（一覧用）。
function extractFirstJpDate(text) {
  if (!text) return null;
  const normalized = text.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  const match = normalized.match(/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/);
  if (!match) return null;
  return toIsoDateFromJpDateText(match[0]);
}

// タイトル文字列からノイズ（開催日など）を除去する。
function cleanTitle(text) {
  if (!text) return "";
  const decoded = decodeHtmlEntities(text);
  const noTags = stripTags(decoded);
  return normalizeWhitespace(noTags)
    .replace(/^(開催日|会期|日時)\s*[:：]?\s*/, "")
    .replace(/\s*開催日\s*[:：]?.*$/, "")
    .trim();
}

// href を絶対 URL に変換する。
function resolveUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch (error) {
    return null;
  }
}

// /event/ を含み、末尾が /event/ ではない詳細 URL のみ許可する。
function isTargetEventUrl(urlString) {
  if (!urlString) return false;
  try {
    const parsed = new URL(urlString);
    const pathname = parsed.pathname;
    if (!pathname.includes("/event/")) return false;
    if (pathname === "/event/" || pathname.endsWith("/event/")) return false;
    return /\/event\/event-[^/]+\/?$/.test(pathname);
  } catch (error) {
    return false;
  }
}

// ボタン文言しか含まないリンクタイトルは、イベント名として不適切なので除外する。
function isNoiseTitle(title) {
  if (!title) return true;
  const normalized = normalizeWhitespace(title).toLowerCase();
  return /^(詳細を見る|more|read\s*more|view\s*more)$/i.test(normalized);
}

// 一覧 HTML から「URL 起点」で候補イベントを抽出する。
// article/div/li などのコンテナ構造に依存せず、対象 URL の前後コンテキストから情報を拾う。
function extractEventCandidatesFromList(html) {
  const candidates = [];
  const seenUrls = new Set();

  // A: ページ全体から a[href] を順番に走査し、対象 URL のみ拾う。
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let anchorMatch;
  while ((anchorMatch = anchorRegex.exec(html)) !== null) {
    const absoluteUrl = resolveUrl(anchorMatch[1], LIST_URL);
    if (!absoluteUrl || !isTargetEventUrl(absoluteUrl) || seenUrls.has(absoluteUrl)) {
      continue;
    }

    // B: ヒット位置を中心に、前後のコンテキスト・ウィンドウを切り出す。
    const anchorStart = anchorMatch.index;
    const windowStart = Math.max(0, anchorStart - 500);
    const windowEnd = Math.min(html.length, anchorStart + anchorMatch[0].length + 1500);
    const contextWindowHtml = html.slice(windowStart, windowEnd);

    // C-1: タイトルは近傍 h3 を最優先し、なければリンク内テキストを使う。
    const h3Match = contextWindowHtml.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
    const rawTitle = h3Match ? h3Match[1] : anchorMatch[2];
    const title = cleanTitle(rawTitle);

    // D: 「詳細を見る」「MORE」などのノイズタイトルを除外する。
    if (isNoiseTitle(title)) {
      continue;
    }

    // C-2: 日付は「詳細ページが壊れていた場合のフェイルセーフ」専用として保持する。
    //      一覧の日付は誤紐付けが起きやすいため、この段階では event の date_from には採用しない。
    const contextText = normalizeWhitespace(decodeHtmlEntities(stripTagsWithLineBreaks(contextWindowHtml)));
    const fallbackDateFrom = extractFirstJpDate(contextText);

    // D: 同一 URL は最初に見つかった 1 件だけ採用する。
    seenUrls.add(absoluteUrl);
    candidates.push({
      source_url: absoluteUrl,
      title,
      fallback_date_from: fallbackDateFrom,
    });
  }

  return candidates;
}

// ラベルを含む table.eventTable から対応する td テキストを抽出する。
function extractFieldFromEventTable(detailHtml, labelKeyword) {
  const tableMatch = detailHtml.match(/<table\b[^>]*class=["'][^"']*eventTable[^"']*["'][^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return "";

  const tableHtml = tableMatch[1];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const rowHtml = rowMatch[1];
    const thMatch = rowHtml.match(/<th\b[^>]*>([\s\S]*?)<\/th>/i);
    const tdMatch = rowHtml.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i);
    if (!thMatch || !tdMatch) continue;

    const thText = normalizeWhitespace(decodeHtmlEntities(stripTagsWithLineBreaks(thMatch[1])));
    if (!thText.includes(labelKeyword)) continue;

    return normalizeWhitespace(decodeHtmlEntities(stripTagsWithLineBreaks(tdMatch[1])));
  }

  return "";
}

// 詳細ページから最初に見つかる HH:mm を抽出する。
function extractTimeStart(text) {
  if (!text) return null;
  const normalized = text
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ":");
  const match = normalized.match(/(\d{1,2}:\d{2})/);
  if (!match) return null;
  const [hourStr, minStr] = match[1].split(":");
  const hour = Number(hourStr);
  const minute = Number(minStr);
  if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// 詳細ページ本文（.entry-content）を整形して取得する。
function extractDescription(detailHtml, location) {
  const contentMatch = detailHtml.match(/<[^>]*class=["'][^"']*entry-content[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
  const contentText = contentMatch
    ? normalizeWhitespace(decodeHtmlEntities(stripTagsWithLineBreaks(contentMatch[1])))
    : "";

  // 要件に従い、description 先頭に会場情報を付与する。
  const locationPrefix = location ? `会場: ${location}` : "";
  if (locationPrefix && contentText) return `${locationPrefix}\n${contentText}`;
  if (locationPrefix) return locationPrefix;
  return contentText || null;
}

// 詳細ページから画像 URL を抽出する。
function extractImageUrl(detailHtml, detailUrl) {
  const primaryMatch = detailHtml.match(
    /<[^>]*class=["'][^"']*mec-events-event-image[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*src=["']([^"']+)["'][^>]*>/i
  );
  const fallbackMatch = detailHtml.match(/<article\b[^>]*>[\s\S]*?<img\b[^>]*src=["']([^"']+)["'][^>]*>/i);
  const src = (primaryMatch && primaryMatch[1]) || (fallbackMatch && fallbackMatch[1]) || "";
  if (!src) return null;
  return resolveUrl(src, detailUrl);
}

// 詳細ページを解析して、候補イベントへ詳細情報を合成する。
function mergeDetailFields(candidate, detailHtml) {
  // eventTable の有無を先に判定し、フェイルセーフ利用条件を明確にする。
  const hasEventTable = /<table\b[^>]*class=["'][^"']*eventTable[^"']*["'][^>]*>/i.test(detailHtml);
  const dateCell = extractFieldFromEventTable(detailHtml, "開催日");
  const timeCell = extractFieldFromEventTable(detailHtml, "時間");
  const locationCell = extractFieldFromEventTable(detailHtml, "会場");
  const priceCell = extractFieldFromEventTable(detailHtml, "料金");
  const contactCell = extractFieldFromEventTable(detailHtml, "お問合せ");

  // 開催日は「詳細ページ eventTable の開催日セル」を唯一の正とする。
  // 例: 2026年01月17日（土） 〜 2026年03月01日（日）
  // -> 先頭を date_from、末尾を date_to として扱う。
  let dateFrom = null;
  let dateTo = null;
  if (dateCell) {
    const normalizedDateCell = dateCell.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
    const dateTexts = normalizedDateCell.match(/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g);
    if (dateTexts && dateTexts.length >= 1) {
      dateFrom = toIsoDateFromJpDateText(dateTexts[0]);
      dateTo = toIsoDateFromJpDateText(dateTexts[dateTexts.length - 1]);
    }
  }

  // フェイルセーフ: eventTable が存在しない、または開催日セルが欠落している場合のみ
  // 一覧近傍から取得した fallback_date_from を利用する。
  if ((!hasEventTable || !dateCell) && !dateFrom) {
    dateFrom = candidate.fallback_date_from || null;
  }

  // date_to が取れない場合は単日イベントとして date_from を補完する。
  if (!dateTo && dateFrom) {
    dateTo = dateFrom;
  }

  const detailTitle = (() => {
    const h1Match = detailHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    if (!h1Match) return "";
    return cleanTitle(h1Match[1]);
  })();

  const title = candidate.title || detailTitle;
  const location = locationCell || null;

  if (!title || !dateFrom) {
    return null;
  }

  return createEvent({
    title,
    date_from: dateFrom,
    date_to: dateTo,
    time_start: extractTimeStart(timeCell),
    description: extractDescription(detailHtml, location),
    image_url: extractImageUrl(detailHtml, candidate.source_url),
    price: normalizePrice(priceCell),
    contact: normalizeContact(contactCell),
    source_url: candidate.source_url,
  });
}

// 簡易並列実行ユーティリティ（外部依存を増やさないため自前実装）。
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const index = currentIndex;
      currentIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.max(1, limit) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  try {
    const listHtml = await fetchText(LIST_URL, {
      acceptEncoding: "identity",
      encoding: "utf-8",
    });

    const candidates = extractEventCandidatesFromList(listHtml);
    if (candidates.length === 0) {
      throw new Error("一覧からイベント候補を抽出できませんでした。HTML 構造の変更を確認してください。");
    }

    const detailedEvents = await mapWithConcurrency(candidates, DETAIL_CONCURRENCY, async (candidate) => {
      try {
        const detailHtml = await fetchText(candidate.source_url, {
          acceptEncoding: "identity",
          encoding: "utf-8",
        });
        return mergeDetailFields(candidate, detailHtml);
      } catch (error) {
        console.warn(`[warn] 詳細取得に失敗: ${candidate.source_url} (${error.message})`);
        return null;
      }
    });

    const events = dedupeEventsBySourceUrl(detailedEvents.filter(Boolean));
    if (events.length === 0) {
      throw new Error("詳細解析後のイベント件数が 0 件です。保存を中止します。");
    }

    const output = createRootStructure(VENUE_ID, events);
    writeJsonPretty(OUTPUT_PATH, output);
    console.log(`[success] ${events.length} 件を ${OUTPUT_PATH} に保存しました。`);
  } catch (error) {
    console.error(`[fatal] ${error.message}`);
    process.exit(1);
  }
}

main();
