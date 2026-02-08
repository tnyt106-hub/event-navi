// 香川県立ミュージアムのイベント一覧ページから
// リスト形式のイベント情報を抽出して JSON に保存するバッチ。
// 使い方: node scripts/fetch-kagawa_pref_museum.js

const path = require("path");
const { URL } = require("url");

const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");
// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("./lib/http");
// JSON 保存処理を共通化する。
const { finalizeAndSaveEvents } = require("./lib/fetch_output");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities } = require("./lib/text");

const ENTRY_URL = "https://www.pref.kagawa.lg.jp/kmuseum/kmuseum/event/07event/07event.html";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "kagawa_pref_museum.json");
const VENUE_ID = "kagawa_pref_museum";
const MONTH_RANGE = 7;

// タグを落としてプレーンテキスト化する。
function stripTags(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "");
}

// 全角数字を半角に変換し、日付の区切り記号を正規化する。
function normalizeDateText(text) {
  if (!text) return "";
  const halfWidth = text.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  return halfWidth
    .replace(/[／]/g, "/")
    .replace(/[．]/g, ".")
    .replace(/[〜～]/g, "~")
    .replace(/[－–—]/g, "-")
    .replace(/[、，]/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

// 年月日を ISO 形式の文字列にする。
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// 年月日が妥当な日付かチェックする。
function buildDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

// 今月の月初から +7か月の排他終点を作る。
function buildTargetRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const endExclusive = new Date(start);
  endExclusive.setMonth(endExclusive.getMonth() + MONTH_RANGE);
  return { start, endExclusive };
}

// HTML内のイベント候補ブロックを抽出する。
function extractEventBlocks(html) {
  const blocks = [];
  const listMatches = html.match(/<li[\s\S]*?<\/li>/g);
  if (listMatches && listMatches.length > 0) {
    blocks.push(...listMatches);
  }

  const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/g);
  if (rowMatches && rowMatches.length > 0) {
    blocks.push(...rowMatches);
  }

  const sectionMatches = html.match(/<div[^>]*class=["'][^"']*event[^"']*["'][\s\S]*?<\/div>/g);
  if (sectionMatches && sectionMatches.length > 0) {
    blocks.push(...sectionMatches);
  }

  return blocks;
}

// イベントブロックからタイトルとリンクを抽出する。
function extractTitleAndUrl(blockHtml) {
  const anchorMatch = blockHtml.match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  const url = anchorMatch ? anchorMatch[1].trim() : "";
  const title = anchorMatch ? stripTags(anchorMatch[2]).replace(/\s+/g, " ").trim() : "";

  // イベント詳細ページ以外のリンクはノイズなので除外する。
  // （例: ページ内アンカー、カテゴリリンク、トップページなど）
  if (!url) {
    return { title: "", url: "" };
  }
  const isEventUrl = /\/kmuseum\/kmuseum\/event\/07event\//.test(url);
  const isExcluded =
    url.startsWith("#") ||
    /^mailto:|^tel:/i.test(url) ||
    /\/07event\/07event\.html$/.test(url);
  if (!isEventUrl || isExcluded) {
    return { title: "", url: "" };
  }

  return { title, url };
}

// 日付文字列から年月日の配列を抽出する。
function extractDateParts(text) {
  const normalized = normalizeDateText(text);
  const results = [];
  let masked = normalized;

  for (const match of normalized.matchAll(/(\d{4})\s*[年/.]\s*(\d{1,2})\s*[月/.]\s*(\d{1,2})\s*日?/g)) {
    results.push({
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    });

    // 年付きの部分をマスクして、年なしの重複抽出を避ける。
    if (match.index !== undefined) {
      const mask = " ".repeat(match[0].length);
      masked = masked.slice(0, match.index) + mask + masked.slice(match.index + match[0].length);
    }
  }

  for (const match of masked.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    results.push({
      year: null,
      month: Number(match[1]),
      day: Number(match[2]),
    });
  }

  return results;
}

// 日付情報を正規化して開始日・終了日を返す。
function parseDateRange(text, currentYear) {
  const normalized = normalizeDateText(text);
  const dateParts = extractDateParts(normalized);

  if (dateParts.length === 0) {
    return null;
  }

  const hasRangeSeparator = /~|-/.test(normalized);

  const resolveDate = (part, fallbackYear) => {
    const year = part.year || fallbackYear || currentYear;
    return buildDate(year, part.month, part.day);
  };

  if (hasRangeSeparator && dateParts.length >= 2) {
    const startYear = dateParts[0].year || currentYear;
    const startDate = resolveDate(dateParts[0], startYear);
    const endDate = resolveDate(dateParts[1], startYear);
    if (!startDate || !endDate) return null;
    // 終了日が開始日より前なら単発扱いに倒して安全側にする。
    if (endDate < startDate) {
      console.warn("日付レンジが逆転しているため単発扱いに補正します。");
      return { startDate, endDate: startDate };
    }
    return { startDate, endDate };
  }

  // 列挙の場合は開始日だけを採用する。
  const startDate = resolveDate(dateParts[0]);
  if (!startDate) return null;
  return { startDate, endDate: startDate };
}

// 相対URLを絶対URLに変換する。
function toAbsoluteUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch (error) {
    return null;
  }
}

// メイン処理。
async function main() {
  try {
    const html = await fetchText(ENTRY_URL, {
      acceptEncoding: "identity",
      encoding: "utf-8",
    });
    const blocks = extractEventBlocks(html);
    const currentYear = new Date().getFullYear();
    const { start, endExclusive } = buildTargetRange();
    const events = [];
    let dateFromCount = 0;

    for (const block of blocks) {
      const decoded = decodeHtmlEntities(block);
      const plainText = stripTags(decoded).replace(/\s+/g, " ").trim();
      const { title, url } = extractTitleAndUrl(decoded);
      // source_url が無いものはイベント扱いしない。
      if (!url) {
        continue;
      }
      const parsed = parseDateRange(plainText, currentYear);

      if (!parsed) {
        continue;
      }

      const { startDate, endDate } = parsed;
      const dateFrom = formatDate(startDate);
      const dateTo = formatDate(endDate);

      if (startDate < start || startDate >= endExclusive) {
        continue;
      }

      // タイトルはリンクテキストのみ採用する。
      const resolvedTitle = title;
      if (!resolvedTitle) {
        continue;
      }

      dateFromCount += 1;

      // source_url が null になる場合はログを残してスキップする。
      const sourceUrl = toAbsoluteUrl(url, ENTRY_URL);
      if (!sourceUrl) {
        console.warn("source_url が null になったためイベントをスキップします。");
        continue;
      }

      events.push({
        title: resolvedTitle,
        date_from: dateFrom,
        date_to: dateTo,
        source_url: sourceUrl,
        tags: null,
      });
    }

    if (events.length === 0) {
      throw new Error("イベントが0件のため上書きしません。");
    }

    if (dateFromCount === 0) {
      throw new Error("date_from が1件も作成できませんでした。");
    }

    finalizeAndSaveEvents({
      venueId: VENUE_ID,
      outputPath: OUTPUT_PATH,
      events: events.sort((a, b) => a.date_from.localeCompare(b.date_from)),
      lastSuccessAt: formatDate(new Date()),
      beforeWrite(data) {
        applyTagsToEventsData(data, { overwrite: false });
      },
    });
  } catch (error) {
    console.error(`失敗: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
