// 香川県立ミュージアムのイベント一覧ページから
// リスト形式のイベント情報を抽出して JSON に保存するバッチ。
// 使い方: node scripts/fetch-kagawa_pref_museum.js

const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");

const ENTRY_URL = "https://www.pref.kagawa.lg.jp/kmuseum/kmuseum/event/07event/07event.html";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "kagawa_pref_museum.json");
const VENUE_ID = "kagawa_pref_museum";
const MONTH_RANGE = 7;

// HTML を取得する。HTTPエラーや明らかなエラーページはハード失敗とする。
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; event-navi-bot/1.0)",
          Accept: "text/html,application/xhtml+xml",
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} で失敗しました。`));
          response.resume();
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (!body) {
            reject(new Error("HTMLの取得結果が空でした。"));
            return;
          }

          const errorIndicators = ["Access Denied", "Forbidden", "Service Unavailable"];
          if (errorIndicators.some((indicator) => body.includes(indicator))) {
            reject(new Error("明らかなエラーページの可能性があります。"));
            return;
          }

          resolve(body);
        });
      }
    );

    request.on("error", (error) => {
      reject(error);
    });
  });
}

// HTMLエンティティを最低限デコードする。
function decodeHtmlEntities(text) {
  if (!text) return "";
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

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
    const html = await fetchHtml(ENTRY_URL);
    const blocks = extractEventBlocks(html);
    const currentYear = new Date().getFullYear();
    const { start, endExclusive } = buildTargetRange();
    const events = [];
    let dateFromCount = 0;

    for (const block of blocks) {
      const decoded = decodeHtmlEntities(block);
      const plainText = stripTags(decoded).replace(/\s+/g, " ").trim();
      const { title, url } = extractTitleAndUrl(decoded);
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

      const resolvedTitle = title || plainText;
      if (!resolvedTitle) {
        continue;
      }

      dateFromCount += 1;

      events.push({
        title: resolvedTitle,
        date_from: dateFrom,
        date_to: dateTo,
        source_url: toAbsoluteUrl(url, ENTRY_URL),
        tags: null,
      });
    }

    if (events.length === 0) {
      throw new Error("イベントが0件のため上書きしません。");
    }

    if (dateFromCount === 0) {
      throw new Error("date_from が1件も作成できませんでした。");
    }

    const today = formatDate(new Date());
    const data = {
      venue_id: VENUE_ID,
      last_success_at: today,
      events: events.sort((a, b) => a.date_from.localeCompare(b.date_from)),
    };

    applyTagsToEventsData(data, { overwrite: false });

    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    console.log(`完了: ${events.length} 件のイベントを保存しました。`);
  } catch (error) {
    console.error(`失敗: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
