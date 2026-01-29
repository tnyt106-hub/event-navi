// 高松市美術館の「展覧会・イベント（会期型中心）」ページから、
// 展覧会の会期情報のみを抽出して JSON に保存するバッチ。
// 使い方: node scripts/fetch-takamatsu_city_museum_of_art.js

const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");

const ENTRY_URL = "https://www.city.takamatsu.kagawa.jp/museum/takamatsu/event/index.html";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "takamatsu_city_museum_of_art.json");
const VENUE_ID = "takamatsu_city_museum_of_art";
const VENUE_NAME = "高松市美術館";
const TITLE_KEYWORDS = ["特別展", "コレクション展", "その他展覧会", "日本伝統漆芸展", "企画展", "常設展"];
const SPECIAL_SECTION_LABEL = "特別展";

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

// HTMLを行配列に変換する共通処理（タグは残したまま改行だけ挿入）。
function extractRawLinesFromHtml(html) {
  if (!html) return [];
  // 区切りになりうるタグを改行に置き換えてからプレーンテキスト化する。
  const cleaned = removeNoisyTags(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<\/section>/gi, "\n")
    .replace(/<\/li>/gi, "\n");
  return cleaned.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

// HTMLを行配列に変換する共通処理。
function extractLinesFromHtml(html) {
  const rawLines = extractRawLinesFromHtml(html);
  return rawLines
    .map((line) => normalizeText(line))
    .map((line) => normalizeDateText(line))
    .filter((line) => line.length > 0);
}

// タイトル候補かどうかを判定する。
function isTitleCandidate(line) {
  const titleKeywordPattern = new RegExp(TITLE_KEYWORDS.join("|"));
  const titleOnlyPattern = new RegExp(`^(${TITLE_KEYWORDS.join("|")})$`);
  // 2文字未満、キーワード未包含、キーワードのみの見出しは除外する。
  if (line.length < 2 || !titleKeywordPattern.test(line) || titleOnlyPattern.test(line)) {
    return false;
  }
  return true;
}

// 「特別展」見出しから次の見出しまでを特別展セクションとして切り出す。
function splitHtmlBySpecialSection(html) {
  const cleaned = removeNoisyTags(html);
  const headingRegex = /<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi;
  let specialStart = -1;
  let specialEnd = -1;

  let headingMatch = headingRegex.exec(cleaned);
  while (headingMatch) {
    const headingText = normalizeText(headingMatch[0]);
    if (headingText.includes(SPECIAL_SECTION_LABEL)) {
      specialStart = headingMatch.index;
      break;
    }
    headingMatch = headingRegex.exec(cleaned);
  }

  if (specialStart === -1) {
    return {
      specialSectionHtml: "",
      otherSectionHtml: cleaned,
      specialSectionFound: false,
    };
  }

  const nextHeadingMatch = headingRegex.exec(cleaned);
  specialEnd = nextHeadingMatch ? nextHeadingMatch.index : cleaned.length;

  return {
    specialSectionHtml: cleaned.slice(specialStart, specialEnd),
    otherSectionHtml: cleaned.slice(0, specialStart) + cleaned.slice(specialEnd),
    specialSectionFound: true,
  };
}

// 見出しラベルのうち、タイトルに不要な先頭語を除去する。
function removeTitleNoise(title) {
  if (!title) return "";
  return title
    .replace(/^(特別展)\s*(開催予定|開催中)\s*/u, "$1 ")
    .replace(/^(開催予定|開催中)\s*/u, "")
    .trim();
}

// href から詳細ページURLを安全に組み立てる。
function buildSourceUrlFromHref(href) {
  if (!href) {
    return ENTRY_URL;
  }
  try {
    return new URL(href, ENTRY_URL).toString();
  } catch (error) {
    return ENTRY_URL;
  }
}

// HTML内のイベント候補ブロックを抽出する。
function extractEventBlocks(html) {
  // ブロック構造ではなく「タイトル行→日付行」の並びを行ベースで拾う。
  const lines = extractLinesFromHtml(html);
  const blocks = [];
  const dateIndicator = /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/;

  for (let i = 0; i < lines.length; i += 1) {
    const titleLine = lines[i];
    if (!isTitleCandidate(titleLine)) {
      continue;
    }
    const dateLine = lines[i + 1];
    if (!dateLine || !dateIndicator.test(dateLine)) {
      continue;
    }
    // 既存のブロック解析を流用できるよう、簡易的に連結する。
    blocks.push(`${titleLine}\n${dateLine}`);
  }

  return blocks;
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
  return buildSourceUrlFromHref(href);
}

// 日付テキストから開始日・終了日を取得する。
function parseDateRange(text) {
  // 日付判定は安全側に倒すため、開始日と終了日が揃っている場合だけ返す。
  const normalized = normalizeDateText(stripTags(text));
  const startMatch = normalized.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);

  // 開始日が「YYYY年M月D日」で取得できない場合は除外する。
  if (!startMatch || startMatch.index === undefined) {
    return null;
  }

  const startDate = buildDate(Number(startMatch[1]), Number(startMatch[2]), Number(startMatch[3]));
  if (!startDate) {
    return null;
  }

  const remainder = normalized.slice(startMatch.index + startMatch[0].length);
  const hasRangeSeparator = /(~|-|から|まで)/.test(remainder);
  if (!hasRangeSeparator) {
    return null;
  }

  // 終了日は「YYYY年M月D日」または「M月D日」だけを許可する。
  const endMatchWithYear = remainder.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const endMatchWithoutYear = remainder.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  let endDate = null;

  if (endMatchWithYear) {
    endDate = buildDate(Number(endMatchWithYear[1]), Number(endMatchWithYear[2]), Number(endMatchWithYear[3]));
  } else if (endMatchWithoutYear) {
    const endMonth = Number(endMatchWithoutYear[1]);
    const endDay = Number(endMatchWithoutYear[2]);
    let endYear = startDate.getFullYear();
    const startMonth = startDate.getMonth() + 1;
    const startDay = startDate.getDate();
    // 年の省略がある場合は、終了月日が開始月日より前なら翌年とみなす。
    if (endMonth < startMonth || (endMonth === startMonth && endDay < startDay)) {
      endYear += 1;
    }
    endDate = buildDate(endYear, endMonth, endDay);
  }

  if (!endDate) {
    return null;
  }
  if (startDate > endDate) {
    return null;
  }

  return { start: startDate, end: endDate };
}

