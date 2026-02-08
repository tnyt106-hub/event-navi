const { ERROR_TYPES, TypedError } = require("./error_types");

/**
 * プロジェクト標準のイベント項目テンプレート。
 *
 * 重要:
 * - 項目定義はこの定数に1回だけ記述し、他では重複定義しない。
 * - createEvent() はこのテンプレートを複製して値を上書きする。
 */
const EVENT_TEMPLATE = Object.freeze({
  title: null,
  date_from: null,
  date_to: null,
  open_time: null,
  start_time: null,
  end_time: null,
  description: null,
  image_url: null,
  price: null,
  contact: null,
  source_url: null,
  source_type: null,
  venue_name: null,
  status: null,
  body: null,
  tags: Object.freeze({
    type: "other",
    genres: Object.freeze([]),
    flags: Object.freeze([]),
  }),
});

/**
 * 入力データからイベントオブジェクトを生成する。
 *
 * 実装意図:
 * - 旧キー(time_start/time_end)は後方互換として受け取り、
 *   標準キー(start_time/end_time)へ正規化する。
 * - tags 配下は配列を都度複製し、参照共有の副作用を防ぐ。
 */
function createEvent(data = {}) {
  // 旧フィールド名(time_start/time_end)で渡された場合も
  // 新フィールド名(start_time/end_time)へ吸収して返す。
  const normalizedStartTime = data.start_time || data.time_start || null;
  const normalizedEndTime = data.end_time || data.time_end || null;

  const event = { ...EVENT_TEMPLATE };

  // テンプレートで定義したキーだけをコピーする。
  // これにより、未定義キーが紛れ込んでJSON項目が再び散らばることを防ぐ。
  Object.keys(EVENT_TEMPLATE).forEach((key) => {
    if (key === "tags") return;
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      event[key] = data[key] ?? null;
    }
  });

  event.open_time = data.open_time || null;
  event.start_time = normalizedStartTime;
  event.end_time = normalizedEndTime;
  event.tags = {
    ...EVENT_TEMPLATE.tags,
    ...(data.tags || {}),
    genres: Array.isArray(data.tags?.genres) ? [...data.tags.genres] : [],
    flags: Array.isArray(data.tags?.flags) ? [...data.tags.flags] : [],
  };

  return event;
}

/**
 * 最終的なJSON出力のルート構造を定義
 */
function createRootStructure(venueId, events = []) {
  return {
    venue_id: venueId,
    last_success_at: new Date().toISOString().split("T")[0],
    events: events,
  };
}

/**
 * 保存前の最終バリデーション。
 * 異常なデータを検知して、壊れたファイルの上書きを防ぐ。
 */
function validateFinalData(events, options = { minEvents: 1 }) {
  // 1. 件数チェック
  if (!Array.isArray(events) || events.length < options.minEvents) {
    throw new TypedError(
      ERROR_TYPES.EMPTY_RESULT,
      `[VALIDATION ERROR] イベント数が少なすぎます (${events.length}件)。解析に失敗している可能性があります。`
    );
  }

  // 2. 必須項目の型・形式チェック
  events.forEach((event, index) => {
    const id = event.title || `Index:${index}`;

    // タイトルチェック
    if (!event.title || typeof event.title !== "string" || event.title.length < 2) {
      throw new TypedError(ERROR_TYPES.VALIDATION, `[VALIDATION ERROR] タイトルが不正です: "${id}"`);
    }

    // 日付形式チェック (YYYY-MM-DD)
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(event.date_from)) {
      throw new TypedError(ERROR_TYPES.VALIDATION, `[VALIDATION ERROR] 開始日が不正な形式です: "${id}" (${event.date_from})`);
    }
  });

  return true;
}

module.exports = {
  EVENT_TEMPLATE,
  createEvent,
  createRootStructure,
  validateFinalData,
};
