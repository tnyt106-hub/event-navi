#!/usr/bin/env node
"use strict";

const path = require("path");
const { fetchText } = require("../lib/http");
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { handleCliFatalError } = require("../lib/cli_error");
const { createEvent } = require("../lib/schema");
const { decodeHtmlEntities, stripTags, normalizeWhitespace } = require("../lib/text");

const VENUE_ID = "awagin-hall";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", `${VENUE_ID}.json`);

const TARGET_URLS = [
  "https://kyoubun.or.jp/moyoshi/1.html",
  "https://kyoubun.or.jp/moyoshi/2.html",
  "https://kyoubun.or.jp/moyoshi/3.html",
  "https://kyoubun.or.jp/moyoshi/4.html"
];

function cleanText(text) {
  if (!text) return "";
  let str = decodeHtmlEntities(text);
  str = stripTags(str);
  str = str.replace(/[\n\r\t　]+/g, " ");
  return normalizeWhitespace(str.trim());
}

/**
 * 実行時の日付を基準に、対象の月が何年かを判定する
 */
function getTargetYear(targetMonth) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  if (currentMonth >= 10 && targetMonth <= 3) return currentYear + 1;
  if (currentMonth <= 3 && targetMonth >= 10) return currentYear - 1;
  return currentYear;
}

/**
 * 開催期間のパース（誤認防止・バリデーション強化版）
 */
function parseEventDates(dateStr, targetMonth) {
  const year = getTargetYear(targetMonth);
  const parts = dateStr.split(/[～~－−-]/);
  
  const extractDay = (s) => {
    // 曜日のカッコがある数字のみを日付として抽出
    const m = s.match(/(\d{1,2})\s*[\(（]/);
    return m ? m[1].padStart(2, "0") : null;
  };

  const dayFrom = extractDay(parts[0]);
  if (!dayFrom) return { dateFrom: null, dateTo: null };

  const dateFrom = `${year}-${String(targetMonth).padStart(2, "0")}-${dayFrom}`;
  let dateTo = dateFrom;

  // 2つ目のパーツが「日付」である確証（カッコがある）がある場合のみ処理
  if (parts.length >= 2) {
    const dayTo = extractDay(parts[1]);
    if (dayTo && (parts[1].includes("（") || parts[1].includes("("))) {
      // 存在しない日付（2月30日など）をチェック
      const d = new Date(year, targetMonth - 1, parseInt(dayTo, 10));
      if (d.getMonth() === targetMonth - 1) {
        dateTo = `${year}-${String(targetMonth).padStart(2, "0")}-${dayTo}`;
      }
    }
  }
  return { dateFrom, dateTo };
}

async function fetchEventsFromUrl(url) {
  const events = [];
  const rawHtml = await fetchText(url);
  const cleanHtml = decodeHtmlEntities(rawHtml);

  const monthMatch = /<div class="month">(\d{1,2})/.exec(cleanHtml);
  const targetMonth = monthMatch ? parseInt(monthMatch[1], 10) : new Date().getMonth() + 1;

  const catMatch = /<div class="stitle"><h3>([\s\S]*?)<\/h3><\/div>/i.exec(cleanHtml);
  const categoryName = catMatch ? cleanText(catMatch[1]) : "あわぎんホール";

  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = trRegex.exec(cleanHtml)) !== null) {
    const rowHtml = match[1];
    if (rowHtml.includes("催し物") || rowHtml.includes("日時")) continue;

    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let tdMatch;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      cells.push(tdMatch[1]);
    }

    if (cells.length < 2) continue;

    const dateCellHtml = cells[0];
    const strippedDateText = stripTags(dateCellHtml);
    const { dateFrom, dateTo } = parseEventDates(strippedDateText, targetMonth);

    if (!dateFrom) continue;

    let startTime = null;
    const timeMatch = /(\d{1,2})[:：](\d{2})/.exec(strippedDateText);
    if (timeMatch) {
      startTime = `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`;
    }

    events.push(createEvent({
      title: cleanText(cells[1]),
      date_from: dateFrom,
      date_to: dateTo,
      start_time: startTime,
      venue_name: "あわぎんホール",
      source_url: url,
      source_type: "web",
      price: cells.length >= 4 ? cleanText(cells[3]) : "",
      body: `会場: ${categoryName}\nお問合せ先: ${cleanText(cells[2])}`
    }));
  }
  return events;
}

async function main() {
  try {
    let allEvents = [];
    for (const url of TARGET_URLS) {
      console.log(`Processing: ${url}`);
      const events = await fetchEventsFromUrl(url);
      allEvents = allEvents.concat(events);
    }
    finalizeAndSaveEvents({ venueId: VENUE_ID, outputPath: OUTPUT_PATH, events: allEvents, requireDateFrom: true });
    console.log(`Successfully saved ${allEvents.length} events.`);
  } catch (error) {
    handleCliFatalError(error, { prefix: `[${VENUE_ID} Fatal]` });
  }
}
main();
