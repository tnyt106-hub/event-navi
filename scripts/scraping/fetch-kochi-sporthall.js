#!/usr/bin/env node
"use strict";

const path = require("path");
const { fetchText } = require("../lib/http");
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { handleCliFatalError } = require("../lib/cli_error");
const { createEvent } = require("../lib/schema");
const { normalizeWhitespace } = require("../lib/text");

const VENUE_ID = "kochi-sporthall"; 
const ENTRY_URL = "https://docs.google.com/spreadsheets/d/1F0iBntJPjSgT_QmOZ7n0ZNXUZ2mvU-J9Jrsy72p843w/pub?gid=1515611641&single=true&output=csv";
const OFFICIAL_URL = "https://www.kochi-kenmin.org/events/";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", `${VENUE_ID}.json`);

async function main() {
  try {
    const csvData = await fetchText(ENTRY_URL);
    const lines = csvData.split(/\r?\n/).map(line => 
      line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.replace(/^"|"$/g, "").trim())
    );

    let currentYear = 2025; // 令和7年度の開始年
    let currentMonth = 2;
    const events = [];
    
    let lastValidDay = null;
    let lastValidTitle = "";

    for (const cols of lines) {
      if (cols.length < 3) continue;

      const lineStr = cols.join(" ");

      // --- 1. 月の更新ロジックを強化 ---
      // "2月 行事予定表" や "3月 行事予定表" を検知
      // 全体の文字列から "数字 + 月" を探し、後ろに "行事" が続くものを優先
      const monthUpdate = /(\d{1,2})\s*月\s*行\s*事/.exec(lineStr);
      if (monthUpdate) {
        currentMonth = parseInt(monthUpdate[1], 10);
        // 1-3月は年度(令和7年=2025年)に対して翌年(2026年)にする
        currentYear = (currentMonth >= 1 && currentMonth <= 3) ? 2026 : 2025;
        lastValidDay = null; 
        lastValidTitle = "";
        console.log(`[DEBUG] スイッチ: ${currentYear}年${currentMonth}月`);
        continue;
      }

      // --- 2. 日付の特定 ---
      const dayStr = cols[0];
      if (/^\d{1,2}$/.test(dayStr)) {
        lastValidDay = dayStr.padStart(2, "0");
      }

      // --- 3. タイトルの特定 (前行からの継続を考慮) ---
      let title = normalizeWhitespace(cols[2] || "");
      if (title && !/^(行事名|曜|日|※)/.test(title)) {
        lastValidTitle = title;
      } else if (!title && lastValidDay) {
        // タイトルが空だが、日付があるか、あるいは時間が入っている場合は継続とみなす
        title = lastValidTitle;
      }

      if (!lastValidDay || !title || title === "行事名") continue;

      const dateStr = `${currentYear}-${String(currentMonth).padStart(2, "0")}-${lastValidDay}`;

      // --- 4. 時間と会場の解析 ---
      const venueConfig = [
        { index: 3, name: "主競技場" },
        { index: 4, name: "補助競技場" },
        { index: 6, name: "補助競技場" }
      ];

      let startTime = null;
      let endTime = null;
      let detectedVenues = [];

      for (const config of venueConfig) {
        const timeCell = cols[config.index];
        if (timeCell && timeCell.includes("～")) {
          detectedVenues.push(config.name);
          const timeMatch = /(\d{1,2}:\d{2})[～~](\d{1,2}:\d{2})/.exec(timeCell);
          if (timeMatch) {
            startTime = timeMatch[1].padStart(5, "0");
            endTime = timeMatch[2].padStart(5, "0");
          }
        }
      }

      // 時間情報がない行（ただの注釈行など）は飛ばす
      if (!startTime) continue;

      const venueLabel = `高知県立県民体育館（${[...new Set(detectedVenues)].join("・")}）`;

      events.push(createEvent({
        title: title.replace(/\n/g, " "),
        date_from: dateStr,
        date_to: dateStr,
        start_time: startTime,
        end_time: endTime,
        source_url: OFFICIAL_URL,
        source_type: "web",
        venue_name: venueLabel
      }));
    }

    // 重複カット (日付、タイトル、開始時間でユニーク化)
    const uniqueEvents = Array.from(new Map(
      events.map(e => [`${e.date_from}_${e.title}_${e.start_time}`, e])
    ).values());

    console.log(`[INFO] venue_id=${VENUE_ID}`);
    console.log(`[INFO] events_built=${uniqueEvents.length}`);

    finalizeAndSaveEvents({
      venueId: VENUE_ID,
      outputPath: OUTPUT_PATH,
      events: uniqueEvents,
      requireDateFrom: true
    });
    
  } catch (error) {
    handleCliFatalError(error, { prefix: `[${VENUE_ID} Fatal]` });
  }
}

main();
