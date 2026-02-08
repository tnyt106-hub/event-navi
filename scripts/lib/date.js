/**
 * scripts/lib/date.js
 * 日付解析・判定の共通ライブラリ（強化版）
 */

/**
 * テキストから日付範囲（YYYY-MM-DD）を抽出する
 * @param {string} text - 解析対象テキスト（例: "2/10", "2026年2月10日〜15日", "2/10(火)〜2/15(日)"）
 * @param {Date} referenceDate - 基準日（デフォルトは現在時刻）
 * @returns {object|null} { date_from, date_to }
 */
function extractDateRange(text, referenceDate = new Date()) {
  if (!text) return null;

  // 1. 全角数字を半角に変換し、曜日（月〜日）などのノイズを除去
  let normalized = text
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .replace(/[\(（][月火水木金土日][\)）]/g, "");

  // 2. 「年」「月」「日」を「/」に統一して解析しやすくする
  normalized = normalized.replace(/年|月/g, "/").replace(/日/g, "");

  // 3. 日付パターンを抽出 (YYYY/MM/DD または MM/DD)
  const dateRegex = /(\d{4}\/)?(\d{1,2})\/(\d{1,2})/g;
  const matches = [...normalized.matchAll(dateRegex)];

  if (matches.length === 0) return null;

  const currentYear = referenceDate.getFullYear();
  const currentMonth = referenceDate.getMonth() + 1;

  const parseMatch = (m) => {
    // 年の指定があればそれを使用、なければ基準日の年を使用
    let y = m[1] ? parseInt(m[1].replace("/", ""), 10) : currentYear;
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);

    // 【年越し補正】
    // 年の指定がない場合で、基準日が11-12月かつ取得月が1-2月の場合は翌年とみなす
    if (!m[1]) {
      if (currentMonth >= 11 && month <= 2) {
        y++;
      }
    }

    return {
      date: `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      year: y
    };
  };

  const start = parseMatch(matches[0]);
  // 終了日がない場合は開始日と同じにする。複数ある場合は最後のマッチを使用
  let end = matches.length > 1 ? parseMatch(matches[matches.length - 1]) : { ...start };

  // 【期間逆転補正】
  // 例: "12/31〜1/2" で年の記述がない場合、終了日を翌年にする
  if (end.date < start.date && !matches[matches.length - 1][1]) {
    const nextYear = start.year + 1;
    end.date = end.date.replace(/^\d{4}/, nextYear);
  }

  return {
    date_from: start.date,
    date_to: end.date,
  };
}

/**
 * ISO日付が対象範囲内か判定する
 */
function isDateInRange(isoDate, range) {
  if (!isoDate || !range) return false;
  const target = new Date(`${isoDate}T00:00:00+09:00`);
  const start = new Date(`${range.date_from}T00:00:00+09:00`);
  const end = new Date(`${range.date_to}T00:00:00+09:00`);
  return target >= start && target <= end;
}

/**
 * 日本語日付テキストで頻出する表記揺れを正規化する。
 *
 * 実装意図:
 * - 施設ごとに散らばっていた「全角数字→半角」「区切り文字の統一」を共通化し、
 *   将来の修正漏れを防ぐ。
 * - options で施設ごとの微差（例: から/まで、カンマ）を吸収できるようにする。
 *
 * @param {string} text
 * @param {object} options
 * @param {boolean} options.removeParenthesizedText - 丸括弧内テキストを除去するか
 * @param {boolean} options.replaceRangeWords - 「から」「まで」を範囲記号へ寄せるか
 * @param {boolean} options.normalizeComma - 読点/カンマを "," に揃えるか
 * @returns {string}
 */
function normalizeJapaneseDateText(text, options = {}) {
  if (!text) return "";

  const {
    removeParenthesizedText = false,
    replaceRangeWords = false,
    normalizeComma = false,
  } = options;

  let normalized = String(text).replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));

  if (removeParenthesizedText) {
    normalized = normalized.replace(/[（(][^）)]*[）)]/g, " ");
  }

  normalized = normalized
    .replace(/[／]/g, "/")
    .replace(/[．]/g, ".")
    .replace(/[〜～]/g, "~")
    .replace(/[－–—]/g, "-");

  if (replaceRangeWords) {
    normalized = normalized.replace(/から/g, "~").replace(/まで/g, "~");
  }

  if (normalizeComma) {
    normalized = normalized.replace(/[、，]/g, ",");
  }

  return normalized.replace(/\s+/g, " ").trim();
}

/**
 * 年付き/年なし（月日のみ）の日付要素を抽出する。
 *
 * @param {string} text
 * @param {object} options
 * @param {boolean} options.allowYearlessMonthDay - 月日のみを抽出対象に含めるか
 * @returns {Array<{year: number|null, month: number, day: number}>}
 */
function extractDatePartsFromJapaneseText(text, options = {}) {
  const { allowYearlessMonthDay = true } = options;
  const normalized = String(text || "");
  const results = [];
  let masked = normalized;

  for (const match of normalized.matchAll(/(\d{4})\s*[年/.]\s*(\d{1,2})\s*[月/.]\s*(\d{1,2})\s*日?/g)) {
    results.push({
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    });

    // 年付き部分をマスクして、後段の月日抽出で重複追加されることを防ぐ。
    if (match.index !== undefined) {
      const mask = " ".repeat(match[0].length);
      masked = masked.slice(0, match.index) + mask + masked.slice(match.index + match[0].length);
    }
  }

  if (!allowYearlessMonthDay) {
    return results;
  }

  for (const match of masked.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    results.push({
      year: null,
      month: Number(match[1]),
      day: Number(match[2]),
    });
  }

  return results;
}

// ローカルタイム基準で妥当な年月日かを検証して Date を作る。
function buildLocalDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

// UTC基準で妥当な年月日かを検証して Date を作る。
function buildUtcDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

// Date を YYYY-MM-DD へ整形する（ローカル時刻ベース）。
function formatIsoDateFromLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Date を YYYY-MM-DD へ整形する（UTCベース）。
function formatIsoDateFromUtcDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * YYYY-MM-DD 形式の日付文字列を厳密に Date(ローカル時刻) へ変換する
 * - 形式不正や存在しない日付(例: 2024-02-30)は null を返す
 * - fetch 系スクリプトでローカル日付を扱う処理を共通化する
 *
 * @param {string} isoDateText
 * @returns {Date|null}
 */
function parseIsoDateAsLocalStrict(isoDateText) {
  if (!isoDateText) return null;

  const match = String(isoDateText).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return null;

  return buildLocalDate(year, month, day);
}

/**
 * JST基準の「今日 00:00」を UTC Date として返す
 *
 * @param {number} [nowMs]
 * @returns {Date}
 */
function getJstTodayUtcDate(nowMs = Date.now()) {
  const jstNow = new Date(nowMs + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate()));
}

/**
 * YYYY-MM-DD 形式の日付文字列を厳密に Date(UTC) へ変換する
 * - 形式不正や存在しない日付(例: 2024-02-30)は null を返す
 * - メンテナンス系スクリプトで共通利用するために追加
 *
 * @param {string} isoDateText
 * @returns {Date|null}
 */
function parseIsoDateStrict(isoDateText) {
  if (!isoDateText) return null;

  const match = String(isoDateText).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return null;

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(utcDate.getTime())) return null;

  // Date が自動補正したケース（存在しない日付）を除外
  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day
  ) {
    return null;
  }

  return utcDate;
}

module.exports = {
  extractDateRange,
  isDateInRange,
  normalizeJapaneseDateText,
  extractDatePartsFromJapaneseText,
  buildLocalDate,
  buildUtcDate,
  formatIsoDateFromLocalDate,
  formatIsoDateFromUtcDate,
  parseIsoDateAsLocalStrict,
  getJstTodayUtcDate,
  parseIsoDateStrict,
};
