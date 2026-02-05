/**
 * プロジェクト標準のイベントオブジェクト構造を定義
 */
function createEvent(data = {}) {
  return {
    title: data.title || null,
    date_from: data.date_from || null,
    date_to: data.date_to || null,
    time_start: data.time_start || null,
    time_end: data.time_end || null,
    description: data.description || null,
    image_url: data.image_url || null,
    price: data.price || null,
    contact: data.contact || null,
    source_url: data.source_url || null,
    tags: {
      type: data.tags?.type || "other",
      genres: data.tags?.genres || [],
      flags: data.tags?.flags || []
    }
  };
}

/**
 * 最終的なJSON出力のルート構造を定義
 */
function createRootStructure(venueId, events = []) {
  return {
    venue_id: venueId,
    last_success_at: new Date().toISOString().split('T')[0],
    events: events
  };
}

/**
 * 【追加】保存前の最終バリデーション
 * 異常なデータを検知して、壊れたファイルの上書きを防ぎます。
 */
function validateFinalData(events, options = { minEvents: 1 }) {
  // 1. 件数チェック
  if (!Array.isArray(events) || events.length < options.minEvents) {
    throw new Error(`[VALIDATION ERROR] イベント数が少なすぎます (${events.length}件)。解析に失敗している可能性があります。`);
  }

  // 2. 必須項目の型・形式チェック
  events.forEach((event, index) => {
    const id = event.title || `Index:${index}`;
    
    // タイトルチェック
    if (!event.title || typeof event.title !== 'string' || event.title.length < 2) {
      throw new Error(`[VALIDATION ERROR] タイトルが不正です: "${id}"`);
    }

    // 日付形式チェック (YYYY-MM-DD)
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(event.date_from)) {
      throw new Error(`[VALIDATION ERROR] 開始日が不正な形式です: "${id}" (${event.date_from})`);
    }
  });

  return true;
}

module.exports = {
  createEvent,
  createRootStructure,
  validateFinalData
};
