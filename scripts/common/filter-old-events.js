// 終了から一定日数を超えたイベントを削除するスクリプト。
// 使い方: node scripts/common/filter-old-events.js
// 注意: docs/events/*.json の events 配列のみをフィルタする。

const fs = require("fs");
const path = require("path");
const { buildPastCutoffDate, evaluateEventAgainstPastCutoff } = require("../lib/date_window");
const { writeJsonPretty } = require("../lib/io");
const { parseJsonOrThrowTyped } = require("../lib/json");

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

// ファイルごとの集計結果を「列が揃ったログ文字列」に変換する。
// 動的に幅を計算することで、ファイル名長や件数の桁数が混在しても読みやすさを維持する。
function formatFilterSummaryLines(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  // ファイル名列の幅は最長ファイル名に合わせる。
  const fileNameWidth = rows.reduce((maxWidth, row) => {
    const width = String(row.fileName || "").length;
    return Math.max(maxWidth, width);
  }, 0);

  // 数値列は「見出しの長さ」と「実値の最大桁数」の大きい方を採用する。
  // こうすることで、見出しを含めても列が崩れない。
  const beforeValueWidth = rows.reduce((maxWidth, row) => {
    const width = String(row.beforeCount).length;
    return Math.max(maxWidth, width);
  }, String("before").length);
  const afterValueWidth = rows.reduce((maxWidth, row) => {
    const width = String(row.afterCount).length;
    return Math.max(maxWidth, width);
  }, String("after").length);
  const removedValueWidth = rows.reduce((maxWidth, row) => {
    const width = String(row.removedCount).length;
    return Math.max(maxWidth, width);
  }, String("removed").length);

  const headerLine = `${"file".padEnd(fileNameWidth)} | ${"before".padStart(
    beforeValueWidth
  )} | ${"after".padStart(afterValueWidth)} | ${"removed".padStart(removedValueWidth)}`;
  const separatorLine = `${"-".repeat(fileNameWidth)}-+-${"-".repeat(
    beforeValueWidth
  )}-+-${"-".repeat(afterValueWidth)}-+-${"-".repeat(removedValueWidth)}`;

  const dataLines = rows.map((row) => {
    return `${String(row.fileName).padEnd(fileNameWidth)} | ${String(row.beforeCount).padStart(
      beforeValueWidth
    )} | ${String(row.afterCount).padStart(afterValueWidth)} | ${String(
      row.removedCount
    ).padStart(removedValueWidth)}`;
  });

  return [headerLine, separatorLine, ...dataLines];
}

function main() {
  // 実行場所ではなく、このスクリプト配置場所を起点に絶対パスを解決する
  const eventsDir = path.join(__dirname, "..", "..", "docs", "events");
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
  // 1行ずつ生ログを出す代わりに、最後に整形表示するための中間結果。
  const summaryRows = [];

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

      summaryRows.push({
        fileName,
        beforeCount: result.beforeCount,
        afterCount: result.afterCount,
        removedCount: result.removedCount,
      });

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

  // 施設ごとの件数サマリは、列を揃えてからまとめて表示する。
  // これにより run-all.js 経由で実行した場合でも左右位置のズレを防止できる。
  const summaryLines = formatFilterSummaryLines(summaryRows);
  summaryLines.forEach((line) => {
    console.log(line);
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
