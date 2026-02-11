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

/**
 * 実行時を基準に、CSV内の月情報から適切な「年」を判定する
 */
function getTargetYear(targetMonth) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // 現在が年末（10-12月）で、CSVが1-3月の予定なら翌年とする
  if (currentMonth >= 10 && targetMonth <= 3) {
    return currentYear + 1;
  }
  // 現在が年始（1-3月）で、CSVが10-12月の予定なら前年とする
  if (currentMonth <= 3 && targetMonth >= 10) {
    return currentYear - 1;
  }
  return currentYear;
}

async function main() {
  try {
    const csvData = await fetchText(ENTRY_URL);
    const lines = csvData.split(/\r?\n/).map(line => 
      line.split(/,(?=(?:(?:[^\"]*\"){2})*[^\"]*$)/).map(c => c.replace(/^\"|\"$/g, "").trim())
    );

    let currentYear = new Date().getFullYear();
    let currentMonth = new Date().getMonth() + 1;
    const events = [];
    
    let lastValidDay = null;
    let lastValidTitle = "";

    for (const cols of lines) {
      if (cols.length < 3) continue;

      const lineStr = cols.join(" ");

      // --- 1. 月の更新と年の自動計算 ---
      const monthUpdate = /(\d{1,2})\s*月\s*行\s*事/.exec(lineStr);
      if (monthUpdate) {
        currentMonth = parseInt(monthUpdate[1], 10);
        currentYear = getTargetYear(currentMonth);
        lastValidDay = null; 
        lastValidTitle = "";
        continue;
      }

      // --- 2. 日付の特定 ---
      const dayStr = cols[0];
      if (/^\d{1,2}$/.test(dayStr)) {
        lastValidDay = dayStr.padStart(2, "0");
      }

      // --- 3. タイトルの特定 ---
      let title = normalizeWhitespace(cols[2] || "");
      if (title && !/^(行事名|曜|日|※)/.test(title)) {
        lastValidTitle = title;
      } else if (!title && lastValidDay) {
        title = lastValidTitle;
      }

      if (!lastValidDay || !title || title === "行事名") continue;

      // 日付の妥当性チェック
      const dateStr = `${currentYear}-${String(currentMonth).padStart(2, "0")}-${lastValidDay}`;
      const d = new Date(currentYear, currentMonth - 1, parseInt(lastValidDay, 10));
      if (d.getMonth() !== currentMonth - 1) continue;

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

    const uniqueEvents = Array.from(new Map(
      events.map(e => [`${e.date_from}_${e.title}_${e.start_time}`, e])
    ).values());

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
