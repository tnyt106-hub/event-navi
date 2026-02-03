// イベントの価格・問い合わせ情報を正規化する共通ヘルパー。
const { normalizeWhitespace } = require("./text");

const PRICE_LABEL_WORDS = [
  "お申し込み方法",
  "申込方法",
  "リンク",
  "詳細はこちら",
  "詳しくはこちら",
  "お申し込みはこちら",
  "申込はこちら",
  "こちら",
];

const CONTACT_LABEL_WORDS = [
  "リンク",
  "こちら",
  "詳細はこちら",
  "詳しくはこちら",
  "お問い合わせはこちら",
];

// ラベルや誘導文に見える文言なら true を返す。
function isLabelLikeText(text, labelWords) {
  if (!text) return true;
  return labelWords.some((label) => text.includes(label));
}

// 価格情報を正規化する。
function normalizePrice(text) {
  if (!text) return null;
  const normalized = normalizeWhitespace(text);
  if (!normalized) return null;
  if (isLabelLikeText(normalized, PRICE_LABEL_WORDS)) return null;
  return normalized;
}

// 問い合わせ先を正規化する。
function normalizeContact(text) {
  if (!text) return null;
  const normalized = normalizeWhitespace(text);
  if (!normalized) return null;
  if (isLabelLikeText(normalized, CONTACT_LABEL_WORDS)) return null;
  return normalized;
}

module.exports = {
  normalizePrice,
  normalizeContact,
};
