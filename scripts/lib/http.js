// 共通の HTTP 取得ユーティリティ。
// 圧縮/文字コード/タイムアウトを統一的に扱い、文字化けや圧縮崩れを防ぐ。

const https = require("https");
const zlib = require("zlib");
const { TextDecoder } = require("util");

const DEFAULT_TIMEOUT_MS = 30000;
const ERROR_INDICATORS = ["Access Denied", "Forbidden", "Service Unavailable"];

// HTML テキストを取得する。
// options: { headers, acceptEncoding, encoding, timeoutMs, debugLabel }
async function fetchText(url, options = {}) {
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

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = null;

    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolve(value);
    };

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    };

    const request = https.get(
      url,
      { headers },
      (response) => {
        if (response.statusCode !== 200) {
          rejectOnce(new Error(`HTTP ${response.statusCode} で失敗しました。`));
          response.resume();
          return;
        }

        if (debugLabel) {
          console.log(
            `[fetchText:${debugLabel}] content-encoding: ${response.headers["content-encoding"] || "none"}, content-type: ${
              response.headers["content-type"] || "unknown"
            }`
          );
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let buffer = Buffer.concat(chunks);
          if (!buffer.length) {
            rejectOnce(new Error("HTML の取得結果が空でした。"));
            return;
          }

          // gzip 圧縮されていれば解凍する（identity要求でも念のため対応）。
          const contentEncoding = String(response.headers["content-encoding"] || "").toLowerCase();
          if (contentEncoding.includes("gzip")) {
            try {
              buffer = zlib.gunzipSync(buffer);
            } catch {
              rejectOnce(new Error("gzip の解凍に失敗しました。"));
              return;
            }
          }

          let decoded = "";
          if (isShiftJis) {
            try {
              decoded = new TextDecoder("shift_jis").decode(buffer);
            } catch {
              rejectOnce(new Error("Shift_JIS のデコードに失敗しました。"));
              return;
            }
          } else {
            decoded = buffer.toString("utf8");
          }

          if (!decoded) {
            rejectOnce(new Error("HTML の取得結果が空でした。"));
            return;
          }

          if (ERROR_INDICATORS.some((indicator) => decoded.includes(indicator))) {
            rejectOnce(new Error("明らかなエラーページの可能性があります。"));
            return;
          }

          if (debugLabel) {
            const bodySnippet = decoded.replace(/\s+/g, " ").slice(0, 200);
            console.log(`[fetchText:${debugLabel}] body_head: ${bodySnippet}`);
          }

          resolveOnce(decoded);
        });
      }
    );

    timeoutId = setTimeout(() => {
      request.destroy();
      rejectOnce(new Error("タイムアウトしました。"));
    }, timeoutMs);

    request.on("error", (error) => rejectOnce(error));
  });
}

module.exports = {
  fetchText,
};