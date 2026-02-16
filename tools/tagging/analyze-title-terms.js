#!/usr/bin/env node
"use strict";

// 既存イベントタイトルを集計し、タグルール見直しの根拠データを生成するスクリプト。
// 使い方: node tools/tagging/analyze-title-terms.js

const fs = require("fs");
const path = require("path");
const { applyTagsToEvent } = require("../../scripts/common/apply-event-tags");

const EVENTS_DIR = path.join(__dirname, "..", "..", "docs", "events");
const OUTPUT_PATH = path.join(__dirname, "title-term-analysis.json");

// 助詞・記号相当の一般語を除外して、特徴語を見つけやすくする。
const STOP_WORDS = new Set([
  "令和",
  "年度",
  "第",
  "開催",
  "情報",
  "案内",
  "高松",
  "松山",
  "愛媛",
  "徳島",
  "香川",
  "四国",
]);

function normalizeText(value) {
  if (!value) return "";
  return String(value)
    .replace(/&#\d+;/g, "")
    .replace(/[！!？?。、,，・:：;；/\\()（）\[\]【】「」『』<>＜＞"'`~〜★☆♪]/g, " ")
    .toLowerCase();
}

// 日本語/英字の連続を単純トークン化し、頻出語を抽出する。
function tokenizeTitle(title) {
  const normalized = normalizeText(title);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return tokens.filter((token) => {
    if (token.length < 2) return false;
    if (/^[0-9０-９-]+$/.test(token)) return false;
    if (STOP_WORDS.has(token)) return false;
    return true;
  });
}

function incrementCounter(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function summarizeCounter(counter, minCount, limit) {
  return [...counter.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

function runAnalysis() {
  const files = fs
    .readdirSync(EVENTS_DIR)
    .filter((filename) => filename.endsWith(".json"))
    .sort();

  const typeCounts = new Map();
  const typeTokenCounters = new Map();
  let totalEvents = 0;

  for (const fileName of files) {
    const filePath = path.join(EVENTS_DIR, fileName);
    const eventData = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const venueCategory = eventData?.venue_category ?? "";

    for (const eventItem of eventData.events ?? []) {
      totalEvents += 1;
      const result = applyTagsToEvent(eventItem, venueCategory, { overwrite: true });
      const type = result.tags.type;

      incrementCounter(typeCounts, type);

      if (!typeTokenCounters.has(type)) {
        typeTokenCounters.set(type, new Map());
      }
      const tokenCounter = typeTokenCounters.get(type);
      for (const token of tokenizeTitle(eventItem.title)) {
        incrementCounter(tokenCounter, token);
      }
    }
  }

  const topTokensByType = {};
  for (const [type, counter] of typeTokenCounters.entries()) {
    topTokensByType[type] = summarizeCounter(counter, 3, 30);
  }

  const report = {
    generated_at: new Date().toISOString(),
    total_events: totalEvents,
    type_counts: Object.fromEntries([...typeCounts.entries()].sort((a, b) => b[1] - a[1])),
    top_tokens_by_type: topTokensByType,
  };

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`analysis written: ${OUTPUT_PATH}`);
}

runAnalysis();
