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
const DEFAULT_DATE = "2026-01-01"; // 判定用のデフォルト日付

/**
 * <td>ラベル</td><td>内容</td> の構造から、タグを無視してテキストのみを抽出する
 */
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

    // 1. タイトルの抽出
    let title = initialData.title;
    const h1Match = /<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(cleanHtml);
    if (h1Match) title = normalizeWhitespace(stripTags(h1Match[1]));

    // 2. 日付の抽出
    const dateText = getTdContentByLabel(cleanHtml, "開催日") 
                  || getTdContentByLabel(cleanHtml, "日時") 
                  || getTdContentByLabel(cleanHtml, "期間") || "";

    let dateStr = null;
    if (dateText) {
      const dateMatch = /(\d{4})年\s*(?:（[^）]+）)?\s*(\d{1,2})[月/](\d{1,2})/i.exec(dateText)
                     || /(\d{4})\.(\d{1,2})\.(\d{1,2})/i.exec(dateText);
      if (dateMatch) {
        dateStr = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;
      }
    }

    // 【重要】日付が取得できない、あるいは不完全なページ（案内ページ等）はここで弾く
    if (!dateStr || dateStr === DEFAULT_DATE) {
      console.log(`[Skip] 日付が特定できないため除外します: ${title}`);
      return null;
    }

    // 3. 時間の抽出
    const timeText = getTdContentByLabel(cleanHtml, "開催時間") 
                  || getTdContentByLabel(cleanHtml, "時間") || "";
    
    let startTime = null;
    if (timeText) {
      const timeMatch = /(\d{1,2})[:：](\d{2})/.exec(timeText)
                     || /(\d{1,2})時\s*(\d{2})?/.exec(timeText);
      if (timeMatch) {
        if (timeMatch[0].includes(":") || timeMatch[0].includes("：")) {
          startTime = timeMatch[0].replace("：", ":").padStart(5, "0");
        } else {
          startTime = `${timeMatch[1].padStart(2, "0")}:${(timeMatch[2] || "00").padStart(2, "0")}`;
        }
      }
    }

    // 4. 料金の抽出
    const price = getTdContentByLabel(cleanHtml, "参加費") 
               || getTdContentByLabel(cleanHtml, "受講料") 
               || getTdContentByLabel(cleanHtml, "入場料") || "";

    return createEvent({
      ...initialData,
      title: title || initialData.title,
      date_from: dateStr,
      date_to: dateStr,
      start_time: startTime,
      price: price.trim() || null,
      source_url: url
    });
  } catch (e) {
    console.error(`[Error] ${url}: ${e.message}`);
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
      const block = match[1];
      const urlMatch = /<a href="([^"]+)"/i.exec(block);
      const titleMatch = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
      
      if (urlMatch) {
        initialEvents.push({
          url: urlMatch[1],
          data: {
            title: titleMatch ? normalizeWhitespace(stripTags(decodeHtmlEntities(titleMatch[1]))) : "Untitled",
            venue_name: "高知市文化プラザ かるぽーと",
            source_url: urlMatch[1],
            source_type: "web"
          }
        });
      }
    }

    const finalEvents = [];
    for (let i = 0; i < initialEvents.length; i += CONCURRENCY) {
      const chunk = initialEvents.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(item => fetchEventDetail(item.url, item.data)));
      // null（日付なしで弾かれたもの）を除外して追加
      finalEvents.push(...results.filter(ev => ev !== null));
    }

    finalizeAndSaveEvents({
      venueId: VENUE_ID,
      outputPath: OUTPUT_PATH,
      events: finalEvents,
      requireDateFrom: true // 日付必須設定
    });
    
  } catch (error) {
    handleCliFatalError(error, { prefix: `[${VENUE_ID} Fatal]` });
  }
}

main();
