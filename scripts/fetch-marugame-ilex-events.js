// 丸亀市綾歌総合文化会館アイレックスのイベント一覧ページから
// イベント情報を抽出して docs/events/marugame_ilex.json に保存するバッチ。
// 使い方: node scripts/fetch-marugame-ilex-events.js

const fs = require("fs");
const path = require("path");

const { applyTagsToEventsData } = require("../tools/tagging/apply_tags");
// 共通 HTTP 取得ユーティリティで Shift_JIS を取得する。
const { fetchText } = require("./lib/http");
// JSON 保存処理を共通化する。
const { finalizeAndSaveEvents } = require("./lib/fetch_output");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities } = require("./lib/text");

const ENTRY_URL = "https://www.marugame-ilex.org/event/eve_1/index.html";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "marugame_ilex.json");
const VENUE_ID = "marugame_ilex";
const ALLOWED_VENUE_KEYWORDS = ["アイレックス", "丸亀市綾歌総合文化会館"];
// 連続テキストの本文は最大文字数を設け、長すぎる場合は省略表記を付ける。
const MAX_BODY_LENGTH = 5000;
const BODY_TRUNCATION_SUFFIX = "…（省略）";

// タグを落としてテキスト化する。
function stripTags(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "");
}

// <br> を指定した区切り文字へ置換する。
function replaceBreaks(html, separator) {
  if (!html) return "";
  return html.replace(/<br\s*\/?>/gi, separator);
}

// タイトル用に <br> をスペースへ変換し、空白を整える。
function normalizeTitle(rawHtml) {
  const withSpaces = replaceBreaks(rawHtml, " ");
  const text = decodeHtmlEntities(stripTags(withSpaces));
  return text.replace(/\s+/g, " ").trim();
}

// 説明文用に <br> を改行へ変換し、行ごとに整える。
function normalizeDescription(rawHtml) {
  const withBreaks = replaceBreaks(rawHtml, "\n");
  const text = decodeHtmlEntities(stripTags(withBreaks));
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
  return lines.join("\n");
}

// 本文テキストを最大文字数で丸め、必要に応じて省略表記を付ける。
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

// 1イベント分のブロックをアンカー位置で切り出す。
function splitEventBlocks(html) {
  const anchorRegex = /<a[^>]*\b(?:name|id)="no\d+"[^>]*>/gi;
  const anchors = [];

  for (const match of html.matchAll(anchorRegex)) {
    const anchorHtml = match[0];
    const idMatch = anchorHtml.match(/\b(?:name|id)="(no\d+)"/i);
    if (!idMatch) {
      continue;
    }

    anchors.push({
      id: idMatch[1],
      index: match.index,
    });
  }

  const blocks = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const start = anchors[i].index;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : html.length;
    blocks.push({
      id: anchors[i].id,
      html: html.slice(start, end),
    });
  }

  return blocks;
}

