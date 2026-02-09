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
// - 過去にマージ競合解消時に parseJsonOrFallback 関数定義だけが欠落し、
//   exports 側参照で ReferenceError が発生した事例があった。
// - その再発を防ぐため、exports 直前で関数存在を最終チェックし、
//   欠落していた場合でも同等動作のフォールバック実装へ退避させる。
const safeParseJsonOrFallback =
  typeof parseJsonOrFallback === "function"
    ? parseJsonOrFallback
    : function parseJsonOrFallbackFallback(text, fallbackValue) {
        try {
          return JSON.parse(text);
        } catch (_error) {
          return fallbackValue;
        }
      };

module.exports = {
  parseJsonOrThrowTyped,
  parseJsonOrFallback: safeParseJsonOrFallback,
};
