#!/usr/bin/env node
"use strict";

const path = require("path");
const { URL } = require("url");
const { fetchText } = require("../lib/http");
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { handleCliFatalError } = require("../lib/cli_error");
const { createEvent } = require("../lib/schema");
const { dedupeEventsBySourceUrl } = require("../lib/dedupe");
const { decodeHtmlEntities, stripTags, normalizeWhitespace } = require("../lib/text");

const VENUE_ID = "kochi-skbh"; 
const ENTRY_URL = "https://www.kkb-hall.jp/event/event-pickup.html?view=autonomy";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", `${VENUE_ID}.json`);

/**
 * 実行時を基準に「年」を判定する
 */
function getTargetYear(targetMonth) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  if (currentMonth >= 10 && targetMonth <= 3) return currentYear + 1;
  if (currentMonth <= 3 && targetMonth >= 10) return currentYear - 1;
  return currentYear;
}

function extractListItems(html) {
  const items = [];
  const itemRegex = /<div class="event-wrap[^">]*">([\s\S]*?)<div class="event-info2">/g;
  let match;

  while ((match = itemRegex.exec(html)) !== null) {
    const content = match[1];
    const urlMatch = /<a href="([^"]+)"/i.exec(content);
    if (!urlMatch) continue;
    const sourceUrl = new URL(urlMatch[1], ENTRY_URL).href;

    const nameMatch = /<p class="event-name">([\s\S]*?)<\/p>/i.exec(content);
    let title = nameMatch ? normalizeWhitespace(stripTags(decodeHtmlEntities(nameMatch[1]))) : "";

    // 日付抽出: YYYY年がある場合と、MM/DDのみの場合の両方に対応
    const dateMatch = /(\d{4})[年/](\d{1,2})[月/](\d{1,2})/.exec(content)
                   || /(\d{1,2})[月/](\d{1,2})/.exec(content);
    
    let dateFrom = null;
    if (dateMatch) {
      if (dateMatch.length === 4) {
        dateFrom = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;
      } else {
        const m = parseInt(dateMatch[1], 10);
        const y = getTargetYear(m);
        dateFrom = `${y}-${String(m).padStart(2, "0")}-${dateMatch[2].padStart(2, "0")}`;
      }
    }

    const timeTextMatch = /<p class="event-time">([\s\S]*?)<\/p>/i.exec(content);
    let openTime = null, startTime = null, endTime = null;
    if (timeTextMatch) {
      const timeText = normalizeWhitespace(stripTags(decodeHtmlEntities(timeTextMatch[1])));
      const openMatch = /(\d{1,2}:\d{2})\s*開場/.exec(timeText);
      if (openMatch) openTime = openMatch[1];
      const rangeMatch = /(\d{1,2}:\d{2})～(\d{1,2}:\d{2})/.exec(timeText);
      if (rangeMatch) {
        startTime = rangeMatch[1];
        endTime = rangeMatch[2];
      }
    }

    const placeMatch = /<span class="event-place1">([\s\S]*?)<\/span>/i.exec(content);
    const specificVenue = placeMatch ? normalizeWhitespace(stripTags(decodeHtmlEntities(placeMatch[1]))) : "";

    const info1Match = /<div class="event-info1">([\s\S]*?)<\/div>/i.exec(content);
    let price = info1Match ? normalizeWhitespace(stripTags(decodeHtmlEntities(info1Match[1]))) : null;

    if (title && dateFrom) {
      items.push({ title, sourceUrl, dateFrom, openTime, startTime, endTime, price, specificVenue });
    }
  }
  return items;
}

async function main() {
  try {
    const html = await fetchText(ENTRY_URL);
    const items = extractListItems(html);
    const events = items.map(item => createEvent({
      title: item.title,
      date_from: item.dateFrom,
      date_to: item.dateFrom,
      venue_name: item.specificVenue ? `高知県立県民文化ホール ${item.specificVenue}` : "高知県立県民文化ホール",
      source_url: item.sourceUrl,
      source_type: "web",
      start_time: item.startTime,
      open_time: item.openTime,
      end_time: item.endTime,
      price: item.price
    }));

    finalizeAndSaveEvents({
      venueId: VENUE_ID,
      outputPath: OUTPUT_PATH,
      events: dedupeEventsBySourceUrl(events),
      requireDateFrom: true
    });
  } catch (error) {
    handleCliFatalError(error, { prefix: `[${VENUE_ID} Fatal]` });
  }
}
main();
