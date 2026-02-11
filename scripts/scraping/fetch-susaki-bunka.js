#!/usr/bin/env node
"use strict";

const path = require("path");
const { fetchText } = require("../lib/http");
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { handleCliFatalError } = require("../lib/cli_error");
const { createEvent } = require("../lib/schema");
const { decodeHtmlEntities, stripTags, normalizeWhitespace } = require("../lib/text");

const VENUE_ID = "susaki-bunka";
const ENTRY_URL = "https://www.susakibunka.com/event";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", `${VENUE_ID}.json`);

async function main() {
  try {
    const rawHtml = await fetchText(ENTRY_URL);
    // 改行コードを統一し、HTMLタグを消去
    const cleanHtml = decodeHtmlEntities(rawHtml).replace(/<br\s*\/?>/gi, "\n");
    const plainText = stripTags(cleanHtml);

    // 「と き :」を目印にイベントを分割
    const eventBlocks = plainText.split(/と\s*き\s*:/g);
    const dataBlocks = eventBlocks.slice(1);
    const finalEvents = [];

    dataBlocks.forEach((block, index) => {
      // 1. 日付の抽出 (2026年 3月 1日 等)
      const dateMatch = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/.exec(block);
      if (!dateMatch) return;
      const dateStr = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;

      // 2. 時間の抽出
      const timeMatch = /開演\s*(\d{1,2})[:：](\d{2})/.exec(block);
      const startTime = timeMatch ? `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}` : null;

      // 3. タイトルの抽出（改善版ロジック）
      // 前のブロックを改行で分解し、空でない行を後ろから探す
      const prevBlockLines = eventBlocks[index].split("\n")
        .map(line => line.replace(/[\u200B-\u200D\uFEFF]/g, "").trim()) // 特殊な空白文字を除去
        .filter(line => line.length > 0 && !/近日開催|イベント情報|ホーム|施設概要/.test(line));
      
      let title = "名称未設定のイベント";
      if (prevBlockLines.length > 0) {
        // 「とき :」の直近数行から、最もタイトルらしいものを選択
        // 通常、最後の方の行がタイトルになる
        title = prevBlockLines[prevBlockLines.length - 1];
      }

      // 4. 料金の抽出
      const priceMatch = /(?:前売り|一般|大人|高校生)[\s\S]*?(\d{1,3}(?:,\d{3})*円)/.exec(block);
      const price = priceMatch ? priceMatch[0].replace(/\n/g, " ").trim() : null;

      finalEvents.push(createEvent({
        title: title,
        date_from: dateStr,
        date_to: dateStr,
        start_time: startTime,
        price: price,
        venue_name: "須崎市立市民文化会館",
        source_url: ENTRY_URL,
        source_type: "web"
      }));
    });

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