// イベントブロックから指定クラスの <td> / <div> を抜き出す。
function extractByClass(blockHtml, tagName, className) {
  const regex = new RegExp(
    `<${tagName}[^>]*class=["']${className}["'][^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "i"
  );
  const match = blockHtml.match(regex);
  return match ? match[1] : null;
}

// 日付文字列から日付範囲を抽出する。
function parseDateRange(dateText) {
  if (!dateText) return null;
  const normalized = dateText.replace(/\s+/g, "");
  const dateMatches = [...normalized.matchAll(/(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日/g)];

  let currentYear = null;
  let currentMonth = null;
  const dates = [];

  for (const match of dateMatches) {
    const yearText = match[1];
    const monthText = match[2];
    const dayText = match[3];

    if (yearText) {
      currentYear = Number(yearText);
    }
    if (monthText) {
      currentMonth = Number(monthText);
    }

    if (!currentYear || !currentMonth || !dayText) {
      return null;
    }

    const day = Number(dayText);
    const iso = `${String(currentYear).padStart(4, "0")}-${String(currentMonth).padStart(2, "0")}-${String(
      day
    ).padStart(2, "0")}`;
    dates.push(iso);
  }

  if (dates.length === 0) {
    return null;
  }

  const sorted = dates.sort();
  return {
    dateFrom: sorted[0],
    dateTo: sorted[sorted.length - 1],
  };
}

// 会場名がアイレックス関連かどうかを判定する。
function isAllowedVenue(venueName) {
  if (!venueName) return false;
  return ALLOWED_VENUE_KEYWORDS.some((keyword) => venueName.includes(keyword));
}

// イベントを日付昇順で並べ替える。
function sortEventsByDate(events) {
  return [...events].sort((a, b) => {
    if (a.date_from === b.date_from) {
      return String(a.title).localeCompare(String(b.title));
    }
    return String(a.date_from).localeCompare(String(b.date_from));
  });
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
      encoding: "shift_jis",
      acceptEncoding: "identity",
    });
    const blocks = splitEventBlocks(html);

    let excludedByVenue = 0;
    let skippedMissingTitle = 0;
    let skippedMissingDateLine = 0;
    let skippedInvalidDate = 0;
    let skippedMissingVenue = 0;
    const events = [];

    for (const block of blocks) {
      const titleHtml = extractByClass(block.html, "td", "mainTit1");
      const detailHtml = extractByClass(block.html, "div", "mainTx0");
      const metaHtml = extractByClass(block.html, "td", "mainTit2");

      const title = normalizeTitle(titleHtml);
      if (!title) {
        skippedMissingTitle += 1;
        continue;
      }

      if (!metaHtml) {
        skippedMissingDateLine += 1;
        continue;
      }

      const metaText = decodeHtmlEntities(stripTags(replaceBreaks(metaHtml, "\n")));
      const metaLines = metaText
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter((line) => line.length > 0);

      if (metaLines.length === 0) {
        skippedMissingDateLine += 1;
        continue;
      }

      const dateLine = metaLines[0];
      const venueName = metaLines.slice(1).join(" ").trim();

      if (!venueName) {
        skippedMissingVenue += 1;
        continue;
      }

      if (!isAllowedVenue(venueName)) {
        excludedByVenue += 1;
        const sourceUrl = `${ENTRY_URL}#${block.id}`;
        console.warn(`会場除外: ${venueName} / ${title} / ${sourceUrl}`);
        continue;
      }

      const dateRange = parseDateRange(dateLine);
      if (!dateRange) {
        skippedInvalidDate += 1;
        continue;
      }

      const description = normalizeDescription(detailHtml);
      // 抽出が難しい施設では、連続テキストを body にも保持して後段で活用する。
      const bodyText = trimBodyText(description);
      const status = description.includes("公演は終了しました") || description.includes("イベントは終了しました")
        ? "finished"
        : "scheduled";

      events.push({
        title,
        date_from: dateRange.dateFrom,
        date_to: dateRange.dateTo,
        venue_name: venueName,
        description: description || null,
        body: bodyText || null,
        status,
        source_url: `${ENTRY_URL}#${block.id}`,
        open_time: null,
        start_time: null,
        end_time: null,
        price: null,
        contact: null,
      });
    }

    const sortedEvents = sortEventsByDate(events);
    const dateCount = sortedEvents.filter((event) => event.date_from).length;
    const maxDate = sortedEvents.reduce((latest, event) => {
      if (!event.date_from) return latest;
      if (!latest || event.date_from > latest) return event.date_from;
      return latest;
    }, null);

    console.log(`取得候補イベント数: ${blocks.length}`);
    console.log(`会場フィルタ除外数: ${excludedByVenue}`);
    console.log(`採用イベント数: ${sortedEvents.length}`);
    console.log(`スキップ(タイトル欠落): ${skippedMissingTitle}`);
    console.log(`スキップ(日付行欠落): ${skippedMissingDateLine}`);
    console.log(`スキップ(日付解析失敗): ${skippedInvalidDate}`);
    console.log(`スキップ(会場欠落): ${skippedMissingVenue}`);
    console.log(`max date_from: ${maxDate ?? "N/A"}`);

    if (sortedEvents.length === 0) {
      throw new Error("イベントが0件のため上書きしません。");
    }

    if (dateCount === 0) {
      throw new Error("date_from が1件も作成できませんでした。");
    }

    saveEventsFile(sortedEvents);
  } catch (error) {
    console.error(`失敗: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
