"use strict";

// スクレイピング系スクリプトで頻出する「テキスト整形」「ラベル値抽出」を共通化する。
// 施設追加時に同等ロジックのコピペを減らし、仕様修正漏れを防ぐことが目的。

const { decodeHtmlEntities, normalizeWhitespace, stripTagsWithLineBreaks } = require("./text");

/**
 * 全角数字などを半角へ寄せる。
 * 日付/時刻抽出の前処理として使う。
 */
function normalizeFullWidthBasic(text) {
  if (!text) return "";
  return String(text)
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ":")
    .replace(/[‐‑‒–—―ー]/g, "-");
}

/**
 * HTML 断片を行単位のテキスト配列へ変換する。
 * ラベル抽出や全文検索の前段で利用する。
 */
function extractTextLinesFromHtml(html) {
  const withLineBreaks = stripTagsWithLineBreaks(String(html || ""));
  const decoded = decodeHtmlEntities(withLineBreaks);
  return decoded
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0);
}

/**
 * 先頭の装飾記号を除去し、空白を正規化したタイトル文字列を返す。
 */
function normalizeHeadingLikeTitle(text) {
  return String(text || "")
    .replace(/^[\s\-–—―~〜～:：・|｜]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ラベル付きテキストから値を抽出する。
 * - 同じ行に値がある形式: 「開催日：2024年2月3日」
 * - 次行に値がある形式: 「開催日」+ 改行 + 値
 */
function extractLabeledValue(lines, labels) {
  const safeLines = Array.isArray(lines) ? lines : [];
  const labelList = Array.isArray(labels) ? labels : [labels];

  for (let i = 0; i < safeLines.length; i += 1) {
    const line = safeLines[i];

    for (const rawLabel of labelList) {
      const label = String(rawLabel || "").trim();
      if (!label || !line.includes(label)) {
        continue;
      }

      const sameLinePattern = new RegExp(`${label}\\s*[:：]?\\s*(.+)`);
      const sameLineMatch = line.match(sameLinePattern);
      if (sameLineMatch && sameLineMatch[1]) {
        return sameLineMatch[1].trim();
      }

      if (line.trim() === label && safeLines[i + 1]) {
        return safeLines[i + 1].trim();
      }
    }
  }

  return "";
}

/**
 * 年月日を YYYY-MM-DD 形式へ整形する。
 */
function toIsoDate(year, month, day) {
  return `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

module.exports = {
  normalizeFullWidthBasic,
  extractTextLinesFromHtml,
  normalizeHeadingLikeTitle,
  extractLabeledValue,
  toIsoDate,
};
