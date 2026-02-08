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
const { handleCliFatalError } = require("./lib/cli_error");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities, stripTagsCompact } = require("./lib/text");
const {
  normalizeJapaneseDateText,
  extractDatePartsFromJapaneseText,
  buildLocalDate,
  formatIsoDateFromLocalDate,
} = require("./lib/date");

const ENTRY_URL = "https://www.pref.kagawa.lg.jp/kmuseum/kmuseum/event/07event/07event.html";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "kagawa_pref_museum.json");
const VENUE_ID = "kagawa_pref_museum";
const MONTH_RANGE = 7;

// 全角数字を半角に変換し、日付の区切り記号を正規化する。
// 共通処理へ委譲し、施設ごとの差分（この施設ではカンマ正規化が必要）だけオプションで指定する。
function normalizeDateText(text) {
  return normalizeJapaneseDateText(text, { normalizeComma: true });
}

// 年月日を ISO 形式の文字列にする。

function formatDate(date) {
  return formatIsoDateFromLocalDate(date);
}

// 年月日が妥当な日付かチェックする。

function buildDate(year, month, day) {
  return buildLocalDate(year, month, day);
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
  const title = anchorMatch ? stripTagsCompact(anchorMatch[2]).replace(/\s+/g, " ").trim() : "";

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
  // 既存の抽出順・抽出対象を変えないため、共通関数を同等オプションで呼び出す。
  return extractDatePartsFromJapaneseText(normalizeDateText(text), {
    allowYearlessMonthDay: true,
  });
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
      const plainText = stripTagsCompact(decoded).replace(/\s+/g, " ").trim();
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
    handleCliFatalError(error, { prefix: "失敗" });
  }
}

if (require.main === module) {
  main();
}
