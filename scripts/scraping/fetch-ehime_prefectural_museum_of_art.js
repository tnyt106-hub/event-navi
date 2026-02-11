#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// 共通モジュールの読み込み
const { fetchText } = require("../lib/http");
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { handleCliFatalError } = require("../lib/cli_error");
const { stripTagsCompact, normalizeDecodedText, decodeHtmlEntities } = require("../lib/text");
const { buildPastCutoffDate, evaluateEventAgainstPastCutoff } = require("../lib/date_window");
const { buildUtcDate, formatIsoDateFromUtcDate } = require("../lib/date");

const ENTRY_URL = "https://www.ehime-art.jp/exhibition/";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", "ehime_prefectural_museum_of_art.json");
const VENUE_ID = "ehime_prefectural_museum_of_art";
const VENUE_NAME = "愛媛県美術館";

// パフォーマンス向上のため並列数を調整
const CONCURRENCY = 5;

// 正規表現のプリコンパイル
const REGEX_BLOCK = /<(?:section|li) class="exhibition-(?:lg-box|simple-item|item)"[^>]*>([\s\S]*?)<\/(?:section|li)>/gi;
const REGEX_TITLE = /<h[34][^>]*>([\s\S]*?)<\/h[34]>/i;
const REGEX_LINK = /<a[^>]*href="([^"]+)"/i;
const REGEX_DATE = /<p class="(?:post-term|exhibition-simple-item__date)">([\s\S]*?)<\/p>/i;
const REGEX_TIME_DL = /開館時間<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i;
const REGEX_HALL_DL = /会場<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i;
const REGEX_PRICE_DL = /料金<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i;
const REGEX_TIME_RANGE = /(\d{1,2}:\d{2})[～~](\d{1,2}:\d{2})/;
// 「一般」の後に空白や&nbsp;、改行があっても次の<td>を狙い撃つ
const REGEX_GENERAL_PRICE = /<th[^>]*>一般<\/th>[\s\S]*?<td[^>]*>\s*([^<]+?)\s*<\/td>/i;

/**
 * 連続する空白、改行、タブを1つの半角スペースに整理
 */
function cleanWhitespace(text) {
  if (!text) return "";
  return text.replace(/\s+/g, " ").replace(/&nbsp;/g, "").trim();
}

/**
 * 日本語の日付文字列からISO形式を生成
 */
function robustParseDate(dateStr) {
  if (!dateStr) return null;
  const base = dateStr.replace(/[（(][^）)]*[）)]/g, "").replace(/\s+/g, "");
  const match = base.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/);
  if (match) {
    const utc = buildUtcDate(parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10));
    return utc ? formatIsoDateFromUtcDate(utc) : null;
  }
  return null;
}

/**
 * 詳細ページから時間・会場・料金を抽出
 */
async function enrichEventDetail(item) {
  try {
    const html = await fetchText(item.source_url);
    const cleanHtml = decodeHtmlEntities(html);

    // 1. 開館時間の抽出
    const timeMatch = REGEX_TIME_DL.exec(cleanHtml);
    if (timeMatch) {
      const timeText = cleanWhitespace(stripTagsCompact(timeMatch[1]));
      const rangeMatch = REGEX_TIME_RANGE.exec(timeText);
      if (rangeMatch) {
        item.start_time = rangeMatch[1].padStart(5, "0");
        item.end_time = rangeMatch[2].padStart(5, "0");
      }
      item.body += `\n開館時間: ${timeText}`;
    }

    // 2. 会場の抽出（具体的な展示室名）
    const hallMatch = REGEX_HALL_DL.exec(cleanHtml);
    if (hallMatch) {
      const hallName = cleanWhitespace(stripTagsCompact(hallMatch[1]));
      item.venue_name = `${VENUE_NAME} ${hallName}`;
    }

    // 3. 料金の抽出
    const priceMatch = REGEX_PRICE_DL.exec(cleanHtml);
    if (priceMatch) {
      const priceHtml = priceMatch[1];
      const priceText = cleanWhitespace(stripTagsCompact(priceHtml));
      
      const generalMatch = REGEX_GENERAL_PRICE.exec(priceHtml);
      let detectedPrice = generalMatch ? cleanWhitespace(generalMatch[1]) : null;

      if (detectedPrice && /\d/.test(detectedPrice)) {
        // 数字が含まれていればその金額（340円など）を採用
        item.price = detectedPrice;
      } else if (/^無料$|観覧料：?無料/.test(priceText) || (detectedPrice && /無料/.test(detectedPrice))) {
        // 明確に無料と判断できる場合
        item.price = "無料";
      } else {
        // 特定できない場合は null（誤った無料判定を避ける）
        item.price = null;
      }
      
      item.body += `\n料金詳細: ${priceText}`;
    } else {
      item.price = null;
    }

    return item;
  } catch (err) {
    console.error(`[WARN] 詳細取得失敗: ${item.source_url}`);
    return item;
  }
}

async function main() {
  console.log(`[START] ${VENUE_NAME} の更新を開始します...`);
  console.time("Performance");

  try {
    const html = await fetchText(ENTRY_URL);
    const initialItems = [];

    // 一覧から各展覧会のブロックを抽出
    let match;
    while ((match = REGEX_BLOCK.exec(html)) !== null) {
      const content = match[1];
      const titleMatch = REGEX_TITLE.exec(content);
      const linkMatch = REGEX_LINK.exec(content);
      const dateMatch = REGEX_DATE.exec(content);

      if (titleMatch && linkMatch) {
        initialItems.push({
          title: cleanWhitespace(normalizeDecodedText(stripTagsCompact(titleMatch[1]))),
          url: new URL(linkMatch[1], ENTRY_URL).href,
          dateText: cleanWhitespace(stripTagsCompact(dateMatch ? dateMatch[1] : ""))
        });
      }
    }

    // 日付パースと重複排除
    const preparedEvents = [];
    const seenUrls = new Set();
    for (const item of initialItems) {
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);

      const segments = item.dateText.split(/[~～〜-]/);
      const date_from = robustParseDate(segments[0]);
      if (!date_from) continue;

      preparedEvents.push({
        title: item.title,
        date_from,
        date_to: segments.length > 1 ? robustParseDate(segments[1]) : date_from,
        source_url: item.url,
        venue_name: VENUE_NAME,
        source_type: "web",
        body: `期間原文: ${item.dateText}`,
        price: null
      });
    }

    // 詳細情報をチャンクごとに並列取得
    const finalEvents = [];
    for (let i = 0; i < preparedEvents.length; i += CONCURRENCY) {
      const chunk = preparedEvents.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(ev => enrichEventDetail(ev)));
      finalEvents.push(...results);
    }

    // 共通処理で保存
    finalizeAndSaveEvents({
      venueId: VENUE_ID,
      venueName: VENUE_NAME,
      outputPath: OUTPUT_PATH,
      events: finalEvents,
      requireDateFrom: true
    });

    console.log(`[FINISH] 更新完了: ${finalEvents.length}件`);
    console.timeEnd("Performance");

  } catch (error) {
    handleCliFatalError(error, { prefix: `[${VENUE_ID} Fatal]` });
  }
}

main();
