// CLI スクリプトの終了時エラー処理を共通化するユーティリティ。
// 目的: すべての fetch スクリプトで ERROR_TYPE と終了コードの契約を統一し、
// run-all.js 側の再試行判定を安定させる。

const { emitCliError, errorTypeToExitCode } = require("./error_types");

// 例外を標準化して stderr へ出力し、適切な終了コードを返す。
function handleCliFatalError(error, options = {}) {
  const typedError = emitCliError(error, { prefix: options.prefix || "[ERROR]" });
  const exitCode = errorTypeToExitCode(typedError.type);
  process.exitCode = exitCode;
  return exitCode;
}

module.exports = {
  handleCliFatalError,
};
