// JSON を見やすく整形して保存する共通ユーティリティ。
// すべてのスクレイピングスクリプトで同じ保存形式を使うために用意する。

const fs = require("fs");
const path = require("path");
const { createEvent } = require("./schema");

// 同一ディレクトリ内へ一時ファイルを書いてから rename することで、
// 書き込み途中の破損ファイルが公開ファイルとして見える時間を無くす。
function writeTextAtomic(filePath, text, encoding = "utf8") {
  const dirPath = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const tempName = `.${baseName}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  const tempPath = path.join(dirPath, tempName);

  fs.writeFileSync(tempPath, text, encoding);
  fs.renameSync(tempPath, filePath);
}

// ルートJSONに events 配列がある場合は、保存直前にイベント項目を標準化する。
// これにより、各スクレイパー実装の差異があっても、
// 出力時点で EVENT_TEMPLATE に沿った統一構造を保証できる。
function normalizeEventPayload(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (!Array.isArray(obj.events)) return obj;

  return {
    ...obj,
    events: obj.events.map((eventItem) => createEvent(eventItem || {})),
  };
}

// JSON を2スペースインデント + 末尾改行で UTF-8 保存する。
function writeJsonPretty(filePath, obj) {
  const normalized = normalizeEventPayload(obj);
  const json = `${JSON.stringify(normalized, null, 2)}\n`;
  writeTextAtomic(filePath, json, "utf8");
}

// JSON 保存前に 0 件を検知してスキップする。
function saveEventJson(path, data) {
  const events = Array.isArray(data) ? data : data?.events;
  const count = Array.isArray(events) ? events.length : 0;

  if (!events || count === 0) {
    console.warn(`[SKIP] データの件数が0件のため、${path} の更新をスキップしました。`);
    return false;
  }

  writeJsonPretty(path, data);
  console.log(`[SUCCESS] ${count} 件のデータを ${path} に保存しました。`);
  return true;
}

module.exports = {
  normalizeEventPayload,
  writeTextAtomic,
  writeJsonPretty,
  saveEventJson,
};
