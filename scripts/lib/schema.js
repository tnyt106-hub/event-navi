/**
 * プロジェクト標準のイベントオブジェクト構造を定義
 * 項目の並び順、デフォルト値、型をここで一括管理します。
 */
function createEvent(data = {}) {
  // テンプレートの項目順序を厳密に守ってオブジェクトを生成
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

module.exports = {
  createEvent,
  createRootStructure
};
