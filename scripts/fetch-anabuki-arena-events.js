// あなぶきアリーナ香川のイベント一覧 (WordPress REST API) から
// 詳細ページを辿って開催日を抽出し、JSONに保存するバッチ。
// 使い方: node scripts/fetch-anabuki-arena-events.js

const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");

const REST_URL = "https://kagawa-arena.com/?rest_route=/wp/v2/event&_embed";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "anabuki_arena_kagawa.json");
const VENUE_ID = "anabuki_arena_kagawa";
const PER_PAGE = 10; // ブロック回避のため、無理に増やさない。
const MONTH_RANGE = 7;

// HTTP GET で JSON を取得し、レスポンスヘッダーも返す。
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; event-navi-bot/1.0)",
          Accept: "application/json",
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
            reject(new Error("JSONの取得結果が空でした。"));
            return;
          }

          try {
            const parsed = JSON.parse(body);
            resolve({ data: parsed, headers: response.headers });
          } catch (error) {
            reject(new Error("JSONのパースに失敗しました。"));
          }
        });
      }
    );

    request.on("error", (error) => {
      reject(error);
    });
  });
}

// 詳細ページの HTML を取得する。
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

// HTMLを行単位のテキスト配列に変換する。
function htmlToLines(html) {
  if (!html) return [];
  const normalized = decodeHtmlEntities(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]*>/g, "");

  return normalized
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// タイトルや本文に含まれる HTML をプレーンテキスト化する。
function htmlToText(html) {
  return stripTags(decodeHtmlEntities(html)).replace(/\s+/g, " ").trim();
}

// 年月日を ISO 形式の文字列にする。
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// 日付が有効かどうかをチェックする。
function buildDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

// 年が省略された日付を、対象期間内に収まる年へ補完する。
function resolveYearForMonthDay(month, day, startDate, endExclusive) {
  const baseYear = startDate.getFullYear();
  const candidates = [baseYear, baseYear + 1, baseYear - 1];

  for (const year of candidates) {
    const candidateDate = buildDate(year, month, day);
    if (!candidateDate) continue;
    if (candidateDate >= startDate && candidateDate < endExclusive) {
      return year;
    }
  }

  // 期間外しか無い場合は当年を返し、後続のフィルタで除外する。
  return baseYear;
}

// テキストから日付候補を抽出する。
function extractDateCandidates(lines, startDate, endExclusive) {
  const dates = [];
  const seen = new Set();

  const pushDate = (date) => {
    if (!date) return;
    const iso = formatDate(date);
    if (seen.has(iso)) return;
    seen.add(iso);
    dates.push(date);
  };

  for (const line of lines) {
    // 年が入っているパターン (2024/1/24, 2024.1.24, 2024年1月24日)
    for (const match of line.matchAll(/(\d{4})\s*[./年]\s*(\d{1,2})\s*[./月]\s*(\d{1,2})\s*日?/g)) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const date = buildDate(year, month, day);
      pushDate(date);
    }

    // m.d 形式 (1.24, 12/5)
    for (const match of line.matchAll(/(\d{1,2})\s*[./]\s*(\d{1,2})/g)) {
      const month = Number(match[1]);
      const day = Number(match[2]);
      if (month < 1 || month > 12) continue;
      const year = resolveYearForMonthDay(month, day, startDate, endExclusive);
      const date = buildDate(year, month, day);
      pushDate(date);
    }

    // m月d日 形式
    for (const match of line.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
      const month = Number(match[1]);
      const day = Number(match[2]);
      if (month < 1 || month > 12) continue;
      const year = resolveYearForMonthDay(month, day, startDate, endExclusive);
      const date = buildDate(year, month, day);
      pushDate(date);
    }
  }

  return dates;
}

// 行から開場・開演・終演の時刻を抽出する。
function extractTimes(lines) {
  let openTime = null;
  let startTime = null;
  let endTime = null;

  const normalizeTime = (text) => text.replace(/：/g, ":");

  for (const line of lines) {
    const openMatch = line.match(/開場\s*[:：]?\s*(\d{1,2}[：:]\d{2})/);
    if (openMatch && !openTime) {
      openTime = normalizeTime(openMatch[1]);
    }

    const startMatch = line.match(/開演\s*[:：]?\s*(\d{1,2}[：:]\d{2})/);
    if (startMatch && !startTime) {
      startTime = normalizeTime(startMatch[1]);
    }

    const beginMatch = line.match(/開始\s*[:：]?\s*(\d{1,2}[：:]\d{2})/);
    if (beginMatch && !startTime) {
      startTime = normalizeTime(beginMatch[1]);
    }

    const endMatch = line.match(/(終演|終了)\s*[:：]?\s*(\d{1,2}[：:]\d{2})/);
    if (endMatch && !endTime) {
      endTime = normalizeTime(endMatch[2]);
    }

    const rangeMatch = line.match(/(\d{1,2}[：:]\d{2})\s*[〜～\-–—]\s*(\d{1,2}[：:]\d{2})/);
    if (rangeMatch) {
      if (!startTime) startTime = normalizeTime(rangeMatch[1]);
      if (!endTime) endTime = normalizeTime(rangeMatch[2]);
    }
  }

  return { openTime, startTime, endTime };
}

