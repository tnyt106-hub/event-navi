// レクザムホール（香川県県民ホール）のイベント一覧ページから
// HTMLに埋め込まれた日付→HTML断片のデータを抽出して保存するバッチ。
// 使い方: node scripts/fetch-rexam-hall-events.js

const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");
// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("./lib/http");
// JSON 保存処理を共通化する。
const { finalizeAndSaveEvents } = require("./lib/fetch_output");
const { handleCliFatalError } = require("./lib/cli_error");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities, stripTags, normalizeWhitespace } = require("./lib/text");

const ENTRY_URL = "https://kenminhall.com/visitors/event/";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "rexam_hall.json");
const VENUE_ID = "rexam_hall";
// 本文テキストは長すぎる場合に省略表記を付けて切り詰める。
const MAX_BODY_LENGTH = 5000;
const BODY_TRUNCATION_SUFFIX = "…（省略）";

// HTML内の「日付キー→HTML断片」のオブジェクト部分を抽出する。
function extractEmbeddedObject(html) {
  const assignments = /\b(?:var|let|const)\s+[A-Za-z0-9_$]+\s*=\s*\{/g;
  const dateKeyPattern = /["']\d{4}\/\d{2}\/\d{2}["']/;
  // HTML断片の目印となるキーワードで、正しい候補かどうかを判断する。
  const eventDetailPattern = /event_detail/;
  const iconPattern = /e_icon/;
  // event_detail だけを満たす候補は、より良い候補が無い場合の予備として保持する。
  let fallbackCandidate = null;

  for (const match of html.matchAll(assignments)) {
    const startIndex = match.index + match[0].lastIndexOf("{");
    const endIndex = findMatchingBrace(html, startIndex);
    if (endIndex === null) {
      continue;
    }

    const objectLiteral = html.slice(startIndex, endIndex + 1);
    // 日付キーとイベントHTML断片の両方を満たす候補だけを採用する。
    if (dateKeyPattern.test(objectLiteral) && (iconPattern.test(objectLiteral) || eventDetailPattern.test(objectLiteral))) {
      if (iconPattern.test(objectLiteral)) {
        // e_icon を含む候補は最優先で採用する。
        return objectLiteral;
      }
      // event_detail のみ含む候補は一旦保持し、より良い候補が無ければ採用する。
      if (!fallbackCandidate) {
        fallbackCandidate = objectLiteral;
      }
    }
  }

  if (fallbackCandidate) {
    return fallbackCandidate;
  }

  throw new Error("正しい埋め込みイベントオブジェクトが見つからない。");
}

// 開始位置の { から対応する } を探して返す。
function findMatchingBrace(text, startIndex) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (!inDouble && char === "'") {
      inSingle = !inSingle;
      continue;
    }

    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      continue;
    }

    if (inSingle || inDouble) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return null;
}

// JSオブジェクトの文字列をJSONとしてパース可能な形に整えて変換する。
function parseEmbeddedObject(objectLiteral) {
  const trimmed = objectLiteral.trim();
  const withoutTrailingCommas = trimmed.replace(/,\s*}/g, "}");

  try {
    return JSON.parse(withoutTrailingCommas);
  } catch (error) {
    const normalized = convertSingleQuotedStrings(withoutTrailingCommas);
    return JSON.parse(normalized);
  }
}

// シングルクォートの文字列をJSONで扱える形式に変換する。
function convertSingleQuotedStrings(text) {
  let result = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      if (inSingle && char === "'") {
        result += "'";
      } else {
        result += `\\${char}`;
      }
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      result += '"';
      continue;
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      result += char;
      continue;
    }

    if (inSingle && char === '"') {
      result += '\\"';
      continue;
    }

    result += char;
  }

  if (escaped) {
    result += "\\\\";
  }

  return result;
}