// 特別展セクションから、タイトルリンクと直後の会期行をセットで抽出する。
function extractSpecialEventsFromSection(sectionHtml) {
  if (!sectionHtml) {
    return {
      events: [],
      specialLinkCount: 0,
      specialEventsCount: 0,
      previewPairs: [],
    };
  }

  const rawLines = extractRawLinesFromHtml(sectionHtml);
  const dateIndicator = /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/;
  const events = [];
  const seen = new Set();
  let specialLinkCount = 0;
  let specialEventsCount = 0;
  const previewPairs = [];

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i];
    const anchors = [...line.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
    if (anchors.length === 0) {
      continue;
    }

    for (const anchor of anchors) {
      const href = anchor[1] ? anchor[1].trim() : "";
      let title = normalizeText(anchor[2]);
      if (!title) {
        continue;
      }

      specialLinkCount += 1;
      title = removeTitleNoise(title);
      const sourceUrl = buildSourceUrlFromHref(href);

      let dateLine = "";
      const lookaheadLimit = Math.min(rawLines.length, i + 4);
      for (let j = i; j < lookaheadLimit; j += 1) {
        const normalizedLine = normalizeDateText(stripTags(rawLines[j]));
        if (dateIndicator.test(normalizedLine)) {
          dateLine = normalizedLine;
          break;
        }
      }

      if (!dateLine) {
        continue;
      }

      const dateRange = parseDateRange(dateLine);
      if (!dateRange) {
        continue;
      }

      const dateFrom = formatDate(dateRange.start);
      const dateTo = formatDate(dateRange.end);
      const key = `${title}__${dateFrom}__${dateTo}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      events.push({
        title,
        date_from: dateFrom,
        date_to: dateTo,
        source_url: sourceUrl,
      });
      specialEventsCount += 1;

      if (previewPairs.length < 3) {
        previewPairs.push({ title, source_url: sourceUrl });
      }
    }
  }

  return {
    events,
    specialLinkCount,
    specialEventsCount,
    previewPairs,
  };
}

// HTMLを行配列に分解して展覧会（会期型）を抽出する。
function extractEventsFromLines(html) {
  const lines = extractLinesFromHtml(html);
  const startDatePattern = /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/;
  const events = [];
  const seen = new Set();
  let excludedCount = 0;
  let titleCandidates = 0;
  let dateLineDetections = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const titleLine = lines[i];
    // タイトル候補はキーワードを含み、見出し単体だけではないものを採用する。
    if (!isTitleCandidate(titleLine)) {
      continue;
    }
    titleCandidates += 1;

    const dateLine = lines[i + 1];
    if (!dateLine || !startDatePattern.test(dateLine)) {
      continue;
    }
    dateLineDetections += 1;

    const dateRange = parseDateRange(dateLine);
    if (!dateRange) {
      excludedCount += 1;
      continue;
    }

    const dateFrom = formatDate(dateRange.start);
    const dateTo = formatDate(dateRange.end);
    const key = `${titleLine}__${dateFrom}__${dateTo}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    events.push({
      title: titleLine,
      date_from: dateFrom,
      date_to: dateTo,
      source_url: ENTRY_URL,
    });
  }

  return {
    events,
    excludedCount,
    lineCount: lines.length,
    titleCandidates,
    dateLineDetections,
    linesPreview: lines.slice(0, 6).map((line) => (line.length > 40 ? `${line.slice(0, 40)}…` : line)),
  };
}

