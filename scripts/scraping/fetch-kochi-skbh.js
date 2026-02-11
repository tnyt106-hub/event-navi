#!/usr/bin/env node
"use strict";

/**
 * scripts/scraping/fetch-kochi-skbh.js
 * 高知県立県民文化ホール イベント情報取得スクリプト (リッチデータ版)
 */

const path = require("path");
const { URL } = require("url");

// 必須API（共通ライブラリ）の読み込み
const { fetchText } = require("../lib/http");
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { handleCliFatalError } = require("../lib/cli_error");
const { createEvent } = require("../lib/schema");
const { dedupeEventsBySourceUrl } = require("../lib/dedupe");
const { decodeHtmlEntities, stripTags, normalizeWhitespace } = require("../lib/text");

// 施設設定
const VENUE_ID = "kochi-skbh"; 
const ENTRY_URL = "https://www.kkb-hall.jp/event/event-pickup.html?view=autonomy";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", `${VENUE_ID}.json`);

/**
 * 一覧HTMLからイベント情報の断片を抽出する
 */
function extractListItems(html) {
  const items = [];
  // 各イベントのブロックを抽出
  const itemRegex = /<div class="event-wrap[^">]*">([\s\S]*?)<div class="event-info2">/g;
  let match;

  while ((match = itemRegex.exec(html)) !== null) {
    const content = match[1];
    
    // URL抽出
    const urlMatch = /<a href="([^"]+)"/i.exec(content);
    if (!urlMatch) continue;
    const sourceUrl = new URL(urlMatch[1], ENTRY_URL).href;

    // タイトル抽出
    const nameMatch = /<p class="event-name">([\s\S]*?)<\/p>/i.exec(content);
    let title = nameMatch ? normalizeWhitespace(stripTags(decodeHtmlEntities(nameMatch[1]))) : "";

    // 日付抽出
    const dateMatch = /<p class="event-date">(\d{4})[年/](\d{1,2})[月/](\d{1,2})/.exec(content);
    let dateFrom = null;
    if (dateMatch) {
      dateFrom = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;
    }

    // 時刻抽出
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
      } else {
        const startOnlyMatch = /(\d{1,2}:\d{2})～/.exec(timeText);
        if (startOnlyMatch) startTime = startOnlyMatch[1];
      }
    }

    // ホール名抽出 (例: オレンジホール)
    const placeMatch = /<span class="event-place1">([\s\S]*?)<\/span>/i.exec(content);
    const specificVenue = placeMatch ? normalizeWhitespace(stripTags(decodeHtmlEntities(placeMatch[1]))) : "";

    // 主催・共催
    const sponsorshipMatch = /<span class="event-sponsorship">([\s\S]*?)<\/span>/i.exec(content);
    const sponsorship = sponsorshipMatch ? normalizeWhitespace(stripTags(decodeHtmlEntities(sponsorshipMatch[1]))) : "";

    // 画像URL抽出
    const imgMatch = /<img[^>]+src="([^"]+)"/i.exec(content);
    let imageUrl = null;
    if (imgMatch) {
      imageUrl = new URL(imgMatch[1], ENTRY_URL).href;
    }

    // 料金・備考抽出 (event-info1)
    const info1Match = /<div class="event-info1">([\s\S]*?)<\/div>/i.exec(content);
    let price = null;
    let description = null;
    if (info1Match) {
      const infoText = decodeHtmlEntities(info1Match[1]);
      // 料金っぽい部分（「円」を含む行など）を簡易的に抽出することも可能ですが、
      // 運用上は infoText 全体を正規化して保持するのが安全です。
      const cleanText = normalizeWhitespace(stripTags(infoText));
      price = cleanText; 
      description = sponsorship ? `【${sponsorship}】${cleanText}` : cleanText;
    }

    if (title && sourceUrl) {
      items.push({ 
        title, sourceUrl, dateFrom, openTime, startTime, endTime, 
        price, description, imageUrl, specificVenue 
      });
    }
  }

  return items;
}

/**
 * 抽出した情報を標準イベント形式に変換する
 */
function buildEvents(items) {
  let excludedInvalid = 0;
  const events = items.map(item => {
    if (!item.dateFrom) {
      excludedInvalid++;
      return null;
    }

    // 会場名にホール名を付与（例: 高知県立県民文化ホール オレンジホール）
    const fullVenueName = item.specificVenue 
      ? `高知県立県民文化ホール ${item.specificVenue}`
      : "高知県立県民文化ホール";

    return createEvent({
      title: item.title,
      date_from: item.dateFrom,
      date_to: item.dateFrom,
      source_url: item.sourceUrl,
      source_type: "web",
      venue_name: fullVenueName,
      open_time: item.openTime,
      start_time: item.startTime,
      end_time: item.endTime,
      price: item.price,
      description: item.description,
      image_url: item.imageUrl
    });
  }).filter(Boolean);

  return { events, excludedInvalid };
}

/**
 * ファイル保存
 */
function saveEventsFile(events) {
  finalizeAndSaveEvents({
    venueId: VENUE_ID,
    outputPath: OUTPUT_PATH,
    events: events,
    requireDateFrom: true
  });
}

/**
 * メイン処理
 */
async function main() {
  try {
    const html = await fetchText(ENTRY_URL);
    const items = extractListItems(html);
    
    const { events: rawEvents, excludedInvalid } = buildEvents(items);
    const dedupedEvents = dedupeEventsBySourceUrl(rawEvents);

    console.log(`[INFO] venue_id=${VENUE_ID}`);
    console.log(`[INFO] list_links=${items.length}`);
    console.log(`[INFO] excluded_invalid=${excludedInvalid}`);
    console.log(`[INFO] events_built=${dedupedEvents.length}`);
    console.log(`[INFO] output_path=${OUTPUT_PATH}`);

    saveEventsFile(dedupedEvents);
    
  } catch (error) {
    handleCliFatalError(error, { prefix: `[${VENUE_ID} Fatal]` });
  }
}

main();
