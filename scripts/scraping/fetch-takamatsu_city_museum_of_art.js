// 高松市美術館の「展覧会・イベント（会期型中心）」ページから、
// 展覧会の会期情報のみを抽出して JSON に保存するバッチ。
// 使い方: node scripts/scraping/fetch-takamatsu_city_museum_of_art.js

const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("../lib/http");
// JSON 保存処理を共通化する。
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { handleCliFatalError } = require("../lib/cli_error");
// HTML テキスト処理の共通関数を使う。
const { stripTagsCompact, normalizeDecodedText } = require("../lib/text");
const {
  normalizeJapaneseDateText,
  buildLocalDate,
  formatIsoDateFromLocalDate,
} = require("../lib/date");

const ENTRY_URL = "https://www.city.takamatsu.kagawa.jp/museum/takamatsu/event/index.html";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", "takamatsu_city_museum_of_art.json");
const VENUE_ID = "takamatsu_city_museum_of_art";
const VENUE_NAME = "高松市美術館";
const TITLE_KEYWORDS = ["特別展", "コレクション展", "その他展覧会", "日本伝統漆芸展", "企画展", "常設展"];
const SPECIAL_SECTION_LABEL = "特別展";

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
  // 施設固有ロジックでも、基本的な文字参照デコードと空白正規化は共通化する。
  return normalizeDecodedText(stripTagsCompact(text));
}

// 全角数字を半角に変換し、日付の区切り記号を正規化する。
function normalizeDateText(text) {
  // この施設は読点揺れと括弧注記を除去してから判定する既存ルールを維持する。
  return normalizeJapaneseDateText(text, {
    normalizeComma: true,
    removeParenthesizedText: true,
  });
}

// 年月日を ISO 形式の文字列にする。
function formatDate(date) {
  return formatIsoDateFromLocalDate(date);
}

// 年月日が妥当な日付かチェックする。
function buildDate(year, month, day) {
  return buildLocalDate(year, month, day);
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
    // 見出しが取れない場合でも「特別展」の文言からセクションを推定する。
    const fallbackStart = cleaned.indexOf(SPECIAL_SECTION_LABEL);
    if (fallbackStart === -1) {
      return {
        specialSectionHtml: "",
        otherSectionHtml: cleaned,
        specialSectionFound: false,
      };
    }

    // 次のセクション候補から最も近い終端を探す。
    const sectionEndCandidates = ["コレクション展", "その他展覧会", "企画展", "常設展"];
    let fallbackEnd = cleaned.length;
    for (const candidate of sectionEndCandidates) {
      const candidateIndex = cleaned.indexOf(candidate, fallbackStart + SPECIAL_SECTION_LABEL.length);
      if (candidateIndex !== -1 && candidateIndex < fallbackEnd) {
        fallbackEnd = candidateIndex;
      }
    }

    return {
      specialSectionHtml: cleaned.slice(fallbackStart, fallbackEnd),
      otherSectionHtml: cleaned.slice(0, fallbackStart) + cleaned.slice(fallbackEnd),
      specialSectionFound: true,
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

// 日付テキストから開始日・終了日を取得する。
function parseDateRange(text) {
  // 日付判定は安全側に倒すため、開始日と終了日が揃っている場合だけ返す。
  const normalized = normalizeDateText(stripTagsCompact(text));
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

  const dateIndicator = /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/;
  const events = [];
  const seen = new Set();
  let specialLinkCount = 0;
  let specialEventsCount = 0;
  const previewPairs = [];
  const anchorPattern = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  // アンカー直後のHTML断片を走査するための文字数（壊れにくさ優先）。
  const anchorLookaheadLength = 900;

  for (const anchor of sectionHtml.matchAll(anchorPattern)) {
    const href = anchor[1] ? anchor[1].trim() : "";
    let title = normalizeText(anchor[2]);
    if (!title) {
      continue;
    }

    specialLinkCount += 1;
    // 特別展ラベルなどのノイズを除去してタイトルを整える。
    title = removeTitleNoise(title);
    const sourceUrl = buildSourceUrlFromHref(href);

    // アンカー直後のHTML断片から日付情報を探す。
    const anchorIndex = anchor.index ?? 0;
    const lookaheadStart = anchorIndex;
    const lookaheadEnd = Math.min(sectionHtml.length, lookaheadStart + anchorLookaheadLength);
    const lookaheadHtml = sectionHtml.slice(lookaheadStart, lookaheadEnd);
    const lookaheadLines = extractRawLinesFromHtml(lookaheadHtml);
    let dateLine = "";

    for (const line of lookaheadLines) {
      const normalizedLine = normalizeDateText(stripTagsCompact(line));
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
  const html = await fetchText(ENTRY_URL, {
    acceptEncoding: "identity",
    encoding: "utf-8",
  });
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
    throw new Error("抽出できた events が 0 件のため中断します。");
  }

  finalizeAndSaveEvents({
    venueId: VENUE_ID,
    venueName: VENUE_NAME,
    outputPath: OUTPUT_PATH,
    events,
    requireDateFrom: false,
  });
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

if (require.main === module) {
  main().catch((error) => {
    handleCliFatalError(error, { prefix: `[${VENUE_ID}] 失敗` });
  });
}
