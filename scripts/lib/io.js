// JSON を見やすく整形して保存する共通ユーティリティ。
// すべてのスクレイピングスクリプトで同じ保存形式を使うために用意する。

const fs = require("fs");

// JSON を2スペースインデント + 末尾改行で UTF-8 保存する。
function writeJsonPretty(filePath, obj) {
  const json = `${JSON.stringify(obj, null, 2)}\n`;
  fs.writeFileSync(filePath, json, "utf8");
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
  writeJsonPretty,
  saveEventJson,
};
