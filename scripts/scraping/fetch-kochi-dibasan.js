#!/usr/bin/env node
"use strict";

const path = require("path");
const { fetchText } = require("../lib/http");
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { handleCliFatalError } = require("../lib/cli_error");
const { createEvent } = require("../lib/schema");
const { decodeHtmlEntities, stripTags, normalizeWhitespace } = require("../lib/text");

const VENUE_ID = "kochi-dibasan";
const ENTRY_URL = "https://diba3.com/event/";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", `${VENUE_ID}.json`);

/**
 * 全角数字を半角数字に変換
 */
const toHalfWidth = (str) => {
  if (!str) return "";
  return str.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
};

/**
 * <dl>構造から特定のラベルに対応する値を抽出
 */
function getDlContent(html, label) {
  const regex = new RegExp(`<dt>\\s*${label}\\s*[:：]?\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`, "i");
  const match = regex.exec(html);
  if (!match) return null;
  return normalizeWhitespace(stripTags(decodeHtmlEntities(match[1])));
}

/**
 * 「M月D日」の形式から YYYY-MM-DD を生成。12月の後に1月が来たら年をインクリメントする
 */
function parseJapaneseDate(dateStr, baseYear = 2025) {
  const match = /(\d{1,2}|[０-９]{1,2})月(\d{1,2}|[０-９]{1,2})日/.exec(dateStr);
  if (!match) return null;

  const month = parseInt(toHalfWidth(match[1]), 10);
  const day = parseInt(toHalfWidth(match[2]), 10);

  // 1月～7月などは2026年、12月は2025年として扱う（現在のサイトの掲載状況に基づく）
  const year = (month >= 1 && month <= 8) ? baseYear + 1 : baseYear;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function main() {
  try {
    const rawHtml = await fetchText(ENTRY_URL);
    const cleanHtml = decodeHtmlEntities(rawHtml);

    const finalEvents = [];
    const boxParts = cleanHtml.split(/<div class="box"[^>]*>/gi);
    const dataParts = boxParts.slice(1);

    dataParts.forEach(part => {
      const titleMatch = /<div class="mid">([\s\S]*?)<\/div>/i.exec(part);
      if (!titleMatch) return;
      const title = normalizeWhitespace(stripTags(titleMatch[1]));

      const target = getDlContent(part, "対象");
      const dateText = getDlContent(part, "開催日"); // 例：「２月８日(日)～２月９日（月）」
      const timeText = getDlContent(part, "営業時間");
      const location = getDlContent(part, "会場場所");

      if (!dateText) return;

      // 複数日イベント（～で区切られている場合）の判定
      const dateRange = dateText.split(/[～~－−-]/);
      let dateFrom = null;
      let dateTo = null;

      if (dateRange.length >= 2) {
        // 開始日と終了日が両方ある場合
        dateFrom = parseJapaneseDate(dateRange[0]);
        dateTo = parseJapaneseDate(dateRange[1]);
      } else {
        // 単発日の場合
        dateFrom = parseJapaneseDate(dateText);
        dateTo = dateFrom;
      }

      if (!dateFrom) return;

      // 時間のパース (最初の出現時間を開始時間とする)
      let startTime = null;
      if (timeText) {
        const timeMatch = /(\d{1,2}|[０-９]{1,2})[:：](\d{2}|[０-９]{2})/.exec(timeText);
        if (timeMatch) {
          startTime = toHalfWidth(timeMatch[1]).padStart(2, "0") + ":" + toHalfWidth(timeMatch[2]).padStart(2, "0");
        }
      }

      finalEvents.push(createEvent({
        title: title,
        date_from: dateFrom,
        date_to: dateTo || dateFrom,
        start_time: startTime,
        venue_name: "高知ぢばさんセンター",
        source_url: ENTRY_URL,
        source_type: "web",
        body: `対象: ${target || "制限なし"}\n会場: ${location || "不明"}`
      }));
    });

    console.log(`Successfully fetched ${finalEvents.length} events from Kochi Dibasan Center.`);

    finalizeAndSaveEvents({
      venueId: VENUE_ID,
      outputPath: OUTPUT_PATH,
      events: finalEvents,
      requireDateFrom: true
    });

  } catch (error) {
    handleCliFatalError(error, { prefix: `[${VENUE_ID} Fatal]` });
  }
}

main();
