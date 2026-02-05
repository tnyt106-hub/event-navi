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

module.exports = {
  extractDateRange,
  isDateInRange,
};