// 日付キーを ISO 形式に変換する。
function normalizeDateKey(dateKey) {
  const match = String(dateKey).match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

// 時刻テキストから開場/開演/終演を抽出する。
function extractTimes(text) {
  const normalized = text.replace(/\s+/g, " ");
  const openTimeMatch = normalized.match(/開場\s*([0-9]{1,2}:[0-9]{2})/);
  const startTimeMatch = normalized.match(/開演\s*([0-9]{1,2}:[0-9]{2})/);
  const endTimeMatch = normalized.match(/終演\s*([0-9]{1,2}:[0-9]{2})/);

  return {
    open_time: openTimeMatch ? openTimeMatch[1] : null,
    start_time: startTimeMatch ? startTimeMatch[1] : null,
    end_time: endTimeMatch ? endTimeMatch[1] : null,
  };
}

// 抽出した連続テキストを body に格納するため、最大文字数で丸める。
function trimBodyText(rawText) {
  if (!rawText) return "";
  const normalized = String(rawText).trim();
  if (!normalized) return "";
  if (normalized.length <= MAX_BODY_LENGTH) {
    return normalized;
  }
  const safeLength = Math.max(0, MAX_BODY_LENGTH - BODY_TRUNCATION_SUFFIX.length);
  return `${normalized.slice(0, safeLength)}${BODY_TRUNCATION_SUFFIX}`;
}

// HTML断片からイベント情報を展開する。
function parseEventsFromFragment(fragment, dateIso, baseUrl) {
  const events = [];
  const stats = {
    nonPublicExcluded: 0,
    closedDayExcluded: 0,
    emptyTitleExcluded: 0,
  };
  // HTML断片を「<span class='e_icon'」または「<span'」を起点に分割して、
  // 各イベントブロックから最低限の情報を取り出す。
  const blockStartRegex = /<span[^>]*class=['"][^"']*\be_icon\b[^"']*['"][^>]*>/gi;
  const blockStartMatches = [...fragment.matchAll(blockStartRegex)];
  const blocks = [];

  if (blockStartMatches.length > 0) {
    for (let i = 0; i < blockStartMatches.length; i += 1) {
      const startIndex = blockStartMatches[i].index;
      const endIndex =
        i + 1 < blockStartMatches.length ? blockStartMatches[i + 1].index : fragment.length;
      blocks.push(fragment.slice(startIndex, endIndex));
    }
  } else if (fragment.trim()) {
    blocks.push(fragment);
  }

  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]*href=['"]([^'"]+)['"][^>]*>/);
    const titleMatch = block.match(/<a[^>]*href=['"][^'"]+['"][^>]*>([\s\S]*?)<\/a>/);
    // 共通 stripTags は空白を残すため、既存と同じ空白圧縮 + trim を明示して揃える。
    const titleText = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : "";
    const combinedText = normalizeWhitespace(stripTags(block));

    if (!titleText) {
      stats.emptyTitleExcluded += 1;
      continue;
    }

    if (titleText === "非公開") {
      stats.nonPublicExcluded += 1;
      continue;
    }

    if (combinedText.includes("休館") || combinedText.includes("臨時休館日")) {
      stats.closedDayExcluded += 1;
      continue;
    }

    const href = hrefMatch ? hrefMatch[1] : "";
    const sourceUrl = href ? new URL(href, baseUrl).toString() : null;
    // 時刻はブロック全体から抽出し、見つからなければ null のままにする。
    const times = extractTimes(combinedText);
    // 抽出が難しい断片は、取得できた連続テキストを本文に残す。
    const bodyText = trimBodyText(combinedText);

    events.push({
      title: titleText,
      date_from: dateIso,
      date_to: dateIso,
      source_url: sourceUrl,
      open_time: times.open_time,
      start_time: times.start_time,
      end_time: times.end_time,
      price: null,
      contact: null,
      body: bodyText || null,
    });
  }

  return { events, stats };
}

