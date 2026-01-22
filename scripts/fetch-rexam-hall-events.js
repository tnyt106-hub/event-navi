// レクザムホール（香川県県民ホール）のイベント一覧ページから
// HTMLに埋め込まれた日付→HTML断片のデータを抽出して保存するバッチ。
// 使い方: node scripts/fetch-rexam-hall-events.js

const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");

const ENTRY_URL = "https://kenminhall.com/visitors/event/";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "rexam_hall.json");
const VENUE_ID = "rexam_hall";

// HTMLを取得する。HTTPエラーや明らかなエラーページはハード失敗とする。
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

// HTML内の「日付キー→HTML断片」のオブジェクト部分を抽出する。
function extractEmbeddedObject(html) {
  const assignments = /\b(?:var|let|const)\s+[A-Za-z0-9_$]+\s*=\s*\{/g;
  const dateKeyPattern = /["']\d{4}\/\d{2}\/\d{2}["']/;

  for (const match of html.matchAll(assignments)) {
    const startIndex = match.index + match[0].lastIndexOf("{");
    const endIndex = findMatchingBrace(html, startIndex);
    if (endIndex === null) {
      continue;
    }

    const objectLiteral = html.slice(startIndex, endIndex + 1);
    if (dateKeyPattern.test(objectLiteral)) {
      return objectLiteral;
    }
  }

  throw new Error("埋め込みオブジェクトが見つかりませんでした。");
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
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
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

// HTML断片からイベント情報を展開する。
function parseEventsFromFragment(fragment, dateIso, baseUrl) {
  const events = [];
  const eventRegex =
    /<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<h3[^>]*>[\s\S]*?<a[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;

  for (const match of fragment.matchAll(eventRegex)) {
    const titleText = stripTags(match[3]);
    const combinedText = stripTags(match[0]);

    if (titleText === "非公開") {
      continue;
    }

    if (combinedText.includes("休館") || combinedText.includes("臨時休館日")) {
      continue;
    }

    const href = match[2];
    const sourceUrl = new URL(href, baseUrl).toString();
    const timeText = stripTags(match[4]);
    const times = extractTimes(timeText);

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
    });
  }

  return events;
}

// 取得したデータからイベント配列を構築する。
function buildEventsFromMap(eventMap) {
  const events = [];

  for (const [dateKey, fragment] of Object.entries(eventMap)) {
    const dateIso = normalizeDateKey(dateKey);
    if (!dateIso) {
      console.warn(`日付キーの形式が不正なためスキップします: ${dateKey}`);
      continue;
    }

    const decodedFragment = decodeHtmlEntities(fragment);
    const fragmentEvents = parseEventsFromFragment(decodedFragment, dateIso, ENTRY_URL);
    events.push(...fragmentEvents);
  }

  return events;
}

// 成功時のみファイルを書き換える。
function saveEventsFile(events) {
  const today = new Date().toISOString().slice(0, 10);
  const data = {
    venue_id: VENUE_ID,
    last_success_at: today,
    events,
  };

  applyTagsToEventsData(data, { overwrite: false });

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function main() {
  try {
    const html = await fetchHtml(ENTRY_URL);
    const objectLiteral = extractEmbeddedObject(html);
    const eventMap = parseEmbeddedObject(objectLiteral);

    if (!eventMap || typeof eventMap !== "object" || Array.isArray(eventMap)) {
      throw new Error("埋め込みデータの形式が想定と異なります。");
    }

    const events = buildEventsFromMap(eventMap);

    if (events.length === 0) {
      throw new Error("イベントが0件のため上書きしません。");
    }

    const dateCount = events.filter((event) => event.date_from).length;
    if (dateCount === 0) {
      throw new Error("date_from が1件も作成できませんでした。");
    }

    saveEventsFile(events);
    console.log(`完了: ${events.length} 件のイベントを保存しました。`);
  } catch (error) {
    console.error(`失敗: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
