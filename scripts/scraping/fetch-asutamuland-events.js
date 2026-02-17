#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { fetchText } = require("../lib/http");
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { stripTagsCompact, decodeHtmlEntities } = require("../lib/text");
const { handleCliFatalError } = require("../lib/cli_error");

const LIST_URL = "https://asutamuland.jp/event/";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", "asutamuland.json");
const VENUE_ID = "asutamuland";
const VENUE_NAME = "あすたむらんど徳島";

// 同時接続数の制限（サイト負荷軽減と安定のため）
const CONCURRENCY_LIMIT = 5;

/**
 * 詳細ページから情報を抽出
 */
async function scrapeDetail(url) {
  try {
    const html = await fetchText(url);
    const cleanHtml = decodeHtmlEntities(html);

    // 画像
    const imgMatch = cleanHtml.match(/class="post_content">[\s\S]*?<img[^>]+src=['"]([^'"]+)['"]/i);
    const imageUrl = imgMatch ? imgMatch[1] : null;

    // 本文
    const bodyMatch = cleanHtml.match(/<div class="post_content">([\s\S]*?)<\/div>/i);
    const description = bodyMatch ? stripTagsCompact(bodyMatch[1]) : "";

    // 基本情報 (DLリスト)
    const infoMap = {};
    const dlMatch = cleanHtml.match(/<dl class="list">([\s\S]*?)<\/dl>/i);
    if (dlMatch) {
      const items = dlMatch[1].matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi);
      for (const m of items) {
        const key = stripTagsCompact(m[1]);
        const val = stripTagsCompact(m[2]).replace(/\s+/g, " ").trim();
        infoMap[key] = val;
      }
    }

    // 開催期間の解析
    const dateText = infoMap["開催日"] || "";
    const dates = dateText.match(/\d{4}\/\d{2}\/\d{2}/g) || [];
    const dateFrom = dates[0] ? dates[0].replace(/\//g, "-") : null;
    const dateTo = dates[1] ? dates[1].replace(/\//g, "-") : (dates[0] ? dates[0].replace(/\//g, "-") : null);

    const timeText = infoMap["開催時間"] || "";
    const startTimeMatch = timeText.match(/(\d{1,2}:\d{2})/);
    const endTimeMatch = timeText.match(/～(\d{1,2}:\d{2})/);

    return {
      title: cleanHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1].trim() || "無題",
      dateFrom,
      dateTo,
      imageUrl,
      description: description.slice(0, 500), // 長めに取得
      venueName: infoMap["開催場所"] || VENUE_NAME,
      timeText: timeText,
      startTime: startTimeMatch ? startTimeMatch[1] : null,
      endTime: endTimeMatch ? endTimeMatch[1] : null,
      feeNote: infoMap["参加費・応募など"] || ""
    };
  } catch (e) {
    return null;
  }
}

/**
 * 同時実行数を制御しながら並列実行するヘルパー
 */
async function pooledMap(urls, limit, fn) {
  const results = new Map();
  const queue = [...urls];
  
  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      const res = await fn(url);
      if (res) results.set(url, res);
      process.stdout.write("."); // 進捗表示
    }
  }

  // 指定した制限数分だけワーカーを起動
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

async function main() {
  try {
    console.log(`[INFO] Fetching list from: ${LIST_URL}`);
    const html = await fetchText(LIST_URL);
    const cleanHtml = decodeHtmlEntities(html);

    // 詳細URLを全抽出
    const eventUrlRegex = /https:\/\/asutamuland\.jp\/events\/event\/\d+\//g;
    const uniqueUrls = [...new Set(cleanHtml.match(eventUrlRegex) || [])];

    console.log(`[INFO] Found ${uniqueUrls.length} unique events. Starting parallel analysis (pool size: ${CONCURRENCY_LIMIT})...`);

    if (uniqueUrls.length === 0) {
      throw new Error("EMPTY_RESULT: No events found.");
    }

    // 高速化：並列処理を実行
    const detailMap = await pooledMap(uniqueUrls, CONCURRENCY_LIMIT, scrapeDetail);
    console.log("\n[INFO] All analysis complete.");

    const finalEvents = [];
    for (const [url, d] of detailMap) {
      if (!d.dateFrom) continue;
      
      finalEvents.push({
        title: d.title,
        date_from: d.dateFrom,
        date_to: d.dateTo,
        start_time: d.startTime,
        end_time: d.endTime,
        venue_name: d.venueName,
        description: d.description,
        image_url: d.imageUrl,
        source_url: url,
        source_type: "web",
        body: `時間: ${d.timeText}\n備考: ${d.feeNote}`.trim(),
        tags: { type: "other", genres: [], flags: [] }
      });
    }

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