// 同じタイトル・会期のイベントを重複排除する。
function dedupeEvents(events) {
  const map = new Map();
  for (const event of events) {
    const key = `${event.title}__${event.date_from}__${event.date_to}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, event);
      continue;
    }
    if (existing.source_url === ENTRY_URL && event.source_url !== ENTRY_URL) {
      map.set(key, event);
    }
  }
  return Array.from(map.values());
}

async function main() {
  const html = await fetchHtml(ENTRY_URL);
  const sectionResult = splitHtmlBySpecialSection(html);
  // 特別展セクションはタイトルリンクと直後の日付をペアにして抽出する。
  const specialResult = extractSpecialEventsFromSection(sectionResult.specialSectionHtml);
  // それ以外のセクションは従来通り行ベースで抽出する。
  const lineResult = extractEventsFromLines(sectionResult.otherSectionHtml);
  const mergedEvents = dedupeEvents([...specialResult.events, ...lineResult.events]);
  const events = mergedEvents;
  const excludedCount = lineResult.excludedCount;

  if (events.length === 0) {
    // 失敗時に原因を追えるように、行数や候補数などの最小情報を出す。
    console.error(
      `[${VENUE_ID}] 抽出できた events が 0 件です。 lines=${lineResult.lineCount}, titles=${lineResult.titleCandidates}, dateLines=${lineResult.dateLineDetections}, specialSectionFound=${sectionResult.specialSectionFound}, specialLinks=${specialResult.specialLinkCount}, specialEvents=${specialResult.specialEventsCount}, preview=${lineResult.linesPreview.join(" / ")}`
    );
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
  console.log(
    `[${VENUE_ID}] lines=${lineResult.lineCount}, titles=${lineResult.titleCandidates}, dateLines=${lineResult.dateLineDetections}, events=${events.length}, excluded=${excludedCount}, specialSectionFound=${sectionResult.specialSectionFound}, specialLinks=${specialResult.specialLinkCount}, specialEvents=${specialResult.specialEventsCount}`
  );
  if (specialResult.previewPairs.length > 0) {
    const previewText = specialResult.previewPairs
      .map((pair) => `${pair.title} -> ${pair.source_url}`)
      .join(" / ");
    console.log(`[${VENUE_ID}] specialPreview=${previewText}`);
  }
}

main().catch((error) => {
  console.error(`[${VENUE_ID}] 失敗: ${error?.message || error}`);
  process.exit(1);
});
