/**
 * scripts/lib/date.js
 * 日付解析・判定の共通ライブラリ
 */

/**
 * テキストから日付範囲（YYYY-MM-DD）を抽出する
 * @param {string} text - 解析対象テキスト（例: "2026年2月10日〜2月15日"）
 * @returns {object|null} { date_from, date_to }
 */
function extractDateRange(text) {
  if (!text) return null;

  // 「年」「月」「日」を抽出する正規表現
  const dateRegex = /(\d{4}年)?(\d{1,2})月(\d{1,2})日/g;
  const matches = [...text.matchAll(dateRegex)];

  if (matches.length === 0) return null;

  // 現在の年（またはシステム設定の年）を取得
  const currentYear = 2026;

  const parseMatch = (m) => {
    const y = m[1] ? parseInt(m[1].replace("年", ""), 10) : currentYear;
    const month = m[2].padStart(2, "0");
    const day = m[3].padStart(2, "0");
    return { date: `${y}-${month}-${day}`, year: y };
  };

  const start = parseMatch(matches[0]);
  // 終了日がない（単日開催）場合は開始日と同じにする
  let end = matches.length > 1 ? parseMatch(matches[matches.length - 1]) : { ...start };

  // 【重要】年またぎ補正
  // 例: 12月31日 〜 1月2日 かつ 年の記述がない場合
  if (end.date < start.date && !matches[matches.length - 1][1]) {
    const nextYear = start.year + 1;
    end.date = end.date.replace(/^\d{4}/, nextYear);
  }

  return {
    date_from: start.date,
    date_to: end.date,
  };
}

// ISO 日付が対象範囲内か判定する。
function isDateInRange(isoDate, range) {
  if (!isoDate || !range) return false;
  const date = new Date(`${isoDate}T00:00:00+09:00`);
  return date >= range.start && date <= range.end;
}

module.exports = {
  extractDateRange,
  isDateInRange,
};
