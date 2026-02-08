// fetch スクリプトの出力保存を統一する共通ユーティリティ。
// 保存前の最小検証と、総件数を含む結果ログの出力をまとめて行う。

const { writeJsonPretty } = require("./io");
const { ERROR_TYPES, TypedError } = require("./error_types");

// YYYY-MM-DD 形式の当日文字列を返す。
function buildTodayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// イベント配列が保存可能かを検証する。
function validateEvents(events, options = {}) {
  const requireDateFrom = options.requireDateFrom !== false;

  if (!Array.isArray(events) || events.length === 0) {
    throw new TypedError(ERROR_TYPES.EMPTY_RESULT, "イベントが0件のため上書きしません。");
  }

  if (requireDateFrom) {
    const dateCount = events.filter((event) => event && event.date_from).length;
    if (dateCount === 0) {
      throw new TypedError(ERROR_TYPES.EMPTY_RESULT, "date_from が1件も作成できませんでした。");
    }
  }
}

// 保存用の JSON ペイロードを生成する。
function buildEventOutputData(params) {
  const {
    venueId,
    events,
    venueName = undefined,
    lastSuccessAt = buildTodayIsoDate(),
    extraData = {},
  } = params;

  return {
    venue_id: venueId,
    ...(venueName ? { venue_name: venueName } : {}),
    last_success_at: lastSuccessAt,
    events,
    ...extraData,
  };
}

// 共通形式で保存完了ログを出す。
function logSaveResult(params) {
  const { venueId, outputPath, events } = params;
  console.log(`[RESULT] venue_id=${venueId} total_events=${events.length} output=${outputPath}`);
}

// fetch スクリプトで使う保存処理の共通入口。
function finalizeAndSaveEvents(params) {
  const {
    venueId,
    outputPath,
    events,
    venueName,
    lastSuccessAt,
    extraData,
    requireDateFrom = true,
    beforeWrite,
  } = params;

  validateEvents(events, { requireDateFrom });

  const data = buildEventOutputData({
    venueId,
    events,
    venueName,
    lastSuccessAt,
    extraData,
  });

  // タグ付けなど、保存前に呼び出し側で必要な最終加工を差し込めるようにする。
  if (typeof beforeWrite === "function") {
    beforeWrite(data);
  }

  writeJsonPretty(outputPath, data);
  logSaveResult({ venueId, outputPath, events });

  return data;
}

module.exports = {
  buildTodayIsoDate,
  validateEvents,
  buildEventOutputData,
  logSaveResult,
  finalizeAndSaveEvents,
};
