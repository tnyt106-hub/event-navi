// JSON 文字列のパースを共通化するユーティリティ。
// 目的: 施設別スクリプトで JSON.parse の例外型がばらつく問題を防ぎ、
// run-all が失敗理由を安定判定できるようにする。

const { ERROR_TYPES, TypedError } = require("./error_types");

/**
 * JSON 文字列をパースする。
 * - 失敗時は TypedError(PARSE) を投げる。
 * - contextLabel を含め、どこで壊れたか調査しやすくする。
 */
function parseJsonOrThrowTyped(text, contextLabel = "JSON") {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TypedError(
      ERROR_TYPES.PARSE,
      `${contextLabel} の JSON パースに失敗しました。 (${error.message})`,
      { cause: error }
    );
  }
}

/**
 * JSON 文字列をパースし、失敗時は fallbackValue を返す。
 * - キャッシュ読み込みなど「壊れていても空扱いで続行したい」用途向け。
 */
function parseJsonOrFallback(text, fallbackValue) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return fallbackValue;
  }
}

// 注意:
// - 競合解消時に「safe変数の定義だけ落ちる / 関数定義だけ落ちる」と、
//   module.exports 評価時に ReferenceError が起こり得る。
// - その再発を防ぐため、exports 側で typeof 判定を直接行い、
//   欠落時は同等のローカル実装へ即時フォールバックする。
module.exports = {
  parseJsonOrThrowTyped,
  parseJsonOrFallback:
    typeof parseJsonOrFallback === "function"
      ? parseJsonOrFallback
      : function parseJsonOrFallbackFallback(text, fallbackValue) {
          try {
            return JSON.parse(text);
          } catch (_error) {
            return fallbackValue;
          }
        },
};
