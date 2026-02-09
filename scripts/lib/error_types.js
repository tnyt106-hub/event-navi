// エラー種別を標準化し、run-all.js と各 fetch スクリプトで同じ判定を使うための共通モジュール。
// 「取得失敗」と「解析失敗」を分けて扱えるようにし、再試行戦略を一元化する。

const ERROR_TYPES = Object.freeze({
  NETWORK: "NETWORK",
  PARSE: "PARSE",
  VALIDATION: "VALIDATION",
  EMPTY_RESULT: "EMPTY_RESULT",
  UNKNOWN: "UNKNOWN",
});

// 失敗種別を終了コードへ変換する。
// daily-update.ps1 が終了コードで成否判定するため、固定値で管理する。
const EXIT_CODE_BY_TYPE = Object.freeze({
  [ERROR_TYPES.NETWORK]: 10,
  [ERROR_TYPES.PARSE]: 11,
  [ERROR_TYPES.VALIDATION]: 12,
  [ERROR_TYPES.EMPTY_RESULT]: 13,
  [ERROR_TYPES.UNKNOWN]: 19,
});

const TYPE_BY_EXIT_CODE = Object.freeze(
  Object.fromEntries(Object.entries(EXIT_CODE_BY_TYPE).map(([type, code]) => [String(code), type]))
);

const ERROR_TYPE_LABELS_JA = Object.freeze({
  [ERROR_TYPES.NETWORK]: "ネットワーク取得エラー",
  [ERROR_TYPES.PARSE]: "解析エラー",
  [ERROR_TYPES.VALIDATION]: "検証エラー",
  [ERROR_TYPES.EMPTY_RESULT]: "結果0件エラー",
  [ERROR_TYPES.UNKNOWN]: "不明エラー",
});

class TypedError extends Error {
  // type を持つ Error を共通化し、catch 側で扱いやすくする。
  constructor(type, message, options = {}) {
    super(message);
    this.name = "TypedError";
    this.type = normalizeErrorType(type);
    // HTTP ステータスなどの追加情報を details に保持し、
    // 呼び出し側が再試行や分岐判定に使えるようにする。
    const { cause, ...details } = options || {};
    if (Object.keys(details).length > 0) {
      this.details = details;

      // 既存コードの互換性のため、よく使うキーはトップレベルにも写す。
      // 例: error.statusCode / error.retryable を直接参照する実装。
      for (const [key, value] of Object.entries(details)) {
        this[key] = value;
      }
    }
    if (cause) {
      this.cause = cause;
    }
  }
}

function normalizeErrorType(type) {
  const key = String(type || "").toUpperCase();
  return ERROR_TYPES[key] || ERROR_TYPES.UNKNOWN;
}

function toTypedError(error, fallbackType = ERROR_TYPES.UNKNOWN) {
  if (error instanceof TypedError) {
    return error;
  }

  const detectedType = detectErrorType(error) || fallbackType;
  const message = error?.message || String(error);
  return new TypedError(detectedType, message, { cause: error });
}

function detectErrorType(error) {
  if (!error) return null;
  const explicitType = normalizeErrorType(error.type);
  if (explicitType !== ERROR_TYPES.UNKNOWN) {
    return explicitType;
  }

  const message = String(error.message || error);
  if (/\[VALIDATION ERROR\]/.test(message)) {
    return ERROR_TYPES.VALIDATION;
  }
  if (/イベントが0件|date_from が1件も|取得結果が空/.test(message)) {
    return ERROR_TYPES.EMPTY_RESULT;
  }
  if (/HTTP 取得に失敗|HTTP \d+|AbortError|fetch failed|timeout/i.test(message)) {
    return ERROR_TYPES.NETWORK;
  }
  if (/デコードに失敗|解凍に失敗|パース|解析|見つからない/.test(message)) {
    return ERROR_TYPES.PARSE;
  }

  return null;
}

function errorTypeToExitCode(type) {
  return EXIT_CODE_BY_TYPE[normalizeErrorType(type)] || EXIT_CODE_BY_TYPE[ERROR_TYPES.UNKNOWN];
}

function exitCodeToErrorType(exitCode) {
  return TYPE_BY_EXIT_CODE[String(exitCode)] || ERROR_TYPES.UNKNOWN;
}

function isRetryableErrorType(type) {
  // 方針: NETWORK のみ再試行対象にする。
  return normalizeErrorType(type) === ERROR_TYPES.NETWORK;
}

function formatErrorTypeLabel(type) {
  const normalized = normalizeErrorType(type);
  const labelJa = ERROR_TYPE_LABELS_JA[normalized] || ERROR_TYPE_LABELS_JA[ERROR_TYPES.UNKNOWN];
  return `${normalized} (${labelJa})`;
}

function emitCliError(error, options = {}) {
  // run-all.js が stderr から機械可読に拾えるよう、ERROR_TYPE=... を必ず出力する。
  const typed = toTypedError(error);
  const message = typed.message || String(error);
  const typeLabel = formatErrorTypeLabel(typed.type);
  const prefix = options.prefix || "[ERROR]";

  console.error(`${prefix} ${typeLabel}: ${message}`);
  console.error(`ERROR_TYPE=${typed.type}`);
  console.error(`ERROR_TYPE_JA=${ERROR_TYPE_LABELS_JA[typed.type]}`);
  console.error(`ERROR_MESSAGE=${message}`);

  return typed;
}

module.exports = {
  ERROR_TYPES,
  ERROR_TYPE_LABELS_JA,
  TypedError,
  normalizeErrorType,
  toTypedError,
  detectErrorType,
  errorTypeToExitCode,
  exitCodeToErrorType,
  isRetryableErrorType,
  formatErrorTypeLabel,
  emitCliError,
};
