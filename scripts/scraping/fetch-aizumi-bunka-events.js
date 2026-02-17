#!/usr/bin/env node
"use strict";

const path = require("path");
const { fetchText } = require("../lib/http");
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { stripTagsCompact, decodeHtmlEntities } = require("../lib/text");
const { handleCliFatalError } = require("../lib/cli_error");

const BASE_URL = "https://www.town.aizumi.lg.jp";
const LIST_URL = `${BASE_URL}/bunka-h/event_list/`;
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", "aizumi_bunka.json");
const VENUE_ID = "aizumi_bunka";
const VENUE_NAME = "藍住町総合文化ホール";

const CONCURRENCY_LIMIT = 5;

/**
 * 詳細ページから情報を抽出（時間・詳細テキスト取得）
 */
async function scrapeDetail(url) {
  try {
    const html = await fetchText(url);
    const cleanHtml = decodeHtmlEntities(html);

    const bodyMatch = cleanHtml.match(/<div class="text-beginning">([\s\S]*?)<\/div>/i);
    const content = bodyMatch ? bodyMatch[1] : "";
    const description = stripTagsCompact(content);

    let startTime = null;
    let openTime = null;

    const dateSection = content.match(/日時<\/strong><\/h3>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    if (dateSection) {
      const timeStr = dateSection[1];
      const parseJapaneseTime = (str) => {
        const m = str.match(/(午前|午後)(\d{1,2})時(?:(\d{1,2})分)?/);
        if (!m) return null;
        let hour = parseInt(m[2], 10);
        const min = m[3] ? m[3].padStart(2, '0') : "00";
        if (m[1] === "午後" && hour < 12) hour += 12;
        if (m[1] === "午前" && hour === 12) hour = 0;
        return `${hour.toString().padStart(2, '0')}:${min}`;
      };

      const startMatch = timeStr.match(/開演／([^（）\s]+)/);
      if (startMatch) startTime = parseJapaneseTime(startMatch[1]);

      const openMatch = timeStr.match(/開場／([^（）\s]+)/);
      if (openMatch) openTime = parseJapaneseTime(openMatch[1]);
    }

    return { description: description.slice(0, 500), startTime, openTime };
  } catch (e) {
    return null;
  }
}

/**
 * テキストから日付範囲を特定する
 */
function parseDates(text) {
  const dates = [];
  const matches = text.matchAll(/(\d{4})年(\d{2})月(\d{2})日/g);
  for (const m of matches) {
    dates.push(`${m[1]}-${m[2]}-${m[3]}`);
  }
  if (dates.length === 0) return null;
  const sorted = dates.sort();
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}

async function pooledMap(tasks, limit, fn) {
  const results = new Map();
  const queue = [...tasks];
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      const res = await fn(item.url);
      if (res) results.set(item.url, res);
      process.stdout.write(".");
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

async function main() {
  try {
    console.log(`[INFO] Fetching list from: ${LIST_URL}`);
    const html = await fetchText(LIST_URL);
    const cleanHtml = decodeHtmlEntities(html);

    const tbodyMatch = cleanHtml.match(/<tbody>([\s\S]*?)<\/tbody>/i);
    if (!tbodyMatch) throw new Error("EMPTY_RESULT: No table body found.");

    const rowRegex = /<tr>([\s\S]*?)<\/tr>/gi;
    const rawItems = [];
    let match;

    while ((match = rowRegex.exec(tbodyMatch[1])) !== null) {
      const rowContent = match[1];

      const imgMatch = rowContent.match(/<img[^>]+src="([^"]+)"/i);
      const imageUrl = imgMatch ? (imgMatch[1].startsWith('http') ? imgMatch[1] : BASE_URL + imgMatch[1]) : null;

      const titleLinkMatch = rowContent.match(/<td class="title_link">[\s\S]*?<a href="([^"]+)">([\s\S]*?)<\/a>/i);
      if (!titleLinkMatch) continue;

      const url = titleLinkMatch[1].startsWith('http') ? titleLinkMatch[1] : BASE_URL + titleLinkMatch[1];
      const title = stripTagsCompact(titleLinkMatch[2]);

      const dateTdMatch = rowContent.match(/<td class="date">([\s\S]*?)<\/td>/i);
      if (!dateTdMatch) continue;

      // 日付セクションをタグ（pやspan）で分割して、個別の塊にする
      const dateParts = dateTdMatch[1].split(/<\/p>|<\/span>|<br\s*\/?>/i);

      for (const part of dateParts) {
        const cleanPart = stripTagsCompact(part).trim();
        if (!cleanPart) continue;

        const dates = parseDates(cleanPart);
        if (dates) {
          rawItems.push({
            url,
            title,
            from: dates.from,
            to: dates.to,
            imageUrl,
            originalDateText: cleanPart
          });
        }
      }
    }

    console.log(`[INFO] Found ${rawItems.length} date entries. Analyzing details...`);

    // 重複したURLの詳細取得を避けるためユニークなURLリストで詳細を取得
    const uniqueUrls = [...new Set(rawItems.map(item => item.url))];
    const detailMap = await pooledMap(uniqueUrls.map(url => ({url})), CONCURRENCY_LIMIT, scrapeDetail);
    console.log("\n[INFO] Analysis complete.");

    const finalEvents = rawItems.map(item => {
      const d = detailMap.get(item.url) || {};
      return {
        title: item.title,
        date_from: item.from,
        date_to: item.to,
        open_time: d.openTime,
        start_time: d.startTime,
        venue_name: VENUE_NAME,
        description: d.description || null,
        image_url: item.imageUrl,
        source_url: item.url,
        source_type: "web",
        body: `開催分: ${item.originalDateText}`,
        tags: { type: "other", genres: [], flags: [] }
      };
    });

    finalizeAndSaveEvents({
      venueId: VENUE_ID,
      venueName: VENUE_NAME,
      outputPath: OUTPUT_PATH,
      events: finalEvents,
      requireDateFrom: true
    });

  } catch (error) {
    handleCliFatalError(error);
  }
}

main();
