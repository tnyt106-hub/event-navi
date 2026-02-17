#!/usr/bin/env node
"use strict";

const path = require("path");
const { fetchText } = require("../lib/http");
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { stripTagsCompact, decodeHtmlEntities } = require("../lib/text");
const { handleCliFatalError } = require("../lib/cli_error");

const BASE_URL = "https://clementplaza.com";
const LIST_URL = `${BASE_URL}/event/`;
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", "clementplaza.json");
const VENUE_ID = "clementplaza";
const VENUE_NAME = "徳島駅クレメントプラザ";

const CONCURRENCY_LIMIT = 5;

/**
 * 詳細ページから情報を抽出
 */
async function scrapeDetail(url) {
  try {
    const html = await fetchText(url);
    const cleanHtml = decodeHtmlEntities(html);

    // 本文の抽出
    const contentMatch = cleanHtml.match(/<div class="p-news-detail__content">([\s\S]*?)<\/div>/i);
    const description = contentMatch ? stripTagsCompact(contentMatch[1]) : "";

    // メイン画像の抽出
    const imgMatch = cleanHtml.match(/<div class="p-news-detail__thumb">[\s\S]*?<img[^>]+src=['"]([^'"]+)['"]/i);
    let imageUrl = null;
    if (imgMatch) {
      imageUrl = imgMatch[1].startsWith('http') ? imgMatch[1] : BASE_URL + imgMatch[1];
    }

    return {
      description: description.slice(0, 500),
      imageUrl: imageUrl
    };
  } catch (e) {
    return null;
  }
}

/**
 * 日付文字列のパース
 */
function parseDates(dateStrings) {
  if (!dateStrings || dateStrings.length === 0) return { from: null, to: null };
  
  const currentYear = new Date().getFullYear();
  const format = (str) => {
    const m = str.match(/(\d{1,2})月(\d{1,2})日/);
    if (!m) return null;
    return `${currentYear}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  };

  const from = format(dateStrings[0]);
  // 終了日がない場合は開始日と同じにする
  const to = dateStrings[1] ? format(dateStrings[1]) : from;
  
  return { from, to };
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

    const itemRegex = /<li class="card_list">([\s\S]*?)<\/li>/gi;
    const rawItems = [];
    let match;

    while ((match = itemRegex.exec(cleanHtml)) !== null) {
      const content = match[1];
      
      // 日付の有無をチェック（仕様：日付が取れないものはこの時点でスキップ対象候補）
      const dateMatches = [...content.matchAll(/<span class="date_start">([\s\S]*?)<\/span>/gi)];
      const dateStrings = dateMatches.map(m => stripTagsCompact(m[1]));

      // 日付が1つも見つからない場合はリストに入れない
      if (dateStrings.length === 0) continue;

      const urlMatch = content.match(/href="([^"]+)"/);
      if (!urlMatch) continue;
      const url = urlMatch[1].startsWith('http') ? urlMatch[1] : BASE_URL + urlMatch[1];

      const titleMatch = content.match(/<div class="detail_name">([\s\S]*?)<\/div>/);
      const title = titleMatch ? stripTagsCompact(titleMatch[1]) : "無題のイベント";

      rawItems.push({ url, title, dateStrings });
    }

    console.log(`[INFO] Found ${rawItems.length} events with valid dates. Analyzing details...`);

    if (rawItems.length === 0) {
      throw new Error("EMPTY_RESULT: No events with valid dates found.");
    }

    const detailMap = await pooledMap(rawItems, CONCURRENCY_LIMIT, scrapeDetail);
    console.log("\n[INFO] Analysis complete.");

    const finalEvents = rawItems.map(item => {
      const d = detailMap.get(item.url) || {};
      const { from, to } = parseDates(item.dateStrings);
      
      return {
        title: item.title,
        date_from: from,
        date_to: to,
        venue_name: VENUE_NAME,
        description: d.description || null,
        image_url: d.imageUrl || null,
        source_url: item.url,
        source_type: "web",
        body: `開催期間: ${item.dateStrings.join('〜')}`,
        tags: { type: "other", genres: [], flags: [] }
      };
    }).filter(e => e.date_from !== null); // 念のための最終フィルタ

    finalizeAndSaveEvents({
      venueId: VENUE_ID,
      venueName: VENUE_NAME,
      outputPath: OUTPUT_PATH,
      events: finalEvents,
      requireDateFrom: true // 出力時も必須チェックを有効化
    });

  } catch (error) {
    handleCliFatalError(error);
  }
}

main();
