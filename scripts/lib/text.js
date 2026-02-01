// HTML テキスト処理を共通化するユーティリティ。
// 既存スクリプトで同一実装のものだけを置き換えるために用意する。

// HTML エンティティを最低限デコードする。
function decodeHtmlEntities(text) {
  if (!text) return "";
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

// HTML タグを除去してプレーンテキスト化する。
function stripTags(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, " ");
}

// 指定タグを改行として扱ったうえでプレーンテキスト化する。
function stripTagsWithLineBreaks(html) {
  if (!html) return "";
  const withLineBreaks = html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|li|div|dt|dd)\s*>/gi, "\n");
  return stripTags(withLineBreaks);
}

// 余分な空白を削除する。
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

module.exports = {
  decodeHtmlEntities,
  stripTags,
  stripTagsWithLineBreaks,
  normalizeWhitespace,
};
