#!/usr/bin/env node
"use strict";

// このスクリプトは docs/events/*.json を読み込み、tags が未設定の event に
// 簡易ルールで tags を付与して同じファイルへ書き戻します。
// 既に tags がある event は上書きしません。

const fs = require("fs");
const path = require("path");

// ルールは将来 JSON 化する前提で、このファイル内に仮実装しています。
const TYPE_RULES = [
  {
    type: "sports",
    // 優先順を保つため、配列順に判定します。
    keywords: [
      "試合",
      "大会",
      "リーグ",
      "カップ",
      "選手権",
      "駅伝",
      "マラソン",
      "ランニング",
      "サッカー",
      "野球",
      "バスケ",
      "バレー",
      "テニス",
      "柔道",
      "剣道",
      "相撲",
    ],
  },
  {
    type: "exhibition",
    keywords: ["展覧会", "企画展", "特別展", "常設展", "回顧展", "展示"],
  },
  {
    type: "performance",
    keywords: ["公演", "ライブ", "コンサート", "演奏会", "舞台", "上演"],
  },
  {
    type: "workshop",
    keywords: ["ワークショップ", "体験", "教室", "講座"],
  },
  {
    type: "lecture",
    keywords: ["講演", "トーク", "シンポジウム", "セミナー"],
  },
  {
    type: "festival",
    keywords: ["祭", "フェス", "マルシェ", "市", "フェスタ"],
  },
];

// ジャンル判定は簡易的に最大2件だけ付与します。
const GENRE_RULES = [
  { genre: "sports", keywords: TYPE_RULES[0].keywords },
  { genre: "art", keywords: TYPE_RULES[1].keywords },
  { genre: "music", keywords: TYPE_RULES[2].keywords },
  { genre: "education", keywords: [...TYPE_RULES[3].keywords, ...TYPE_RULES[4].keywords] },
  { genre: "festival", keywords: TYPE_RULES[5].keywords },
];

const INPUT_DIR = path.join(__dirname, "..", "..", "docs", "events");

// 文字列に含まれるかどうかを判定する共通関数です。
function containsKeyword(text, keywords) {
  if (!text) return false;
  return keywords.some((keyword) => text.includes(keyword));
}

// type は必ず1つだけ付与します。ヒットしない場合は other とします。
function detectType(title) {
  for (const rule of TYPE_RULES) {
    if (containsKeyword(title, rule.keywords)) {
      return rule.type;
    }
  }
  return "other";
}

// genres は最大2件に制限します。
function detectGenres(title, type) {
  const genres = [];

  for (const rule of GENRE_RULES) {
    if (containsKeyword(title, rule.keywords)) {
      genres.push(rule.genre);
    }
    if (genres.length >= 2) {
      break;
    }
  }

  // タイトルから判定できなかった場合は type に応じた簡易ジャンルを入れます。
  if (genres.length === 0) {
    if (type === "sports") genres.push("sports");
    if (type === "exhibition") genres.push("art");
    if (type === "performance") genres.push("music");
    if (type === "workshop" || type === "lecture") genres.push("education");
    if (type === "festival") genres.push("festival");
  }

  return genres.slice(0, 2);
}

// flags は最大2件に制限します。
function detectFlags({ title, price, start_time }) {
  const flags = [];
  const priceText = price || "";

  if (priceText.includes("無料") || priceText.includes("0円")) {
    flags.push("free");
  }

  // 金額が含まれている場合は有料扱いにします。
  if (/[0-9]/.test(priceText) || priceText.includes("円")) {
    if (!flags.includes("paid")) {
      flags.push("paid");
    }
  }

  if (containsKeyword(title, ["要予約", "予約制", "事前申込"])) {
    flags.push("reservation_required");
  }

  const isNightByTitle = containsKeyword(title, ["夜間", "ナイト"]);
  let isNightByTime = false;
  if (start_time) {
    // 24時間表記の HH:MM 形式を想定し、18:00 以上で夜間扱いにします。
    const [hourText, minuteText] = start_time.split(":");
    const hour = Number(hourText);
    const minute = Number(minuteText);
    if (!Number.isNaN(hour) && !Number.isNaN(minute)) {
      isNightByTime = hour > 18 || (hour === 18 && minute >= 0);
    }
  }

  if (isNightByTitle || isNightByTime) {
    flags.push("night");
  }

  return flags.slice(0, 2);
}

function applyTagsToEvent(event) {
  const type = detectType(event.title || "");
  const genres = detectGenres(event.title || "", type);
  const flags = detectFlags({
    title: event.title || "",
    price: event.price,
    start_time: event.start_time,
  });

  return { type, genres, flags };
}

// イベント配列に対してタグを付与する共通処理（既存タグは上書きしない）。
function applyTagsToEventsData(data, options = {}) {
  const events = Array.isArray(data?.events) ? data.events : [];
  const overwrite = Boolean(options.overwrite);
  let updatedCount = 0;
  const updatedTags = [];

  for (const event of events) {
    if (event.tags && !overwrite) {
      continue;
    }

    const tags = applyTagsToEvent(event);
    event.tags = tags;
    updatedCount += 1;
    updatedTags.push(tags);
  }

  return { updatedCount, updatedTags };
}

function main() {
  const files = fs
    .readdirSync(INPUT_DIR)
    .filter((filename) => filename.endsWith(".json"));

  let updatedEventCount = 0;
  const typeCounts = {};

  for (const filename of files) {
    const filePath = path.join(INPUT_DIR, filename);
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data.events)) {
      continue;
    }

    const beforeCount = updatedEventCount;
    const result = applyTagsToEventsData(data, { overwrite: false });
    updatedEventCount += result.updatedCount;

    for (const tags of result.updatedTags) {
      typeCounts[tags.type] = (typeCounts[tags.type] || 0) + 1;
    }

    if (updatedEventCount > beforeCount) {
      fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    }
  }

  // 付与件数と type 分布をログ出力します。
  console.log(`tags付与件数: ${updatedEventCount}`);
  console.log("type分布:");
  for (const [type, count] of Object.entries(typeCounts)) {
    console.log(`- ${type}: ${count}`);
  }
}

module.exports = { applyTagsToEvent, applyTagsToEventsData };

if (require.main === module) {
  main();
}
