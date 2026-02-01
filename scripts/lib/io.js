// JSON を見やすく整形して保存する共通ユーティリティ。
// すべてのスクレイピングスクリプトで同じ保存形式を使うために用意する。

const fs = require("fs");

// JSON を2スペースインデント + 末尾改行で UTF-8 保存する。
function writeJsonPretty(filePath, obj) {
  const json = `${JSON.stringify(obj, null, 2)}\n`;
  fs.writeFileSync(filePath, json, "utf8");
}

module.exports = {
  writeJsonPretty,
};
