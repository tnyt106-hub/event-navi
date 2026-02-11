#!/usr/bin/env node
"use strict";

const path = require("path");
const { fetchText } = require("../lib/http");
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { handleCliFatalError } = require("../lib/cli_error");
const { createEvent } = require("../lib/schema");
const { decodeHtmlEntities, stripTags, normalizeWhitespace } = require("../lib/text");

const VENUE_ID = "kochi-culport";
const ENTRY_URL = "https://www.bunkaplaza.or.jp/event/";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", `${VENUE_ID}.json`);

const CONCURRENCY = 3;

/**
 * 実行時を基準に月情報から「年」を判定
 */
function getTargetYear(targetMonth) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  if (currentMonth >= 10 && targetMonth <= 3) return currentYear + 1;
  if (currentMonth <= 3 && targetMonth >= 10) return currentYear - 1;
  return currentYear;
}

function getTdContentByLabel(html, label) {
  const regex = new RegExp(`<td>\\s*(?:<[^>]+>)*\\s*${label}\\s*(?:<[^>]+>)*\\s*</td>\\s*<td>([\\s\\S]*?)</td>`, "i");
  const match = regex.exec(html);
  if (!match) return null;
  return normalizeWhitespace(stripTags(decodeHtmlEntities(match[1])));
}

async function fetchEventDetail(url, initialData) {
  try {
    const html = await fetchText(url);
    const cleanHtml = decodeHtmlEntities(html);

    let title = initialData.title;
    const h1Match = /<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(cleanHtml);
    if (h1Match) title = normalizeWhitespace(stripTags(h1Match[1]));

    const dateText = getTdContentByLabel(cleanHtml, "開催日") 
                  || getTdContentByLabel(cleanHtml, "日時") 
                  || getTdContentByLabel(cleanHtml, "期間") || "";

    let dateStr = null;
    if (dateText) {
      // 1. 年が含まれる場合 (YYYY年MM月DD日)
      const fullDateMatch = /(\d{4})[年\.\-/]\s*(\d{1,2})[月\.\-/](\d{1,2})/i.exec(dateText);
      if (fullDateMatch) {
        dateStr = `${fullDateMatch[1]}-${fullDateMatch[2].padStart(2, "0")}-${fullDateMatch[3].padStart(2, "0")}`;
      } else {
        // 2. 年が含まれない場合 (MM月DD日) -> 実行時から年を推測
        const shortDateMatch = /(\d{1,2})[月/](\d{1,2})/i.exec(dateText);
        if (shortDateMatch) {
          const m = parseInt(shortDateMatch[1], 10);
          const y = getTargetYear(m);
          dateStr = `${y}-${String(m).padStart(2, "0")}-${shortDateMatch[2].padStart(2, "0")}`;
        }
      }
    }

    if (!dateStr) return null;

    // バリデーション
    const [y, m, d] = dateStr.split("-").map(Number);
    const checkDate = new Date(y, m - 1, d);
    if (checkDate.getMonth() !== m - 1) return null;

    const timeText = getTdContentByLabel(cleanHtml, "開催時間") || getTdContentByLabel(cleanHtml, "時間") || "";
    let startTime = null;
    if (timeText) {
      const timeMatch = /(\d{1,2})[:：](\d{2})/.exec(timeText);
      if (timeMatch) startTime = `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`;
    }

    return createEvent({
      ...initialData,
      title,
      date_from: dateStr,
      date_to: dateStr,
      start_time: startTime,
      price: getTdContentByLabel(cleanHtml, "入場料") || null,
      source_url: url
    });
  } catch (e) {
    return null;
  }
}

async function main() {
  try {
    const listHtml = await fetchText(ENTRY_URL);
    const initialEvents = [];
    const entryRegex = /<li class="c-entries__item">([\s\S]*?)<\/li>/gi;
    let match;

    while ((match = entryRegex.exec(listHtml)) !== null) {
      const urlMatch = /<a href="([^"]+)"/i.exec(match[1]);
      const titleMatch = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(match[1]);
      if (urlMatch) {
        initialEvents.push({
          url: urlMatch[1],
          data: {
            title: titleMatch ? normalizeWhitespace(stripTags(decodeHtmlEntities(titleMatch[1]))) : "Untitled",
            venue_name: "高知市文化プラザ かるぽーと",
            source_type: "web"
          }
        });
      }
    }

    const finalEvents = [];
    for (let i = 0; i < initialEvents.length; i += CONCURRENCY) {
      const chunk = initialEvents.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(item => fetchEventDetail(item.url, item.data)));
      finalEvents.push(...results.filter(ev => ev !== null));
    }

    finalizeAndSaveEvents({ venueId: VENUE_ID, outputPath: OUTPUT_PATH, events: finalEvents, requireDateFrom: true });
  } catch (error) {
    handleCliFatalError(error, { prefix: `[${VENUE_ID} Fatal]` });
  }
}
main();
