// HTML からイベントタイトルを抽出する共通ヘルパー。
const { decodeHtmlEntities, normalizeWhitespace, stripTags } = require("./text");

const GENERIC_TITLE_KEYWORDS = [
  "イベント情報",
  "イベント一覧",
  "イベント情報一覧",
  "Event",
  "イベント",
];

// HTML 断片をプレーンテキスト化して整形する。
function toPlainText(html) {
  if (!html) return "";
  const decoded = decodeHtmlEntities(stripTags(html));
  return normalizeWhitespace(decoded);
}

// 汎用的なタイトルかどうかを判定する。
function isGenericTitle(title) {
  if (!title) return true;
  return GENERIC_TITLE_KEYWORDS.some((keyword) => title.includes(keyword));
}

// 詳細 HTML からイベントタイトルを抽出する。
function extractEventTitleFromDetailHtml(detailHtml) {
  if (!detailHtml) return "";

  // (a) h1.entry-title または h1.post-title を最優先で使う。
  const primaryHeadingRegex =
    /<h1[^>]*class=["'][^"']*(entry-title|post-title)[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i;
  const primaryMatch = primaryHeadingRegex.exec(detailHtml);
  if (primaryMatch) {
    const title = toPlainText(primaryMatch[2]);
    if (title && !isGenericTitle(title)) {
      return title;
    }
  }

  // (b) article 内の最初の h1 を使う。
  const articleMatch = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(detailHtml);
  if (articleMatch) {
    const articleHtml = articleMatch[1];
    const articleHeadingMatch = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(articleHtml);
    if (articleHeadingMatch) {
      const title = toPlainText(articleHeadingMatch[1]);
      if (title && !isGenericTitle(title)) {
        return title;
      }
    }
  }

  // (c) 最初の h2 を使う。
  const secondaryMatch = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(detailHtml);
  if (secondaryMatch) {
    const title = toPlainText(secondaryMatch[1]);
    if (title && !isGenericTitle(title)) {
      return title;
    }
  }

  return "";
}

module.exports = {
  extractEventTitleFromDetailHtml,
};
