// イベント詳細ページの URL かどうかを判定する共通ヘルパー。
const { URL } = require("url");

// 文字列がイベント詳細ページの URL なら true を返す。
function isEventDetailUrl(urlString) {
  if (!urlString) return false;

  try {
    const url = new URL(urlString);
    const { pathname } = url;

    // /event/ を含まない場合は詳細ページではない。
    if (!pathname.includes("/event/")) return false;

    // カテゴリ配下はイベント詳細ではない。
    if (pathname.includes("/event_cat/")) return false;

    // 一覧トップは除外する。
    if (pathname.endsWith("/event/")) return false;

    // ページング URL は詳細ではないので除外する。
    if (pathname.includes("/event/page/")) return false;

    // 末尾が /数字/ で終わるものだけを詳細扱いにする。
    if (!/\/\d+\/$/.test(pathname)) return false;

    return true;
  } catch (error) {
    // URL パースに失敗したら詳細 URL ではない。
    return false;
  }
}

module.exports = {
  isEventDetailUrl,
};
