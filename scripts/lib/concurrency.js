// 同時実行数を制限しながら非同期処理を map する共通ユーティリティ。
// スクレイピング先への負荷を抑えつつ、逐次実行より高速に処理するために使う。

// setTimeout を Promise 化する小さなヘルパー。
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// items を mapper で処理し、最大 limit 件まで並列実行する。
// 返却順は入力順を維持する。
async function mapWithConcurrencyLimit(items, limit, mapper) {
  const safeItems = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Number(limit) || 1);
  const results = new Array(safeItems.length);
  let currentIndex = 0;

  async function worker() {
    for (;;) {
      const index = currentIndex;
      currentIndex += 1;
      if (index >= safeItems.length) {
        break;
      }
      results[index] = await mapper(safeItems[index], index);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

module.exports = {
  sleep,
  mapWithConcurrencyLimit,
};

