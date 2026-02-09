// 終了から一定日数を超えたイベントを削除するスクリプト。
// 使い方: node scripts/filter-old-events.js
// 注意: docs/events/*.json の events 配列のみをフィルタする。

const fs = require("fs");
const path = require("path");
const { buildPastCutoffDate, evaluateEventAgainstPastCutoff } = require("./lib/date_window");
const { writeJsonPretty } = require("./lib/io");
const { parseJsonOrThrowTyped } = require("./lib/json");

// テンプレートは運用データではないため、自動更新対象から除外する。
const EXCLUDED_FILE_NAMES = new Set(["template.json"]);

// 1 ファイル分の events 配列をフィルタして結果を返す
function filterEvents(data, cutoffDate) {
  if (!Array.isArray(data?.events)) {
    return { skipped: true, beforeCount: 0, afterCount: 0, removedCount: 0, events: null };
  }

  const beforeCount = data.events.length;
  const events = data.events.filter((eventItem) => {
    // date_to（なければ date_from）を使って、共通ルールで保持可否を判定する。
    const evaluation = evaluateEventAgainstPastCutoff(eventItem, cutoffDate, {
      fallbackToDateFrom: true,
      // filter-old-events はデータ汚染回避のため、日付欠損・不正を保持しない。
      keepOnMissingDate: false,
      keepOnInvalidDate: false,
    });
    return evaluation.keep;
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

  // 過去365日フィルタの閾値は共通モジュールから取得する。
  const cutoffDate = buildPastCutoffDate();

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

      const data = parseJsonOrThrowTyped(raw, `events file (${filePath})`);
      const result = filterEvents(data, cutoffDate);

      if (result.skipped) {
        console.warn(`警告: events 配列がないためスキップしました -> ${fileName}`);
        return;
      }

      console.log(`${fileName}: before=${result.beforeCount}, after=${result.afterCount}, removed=${result.removedCount}`);

      removedTotal += result.removedCount;

      if (result.beforeCount !== result.afterCount) {
        const updatedData = { ...data, events: result.events };
        // 原子的保存で中断時の JSON 破損を避ける。
        writeJsonPretty(filePath, updatedData);
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
