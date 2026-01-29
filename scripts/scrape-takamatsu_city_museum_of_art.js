// 高松市美術館の「展覧会・イベント（会期型中心）」ページから、
// 展覧会の会期情報のみを抽出して JSON に保存するバッチ。
// 使い方: node scripts/scrape-takamatsu_city_museum_of_art.js

const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");

const ENTRY_URL = "https://www.city.takamatsu.kagawa.jp/museum/takamatsu/event/index.html";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "takamatsu_city_museum_of_art.json");
const VENUE_ID = "takamatsu_city_museum_of_art";
const VENUE_NAME = "高松市美術館";

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

// スクリプトやスタイルなど、抽出対象外の要素を削除する。
function removeNoisyTags(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

// テキストを正規化して読みやすくする。
function normalizeText(text) {
  return decodeHtmlEntities(stripTags(text)).replace(/\s+/g, " ").trim();
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
    .replace(/[（(][^）)]*[）)]/g, " ") // 曜日や注記を除去する。
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

// HTML内のイベント候補ブロックを抽出する。
function extractEventBlocks(html) {
  const cleaned = removeNoisyTags(html);
  const blocks = [];
  const selectors = [
    /<article\b[\s\S]*?<\/article>/gi,
    /<section\b[^>]*class=["'][^"']*(?:event|exhibition|exhibit|tenji|tenran|展示|展覧会)[^"']*["'][\s\S]*?<\/section>/gi,
    /<div\b[^>]*class=["'][^"']*(?:event|exhibition|exhibit|tenji|tenran|展示|展覧会)[^"']*["'][\s\S]*?<\/div>/gi,
    /<li\b[^>]*class=["'][^"']*(?:event|exhibition|exhibit|tenji|tenran|展示|展覧会)[^"']*["'][\s\S]*?<\/li>/gi,
  ];

  for (const selector of selectors) {
    const matches = cleaned.match(selector);
    if (matches && matches.length > 0) {
      blocks.push(...matches);
    }
  }

  if (blocks.length > 0) {
    return blocks;
  }

  // クラスが取得できない場合でも、年付き日付が含まれる <li> を候補にする。
  const listMatches = cleaned.match(/<li\b[\s\S]*?<\/li>/gi) || [];
  const dateIndicator = /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/;
  return listMatches.filter((block) => dateIndicator.test(stripTags(block)));
}

// イベントブロックからタイトル候補を抽出する。
function extractTitle(blockHtml) {
  const headingMatch = blockHtml.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
  if (headingMatch) {
    return normalizeText(headingMatch[1]);
  }

  const titleClassMatch = blockHtml.match(
    /<[^>]*class=["'][^"']*(?:title|ttl|heading|name)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i
  );
  if (titleClassMatch) {
    return normalizeText(titleClassMatch[1]);
  }

  const anchorMatch = blockHtml.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
  if (anchorMatch) {
    return normalizeText(anchorMatch[1]);
  }

  return "";
}

// ブロック内から詳細ページの URL を抽出する。
function extractSourceUrl(blockHtml) {
  const anchorMatch = blockHtml.match(/<a[^>]*href=["']([^"']+)["'][^>]*>/i);
  const href = anchorMatch ? anchorMatch[1].trim() : "";
  if (!href) {
    return ENTRY_URL;
  }

  try {
    return new URL(href, ENTRY_URL).toString();
  } catch (error) {
    return ENTRY_URL;
  }
}

// 日付テキストから開始日・終了日を取得する。
function parseDateRange(text) {
  const normalized = normalizeDateText(stripTags(text));
  const matches = [...normalized.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)];

  if (matches.length === 0) {
    return null;
  }

  const toDate = (match) => buildDate(Number(match[1]), Number(match[2]), Number(match[3]));

  if (matches.length === 1) {
    const onlyDate = toDate(matches[0]);
    if (!onlyDate) return null;
    return { start: onlyDate, end: onlyDate };
  }

  const first = matches[0];
  const second = matches[1];
  if (first.index === undefined || second.index === undefined) {
    return null;
  }

  const separatorSegment = normalized.slice(first.index + first[0].length, second.index);
  const hasRangeSeparator = /(~|-|から|まで)/.test(separatorSegment);
  if (!hasRangeSeparator) {
    return null;
  }

  const startDate = toDate(first);
  const endDate = toDate(second);
  if (!startDate || !endDate) {
    return null;
  }
  if (startDate > endDate) {
    return null;
  }

  return { start: startDate, end: endDate };
}

async function main() {
  const html = await fetchHtml(ENTRY_URL);
  const blocks = extractEventBlocks(html);

  if (blocks.length === 0) {
    console.error(`[${VENUE_ID}] イベント候補ブロックが見つかりません。`);
    process.exit(1);
    return;
  }

  const events = [];
  let excludedCount = 0;

  for (const block of blocks) {
    const title = extractTitle(block);
    if (!title || title.length < 2) {
      excludedCount += 1;
      continue;
    }

    const dateRange = parseDateRange(block);
    if (!dateRange) {
      excludedCount += 1;
      continue;
    }

    const sourceUrl = extractSourceUrl(block);
    events.push({
      title,
      date_from: formatDate(dateRange.start),
      date_to: formatDate(dateRange.end),
      source_url: sourceUrl,
    });
  }

  if (events.length === 0) {
    console.error(`[${VENUE_ID}] 抽出できた events が 0 件です。`);
    process.exit(1);
    return;
  }

  const data = {
    venue_id: VENUE_ID,
    venue_name: VENUE_NAME,
    events,
  };

  applyTagsToEventsData(data, { overwrite: false });

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`[${VENUE_ID}] blocks=${blocks.length}, events=${events.length}, excluded=${excludedCount}`);
}

main().catch((error) => {
  console.error(`[${VENUE_ID}] 失敗: ${error?.message || error}`);
  process.exit(1);
});