// ラベル付き情報（料金・問い合わせ等）を抽出する。
function extractLabeledValue(lines, labels) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const label of labels) {
      if (line.includes(label)) {
        const cleaned = line.replace(label, "").replace(/[:：\-–—]/g, " ").trim();
        if (cleaned) {
          return cleaned.replace(/\s+/g, " ");
        }
        const nextLine = lines[i + 1];
        if (nextLine) {
          return nextLine.replace(/\s+/g, " ").trim();
        }
      }
    }
  }
  return null;
}

// 現在月の月初と、そこから7か月後の排他終点を作る。
function buildTargetRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const endExclusive = new Date(start);
  endExclusive.setMonth(endExclusive.getMonth() + MONTH_RANGE);
  return { start, endExclusive };
}

// 日付の配列から最小/最大を返す。
function findDateRange(dates) {
  if (!dates || dates.length === 0) return null;
  const sorted = [...dates].sort((a, b) => a - b);
  return { min: sorted[0], max: sorted[sorted.length - 1] };
}

// APIの投稿一覧をページングして取得する。
async function fetchAllPosts() {
  const posts = [];
  let currentPage = 1;
  let totalPages = 1;

  while (currentPage <= totalPages) {
    const url = new URL(REST_URL);
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(currentPage));

    const { data, headers } = await fetchJson(url.toString());
    if (!Array.isArray(data)) {
      throw new Error("APIのレスポンスが配列ではありません。");
    }

    if (currentPage === 1) {
      const headerPages = Number(headers["x-wp-totalpages"] || headers["X-WP-TotalPages"] || 1);
      totalPages = Number.isNaN(headerPages) ? 1 : headerPages;
    }

    posts.push(...data);
    currentPage += 1;
  }

  return posts;
}

// メイン処理。
async function main() {
  const { start, endExclusive } = buildTargetRange();
  const summary = {
    listCount: 0,
    detailCount: 0,
    adoptedCount: 0,
    missingDateCount: 0,
    filteredOutCount: 0,
    maxDateFrom: null,
  };

  let posts;
  try {
    posts = await fetchAllPosts();
  } catch (error) {
    console.error(`一覧API取得エラー: ${error.message}`);
    console.error("0件のため published を更新しません。");
    return;
  }

  const entries = posts.map((post) => ({
    title: htmlToText(post?.title?.rendered || ""),
    link: post?.link || "",
  }));

  summary.listCount = entries.length;
  console.log(`restroute_links 件数: ${summary.listCount}`);

  const events = [];
  const datesFound = [];

  for (const entry of entries) {
    if (!entry.link) {
      continue;
    }

    let html;
    try {
      html = await fetchHtml(entry.link);
    } catch (error) {
      console.warn(`詳細ページ取得失敗: ${entry.link} (${error.message})`);
      continue;
    }

    summary.detailCount += 1;

    const lines = htmlToLines(html);
    const dateCandidates = extractDateCandidates(lines, start, endExclusive);

    if (dateCandidates.length === 0) {
      summary.missingDateCount += 1;
      continue;
    }

    const range = findDateRange(dateCandidates);
    if (!range) {
      summary.missingDateCount += 1;
      continue;
    }

    const dateFrom = range.min;
    const dateTo = range.max;

    // 開始日ベースで期間フィルタをかける。
    if (dateFrom < start || dateFrom >= endExclusive) {
      summary.filteredOutCount += 1;
      continue;
    }

    const { openTime, startTime, endTime } = extractTimes(lines);
    const price = extractLabeledValue(lines, ["料金", "入場料", "参加費", "チケット"]);
    const contact = extractLabeledValue(lines, ["お問い合わせ", "問合せ", "問い合わせ", "連絡先", "電話", "TEL"]);

    const event = {
      title: entry.title || htmlToText(entry.link),
      date_from: formatDate(dateFrom),
      date_to: formatDate(dateTo),
      source_url: entry.link,
      open_time: openTime,
      start_time: startTime,
      end_time: endTime,
      price: price || null,
      contact: contact || null,
      source_type: "html",
      tags: null,
    };

    events.push(event);
    datesFound.push(dateFrom);
  }

  summary.adoptedCount = events.length;

  if (datesFound.length > 0) {
    summary.maxDateFrom = formatDate(datesFound.sort((a, b) => a - b)[datesFound.length - 1]);
  }

  console.log(`詳細ページ取得件数: ${summary.detailCount}`);
  console.log(`採用イベント件数: ${summary.adoptedCount}`);
  console.log(`max date_from: ${summary.maxDateFrom || "なし"}`);

  if (events.length === 0 || datesFound.length === 0) {
    console.warn("採用イベントが0件のため、published を更新しません。");
    console.warn(
      `内訳: 日付抽出失敗=${summary.missingDateCount}, 期間外除外=${summary.filteredOutCount}`
    );
    return;
  }

  const today = formatDate(new Date());
  const data = {
    venue_id: VENUE_ID,
    last_success_at: today,
    events: events.sort((a, b) => a.date_from.localeCompare(b.date_from)),
  };

  applyTagsToEventsData(data, { overwrite: false });

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`[OK] events: ${events.length} -> ${OUTPUT_PATH}`);
}

if (require.main === module) {
  main();
}
