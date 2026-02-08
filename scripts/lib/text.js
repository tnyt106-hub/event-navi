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


// HTML タグを除去してプレーンテキスト化する（タグの位置に空白を入れない）。
// 施設ごとに「タグ除去後の空白を残したくない」実装があるため、明示的に分けて提供する。
function stripTagsCompact(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "");
}

// HTML エンティティをデコードした後に空白を正規化する。
// 複数スクリプトで重複していた処理を 1 箇所へ寄せる。
function normalizeDecodedText(text) {
  return normalizeWhitespace(decodeHtmlEntities(String(text || "")));
}

module.exports = {
  decodeHtmlEntities,
  stripTags,
  stripTagsWithLineBreaks,
  stripTagsCompact,
  normalizeWhitespace,
  normalizeDecodedText,
};
