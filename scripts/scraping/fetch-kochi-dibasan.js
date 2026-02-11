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

const toHalfWidth = (str) => {
  if (!str) return "";
  return str.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
};

function getDlContent(html, label) {
  const regex = new RegExp(`<dt>\\s*${label}\\s*[:：]?\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`, "i");
  const match = regex.exec(html);
  if (!match) return null;
  return normalizeWhitespace(stripTags(decodeHtmlEntities(match[1])));
}

function parseJapaneseDate(dateStr) {
  const match = /(\d{1,2}|[０-９]{1,2})月(\d{1,2}|[０-９]{1,2})日/.exec(dateStr);
  if (!match) return null;

  const month = parseInt(toHalfWidth(match[1]), 10);
  const day = parseInt(toHalfWidth(match[2]), 10);
  
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  let year = currentYear;
  if (currentMonth >= 10 && month <= 3) year = currentYear + 1;
  else if (currentMonth <= 3 && month >= 10) year = currentYear - 1;

  // 実在チェック
  const d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1) return null;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function main() {
  try {
    const rawHtml = await fetchText(ENTRY_URL);
    const cleanHtml = decodeHtmlEntities(rawHtml);
    const finalEvents = [];
    const dataParts = cleanHtml.split(/<div class="box"[^>]*>/gi).slice(1);

    dataParts.forEach(part => {
      const titleMatch = /<div class="mid">([\s\S]*?)<\/div>/i.exec(part);
      if (!titleMatch) return;

      const dateText = getDlContent(part, "開催日");
      if (!dateText) return;

      const dateRange = dateText.split(/[～~－−-]/);
      const dateFrom = parseJapaneseDate(dateRange[0]);
      let dateTo = dateFrom;
      if (dateRange.length >= 2) {
        const parsedTo = parseJapaneseDate(dateRange[1]);
        if (parsedTo) dateTo = parsedTo;
      }

      if (!dateFrom) return;

      let startTime = null;
      const timeText = getDlContent(part, "営業時間");
      if (timeText) {
        const timeMatch = /(\d{1,2}|[０-９]{1,2})[:：](\d{2}|[０-９]{2})/.exec(timeText);
        if (timeMatch) {
          startTime = toHalfWidth(timeMatch[1]).padStart(2, "0") + ":" + toHalfWidth(timeMatch[2]).padStart(2, "0");
        }
      }

      finalEvents.push(createEvent({
        title: normalizeWhitespace(stripTags(titleMatch[1])),
        date_from: dateFrom,
        date_to: dateTo,
        start_time: startTime,
        venue_name: "高知ぢばさんセンター",
        source_url: ENTRY_URL,
        source_type: "web",
        body: `対象: ${getDlContent(part, "対象") || "制限なし"}\n会場: ${getDlContent(part, "会場場所") || "不明"}`
      }));
    });

    finalizeAndSaveEvents({ venueId: VENUE_ID, outputPath: OUTPUT_PATH, events: finalEvents, requireDateFrom: true });
  } catch (error) {
    handleCliFatalError(error, { prefix: `[${VENUE_ID} Fatal]` });
  }
}
main();