// 取得したデータからイベント配列を構築する。
function buildEventsFromMap(eventMap) {
  const events = [];
  const stats = {
    nonPublicExcluded: 0,
    closedDayExcluded: 0,
    emptyTitleExcluded: 0,
  };
  let sampleLogged = 0;

  for (const [dateKey, fragment] of Object.entries(eventMap)) {
    const dateIso = normalizeDateKey(dateKey);
    if (!dateIso) {
      console.warn(`日付キーの形式が不正なためスキップします: ${dateKey}`);
      continue;
    }

    const decodedFragment = decodeHtmlEntities(fragment);
    if (sampleLogged < 2) {
      console.log(`DEBUG: ${dateKey} の断片文字数 = ${decodedFragment.length}`);
      sampleLogged += 1;
    }
    const { events: fragmentEvents, stats: fragmentStats } = parseEventsFromFragment(
      decodedFragment,
      dateIso,
      ENTRY_URL
    );
    console.log(`DEBUG: ${dateKey} のイベント件数 = ${fragmentEvents.length}`);
    stats.nonPublicExcluded += fragmentStats.nonPublicExcluded;
    stats.closedDayExcluded += fragmentStats.closedDayExcluded;
    stats.emptyTitleExcluded += fragmentStats.emptyTitleExcluded;
    events.push(...fragmentEvents);
  }

  return { events, stats };
}

// 成功時のみファイルを書き換える。
function saveEventsFile(events) {
  finalizeAndSaveEvents({
    venueId: VENUE_ID,
    outputPath: OUTPUT_PATH,
    events,
    beforeWrite(data) {
      applyTagsToEventsData(data, { overwrite: false });
    },
  });
}

async function main() {
  try {
    const html = await fetchText(ENTRY_URL, {
      acceptEncoding: "identity",
      encoding: "utf-8",
    });
    console.log(`DEBUG: HTML文字数 = ${html.length}`);
    const objectLiteral = extractEmbeddedObject(html);
    console.log(`DEBUG: objectLiteral先頭 = ${objectLiteral.slice(0, 200)}`);
    console.log(`DEBUG: objectLiteral末尾 = ${objectLiteral.slice(-200)}`);
    const eventMap = parseEmbeddedObject(objectLiteral);
    const eventKeys = Object.keys(eventMap || {});
    console.log(`DEBUG: eventMapキー数 = ${eventKeys.length}`);
    console.log(`DEBUG: eventMapキーサンプル = ${eventKeys.slice(0, 5).join(", ")}`);
    // 埋め込みオブジェクトのサンプル値にHTML断片が含まれているか確認する。
    const sampleValue = eventKeys.length > 0 ? String(eventMap[eventKeys[0]]) : "";
    console.log(
      `DEBUG: eventMapサンプル値に<spanまたはe_iconが含まれるか = ${
        /<span|e_icon/.test(sampleValue)
      }`
    );

    if (!eventMap || typeof eventMap !== "object" || Array.isArray(eventMap)) {
      throw new Error("埋め込みデータの形式が想定と異なります。");
    }

    const { events, stats } = buildEventsFromMap(eventMap);
    console.log(
      `DEBUG: 除外件数(非公開=${stats.nonPublicExcluded}, 休館/臨時休館=${stats.closedDayExcluded}, タイトル空=${stats.emptyTitleExcluded})`
    );
    console.log(`DEBUG: 最終イベント件数 = ${events.length}`);

    if (events.length === 0) {
      console.warn(
        "DEBUG: 除外の結果0件の可能性があります。フィルタ件数を確認してください。"
      );
      throw new Error("イベントが0件のため上書きしません。");
    }

    const dateCount = events.filter((event) => event.date_from).length;
    if (dateCount === 0) {
      throw new Error("date_from が1件も作成できませんでした。");
    }

    saveEventsFile(events);
  } catch (error) {
    handleCliFatalError(error, { prefix: "失敗" });
  }
}

main();
