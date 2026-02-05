// 終了から一定日数を超えたイベントを削除するスクリプト。
// 使い方: node scripts/filter-old-events.js
// 注意: docs/events/*.json の events 配列のみをフィルタする。

const fs = require("fs");
const path = require("path");
const { parseIsoDateStrict } = require("./lib/date");

// テンプレートは運用データではないため、自動更新対象から除外する。
const EXCLUDED_FILE_NAMES = new Set(["template.json"]);

// 何日経過したイベントを削除対象にするか（将来変更しやすいように定数化）
const CUTOFF_DAYS = 365;
// 1 日のミリ秒数
const DAY_MS = 24 * 60 * 60 * 1000;

// JST 基準の「今日」を作る（既存方針に合わせて Date.now() + 9h を使う）
function getJstTodayUtcDate() {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const year = jstNow.getUTCFullYear();
  const month = jstNow.getUTCMonth();
  const day = jstNow.getUTCDate();
  return new Date(Date.UTC(year, month, day));
}

// 1 ファイル分の events 配列をフィルタして結果を返す
function filterEvents(data, cutoffDate) {
  if (!Array.isArray(data?.events)) {
    return { skipped: true, beforeCount: 0, afterCount: 0, removedCount: 0, events: null };
  }

  const beforeCount = data.events.length;
  const events = data.events.filter((eventItem) => {
    const endText = eventItem?.date_to || eventItem?.date_from;
    const endDate = parseIsoDateStrict(endText);

    // 日付が不明・不正な場合は、汚染回避のために削除
    if (!endDate) return false;

    // cutoff より前なら削除対象
    return endDate >= cutoffDate;
  });

  const afterCount = events.length;
  const removedCount = beforeCount - afterCount;

  return { skipped: false, beforeCount, afterCount, removedCount, events };
}

function main() {
  // 実行場所ではなく、このスクリプト配置場所を起点に絶対パスを解決する
  const eventsDir = path.join(__dirname, "..", "docs", "events");
  const files = fs
    .readdirSync(eventsDir)
    .filter((fileName) => path.extname(fileName) === ".json")
    .filter((fileName) => !EXCLUDED_FILE_NAMES.has(fileName))
    .map((fileName) => path.join(eventsDir, fileName));

  const cutoffDate = new Date(getJstTodayUtcDate().getTime() - CUTOFF_DAYS * DAY_MS);

  console.log(`対象ファイル数: ${files.length}`);

  let updatedFiles = 0;
  let removedTotal = 0;

  files.forEach((filePath) => {
    const fileName = path.basename(filePath);

    try {
      const raw = fs.readFileSync(filePath, "utf-8");

      // 空ファイルは JSON.parse 前に明示的に検知し、処理継続する
      if (!raw.trim()) {
        throw new Error("ファイルが空です");
      }

      const data = JSON.parse(raw);
      const result = filterEvents(data, cutoffDate);

      if (result.skipped) {
        console.warn(`警告: events 配列がないためスキップしました -> ${fileName}`);
        return;
      }

      console.log(`${fileName}: before=${result.beforeCount}, after=${result.afterCount}, removed=${result.removedCount}`);

      removedTotal += result.removedCount;

      if (result.beforeCount !== result.afterCount) {
        const updatedData = { ...data, events: result.events };
        fs.writeFileSync(filePath, `${JSON.stringify(updatedData, null, 2)}\n`, "utf-8");
        updatedFiles += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ERROR] ${fileName}: ${message}`);
    }
  });

  console.log(`更新ファイル数: ${updatedFiles}`);
  console.log(`削除合計: ${removedTotal}`);

  if (updatedFiles === 0) {
    console.log("更新なし");
  }
}

try {
  main();
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`想定外のエラーが発生しました: ${message}`);
  process.exit(1);
}
