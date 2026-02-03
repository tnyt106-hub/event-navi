// イベント配列を source_url で重複排除する共通ヘルパー。
function dedupeEventsBySourceUrl(events) {
  const map = new Map();

  for (const event of events || []) {
    if (!event || !event.source_url) {
      // source_url が無いイベントは除外する。
      continue;
    }
    if (!map.has(event.source_url)) {
      map.set(event.source_url, event);
    }
  }

  return Array.from(map.values());
}

module.exports = {
  dedupeEventsBySourceUrl,
};
