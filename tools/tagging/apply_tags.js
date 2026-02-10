#!/usr/bin/env node
"use strict";

// run-all から呼ばれるタグ付与の入口スクリプト。
// 実際のタグ判定ロジックは scripts/common/apply-event-tags.js に一本化し、
// ルール二重管理による判定差異を防ぐ。

const fs = require("fs");
const path = require("path");
const { processEventsFile } = require("../../scripts/common/apply-event-tags");
const { handleCliFatalError } = require("../../scripts/lib/cli_error");

const INPUT_DIR = path.join(__dirname, "..", "..", "docs", "events");
const EXCLUDED_FILE_NAMES = new Set(["template.json"]);

function main() {
  const files = fs
    .readdirSync(INPUT_DIR)
    .filter((filename) => filename.endsWith(".json"))
    .filter((filename) => !EXCLUDED_FILE_NAMES.has(filename));

  let updatedEventCount = 0;

  for (const filename of files) {
    const filePath = path.join(INPUT_DIR, filename);
    // 既存タグは上書きせず、不足分のみ埋める従来運用を維持する。
    const updated = processEventsFile(filePath, {
      overwrite: false,
      dryRun: false,
      log: false,
    });
    updatedEventCount += updated;
  }

  console.log(`tags付与件数: ${updatedEventCount}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    handleCliFatalError(error, { prefix: "[apply-tags]" });
  }
}
