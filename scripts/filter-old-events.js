// 終了から一定日数を超えたイベントを削除するスクリプト。
// 使い方: node scripts/filter-old-events.js
// 注意: docs/events/*.json の events 配列のみをフィルタする。

const fs = require("fs");
const path = require("path");

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

// YYYY-MM-DD 形式のみを受け付ける厳密な日付パース
function parseDateStrict(dateText) {
  if (!dateText) return null;
  const match = String(dateText).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return null;

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(utcDate.getTime())) return null;

  // 存在しない日付（例: 2024-02-30）を弾く
  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day
  ) {
    return null;
  }

  return utcDate;
}

// 1 ファイル分の events 配列をフィルタして結果を返す
function filterEvents(data, cutoffDate) {
  if (!Array.isArray(data?.events)) {
    return { skipped: true, beforeCount: 0, afterCount: 0, removedCount: 0, events: null };
  }

  const beforeCount = data.events.length;
  const events = data.events.filter((eventItem) => {
    const endText = eventItem?.date_to || eventItem?.date_from;
    const endDate = parseDateStrict(endText);

    // 日付が不明・不正な場合は安全側で残す
    if (!endDate) return true;

    // cutoff より前なら削除対象
    return endDate >= cutoffDate;
  });

  const afterCount = events.length;
  const removedCount = beforeCount - afterCount;

  return { skipped: false, beforeCount, afterCount, removedCount, events };
}

function main() {
  const eventsDir = path.join(__dirname, "../docs/events");
  const files = fs
    .readdirSync(eventsDir)
    .filter((fileName) => path.extname(fileName) === ".json")
    .map((fileName) => path.join(eventsDir, fileName));

  const cutoffDate = new Date(getJstTodayUtcDate().getTime() - CUTOFF_DAYS * DAY_MS);

  console.log(`対象ファイル数: ${files.length}`);

  let updatedFiles = 0;
  let removedTotal = 0;

  files.forEach((filePath) => {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    const result = filterEvents(data, cutoffDate);

    if (result.skipped) {
      console.warn(`警告: events 配列がないためスキップしました -> ${path.basename(filePath)}`);
      return;
    }

    console.log(
      `${path.basename(filePath)}: before=${result.beforeCount}, after=${result.afterCount}, removed=${result.removedCount}`
    );

    removedTotal += result.removedCount;

    if (result.beforeCount !== result.afterCount) {
      const updatedData = { ...data, events: result.events };
      fs.writeFileSync(filePath, `${JSON.stringify(updatedData, null, 2)}\n`, "utf-8");
      updatedFiles += 1;
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
