/**
 * scripts/lib/date_window.js
 *
 * 期間フィルタ（例: 過去365日より古いイベント除外）を共通化するユーティリティ。
 * 日付境界の計算やイベント判定を 1 箇所で管理し、
 * スクリプトごとの実装差による判定ゆれを防ぐ。
 */

const { parseIsoDateStrict } = require("./date");

// 既存運用に合わせたデフォルト値（方針メモ準拠）。
const DEFAULT_PAST_DAYS = 365;

// 1日をミリ秒で表した定数。
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * JST基準の「今日 00:00」を UTC Date として返す。
 *
 * @param {number} [nowMs] - テスト時に固定時刻を差し込みたい場合の UNIX ms。
 * @returns {Date}
 */
function getJstTodayUtcDate(nowMs = Date.now()) {
  // JSTはUTC+9時間なので、現在時刻に +9h して UTC の日付部を取り出す。
  const jstNow = new Date(nowMs + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate()));
}

/**
 * 過去フィルタのカットオフ日（today - pastDays）を返す。
 *
 * @param {{pastDays?: number, nowMs?: number}} [options]
 * @returns {Date}
 */
function buildPastCutoffDate(options = {}) {
  const pastDays = Number.isInteger(options.pastDays) ? options.pastDays : DEFAULT_PAST_DAYS;
  const todayUtc = getJstTodayUtcDate(options.nowMs);
  return new Date(todayUtc.getTime() - pastDays * DAY_MS);
}

/**
 * Date(UTC) を YYYY-MM-DD へ変換する。
 *
 * @param {Date} utcDate
 * @returns {string}
 */
function formatUtcDateToIso(utcDate) {
  return `${utcDate.getUTCFullYear()}-${String(utcDate.getUTCMonth() + 1).padStart(2, "0")}-${String(
    utcDate.getUTCDate()
  ).padStart(2, "0")}`;
}

/**
 * イベントを「過去期間フィルタ」に照らして判定する。
 *
 * @param {object} eventItem
 * @param {Date} cutoffDate
 * @param {{fallbackToDateFrom?: boolean, keepOnMissingDate?: boolean, keepOnInvalidDate?: boolean}} [options]
 * @returns {{keep: boolean, reason: "in_range"|"expired"|"missing_date"|"invalid_date"}}
 */
function evaluateEventAgainstPastCutoff(eventItem, cutoffDate, options = {}) {
  const fallbackToDateFrom = options.fallbackToDateFrom !== false;
  const keepOnMissingDate = options.keepOnMissingDate === true;
  const keepOnInvalidDate = options.keepOnInvalidDate === true;

  const dateText = fallbackToDateFrom ? eventItem?.date_to || eventItem?.date_from : eventItem?.date_to;
  if (!dateText) {
    return { keep: keepOnMissingDate, reason: "missing_date" };
  }

  const endDateUtc = parseIsoDateStrict(dateText);
  if (!endDateUtc) {
    return { keep: keepOnInvalidDate, reason: "invalid_date" };
  }

  if (endDateUtc < cutoffDate) {
    return { keep: false, reason: "expired" };
  }

  return { keep: true, reason: "in_range" };
}

module.exports = {
  DEFAULT_PAST_DAYS,
  getJstTodayUtcDate,
  buildPastCutoffDate,
  formatUtcDateToIso,
  evaluateEventAgainstPastCutoff,
};
