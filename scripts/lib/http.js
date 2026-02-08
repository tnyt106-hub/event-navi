// 共通の HTTP 取得ユーティリティ。
// 圧縮/文字コード/タイムアウトを統一的に扱い、文字化けや圧縮崩れを防ぐ。

const zlib = require("zlib");
const { TextDecoder } = require("util");
const { ERROR_TYPES, TypedError } = require("./error_types");

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 600;
const ERROR_INDICATORS = ["Access Denied", "Forbidden", "Service Unavailable"];

// リトライ対象の HTTP ステータスか判定する。
function isRetryableStatusCode(statusCode) {
  return statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
}

// 指数バックオフ + ジッターで待機時間を計算する。
function buildRetryDelayMs(attempt, baseDelayMs) {
  const safeAttempt = Math.max(1, attempt);
  const exponential = baseDelayMs * (2 ** (safeAttempt - 1));
  const jitter = Math.floor(Math.random() * 150);
  return exponential + jitter;
}

// HTML テキストを取得し、本文とメタ情報を返す。
// options: { headers, acceptEncoding, encoding, timeoutMs, debugLabel, checkErrorIndicators }
async function fetchTextWithMeta(url, options = {}) {
  const acceptEncoding = options.acceptEncoding || "identity";

  // 改善点2：encodingの正規化（大小・shift-jis表記揺れを吸収）
  const encoding = String(options.encoding || "utf-8").toLowerCase();
  const isShiftJis = encoding === "shift_jis" || encoding === "shift-jis";

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const debugLabel = options.debugLabel;

  const defaultHeaders = {
    "User-Agent": "Mozilla/5.0 (compatible; event-navi-bot/1.0)",
    Accept: "text/html,application/xhtml+xml",
    "Accept-Encoding": acceptEncoding,
  };

  // オプション側のヘッダ指定を優先してマージする。
  const headers = {
    ...defaultHeaders,
    ...(options.headers || {}),
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    throw new TypedError(
      ERROR_TYPES.NETWORK,
      `HTTP 取得に失敗しました。 (${error.message})`,
      { cause: error }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const statusCode = Number(response.status || 0);
    const retryableText = isRetryableStatusCode(statusCode) ? " retryable=true" : "";
    throw new TypedError(
      ERROR_TYPES.NETWORK,
      `HTTP ${statusCode} で失敗しました。${retryableText}`.trim(),
      { statusCode, retryable: isRetryableStatusCode(statusCode) }
    );
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();

  if (debugLabel) {
    console.log(
      `[fetchText:${debugLabel}] content-encoding: ${response.headers.get("content-encoding") || "none"}, content-type: ${
        contentType || "unknown"
      }`
    );
  }

  let buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    throw new TypedError(ERROR_TYPES.EMPTY_RESULT, "HTML の取得結果が空でした。");
  }

  // gzip/deflate 圧縮が指定されている場合のみ、バイト列を解凍する。
  const contentEncoding = String(response.headers.get("content-encoding") || "").toLowerCase();
  if (contentEncoding.includes("gzip")) {
    // gzip マジックを持つ場合のみ解凍することで、二重解凍を避ける。
    if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
      try {
        buffer = zlib.gunzipSync(buffer);
      } catch {
        throw new TypedError(ERROR_TYPES.PARSE, "gzip の解凍に失敗しました。");
      }
    }
  } else if (contentEncoding.includes("deflate")) {
    // deflate は判別が難しいため、典型的なヘッダを持つ場合のみ解凍する。
    if (buffer.length >= 2 && buffer[0] === 0x78) {
      try {
        buffer = zlib.inflateSync(buffer);
      } catch {
        throw new TypedError(ERROR_TYPES.PARSE, "deflate の解凍に失敗しました。");
      }
    }
  }

  let decoded = "";
  if (isShiftJis) {
    try {
      decoded = new TextDecoder("shift_jis").decode(buffer);
    } catch {
      throw new TypedError(ERROR_TYPES.PARSE, "Shift_JIS のデコードに失敗しました。");
    }
  } else {
    decoded = buffer.toString("utf8");
  }

  if (!decoded) {
    throw new TypedError(ERROR_TYPES.EMPTY_RESULT, "HTML の取得結果が空でした。");
  }

  // 本文のエラーページ判定は HTML のみを対象にする。
  // 施設側の事情で判定を無効化したい場合は checkErrorIndicators: false を指定する。
  const isHtmlContent = contentType.includes("text/html");
  const shouldCheckErrorIndicators = options.checkErrorIndicators !== false && isHtmlContent;
  if (shouldCheckErrorIndicators && ERROR_INDICATORS.some((indicator) => decoded.includes(indicator))) {
    throw new TypedError(ERROR_TYPES.NETWORK, "明らかなエラーページの可能性があります。");
  }

  if (debugLabel) {
    const bodySnippet = decoded.replace(/\s+/g, " ").slice(0, 200);
    console.log(`[fetchText:${debugLabel}] body_head: ${bodySnippet}`);
  }

  return {
    text: decoded,
    headers: Object.fromEntries(response.headers.entries()),
    statusCode: response.status,
  };
}

// HTML テキストのみを取得する。
// options: { headers, acceptEncoding, encoding, timeoutMs, debugLabel }
async function fetchText(url, options = {}) {
  const retryCount = Number.isInteger(options.retryCount) ? options.retryCount : DEFAULT_RETRY_COUNT;
  const retryBaseDelayMs = Number.isFinite(options.retryBaseDelayMs)
    ? Number(options.retryBaseDelayMs)
    : DEFAULT_RETRY_BASE_DELAY_MS;

  let lastError = null;
  for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
    try {
      const { text } = await fetchTextWithMeta(url, options);
      return text;
    } catch (error) {
      lastError = error;
      const statusCode = Number(error?.statusCode || error?.details?.statusCode || 0);
      const retryable =
        error?.type === ERROR_TYPES.NETWORK &&
        (statusCode === 0 || isRetryableStatusCode(statusCode));
      const canRetry = retryable && attempt <= retryCount;
      if (!canRetry) {
        throw error;
      }

      const waitMs = buildRetryDelayMs(attempt, retryBaseDelayMs);
      console.warn(
        `[fetchText] retry ${attempt}/${retryCount} wait=${waitMs}ms url=${url} status=${statusCode || "network"}`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw lastError;
}

// HTML テキスト取得の別名（呼び出し側の用途を明示するため）。
async function fetchHtml(url, options = {}) {
  return fetchText(url, options);
}

module.exports = {
  fetchHtml,
  fetchText,
  fetchTextWithMeta,
};
