#!/usr/bin/env node
"use strict";

/**
 * run-all.js
 * - run-all.config.json に従って tasks を順番に実行
 * - 進捗ログを「RUN / PHASE / TASK」の粒度で出す
 * - 失敗しても続行し、最後にサマリ出力
 *
 * 想定config:
 * {
 *   "sleepSecondsBetween": 7,
 *   "tasks": [
 *     { "id": "rexam_hall", "script": "scripts/fetch-rexam-hall-events.js", "enabled": true },
 *     { "id": "highstaff_hall", "script": "scripts/fetch-highstaff-hall-events.js", "enabled": true },
 *     { "id": "generate_date_pages", "script": "scripts/generate-date-pages.js", "enabled": true }
 *   ]
 * }
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { writeTextAtomic } = require("./lib/io");
const {
  exitCodeToErrorType,
  normalizeErrorType,
  isRetryableErrorType,
  formatErrorTypeLabel,
  detectErrorType,
  ERROR_TYPES,
} = require("./lib/error_types");

const REPO_ROOT = path.join(__dirname, "..");

// ------------- logging helpers -------------

function nowIso() {
  return new Date().toISOString();
}

function msToSec(ms) {
  // ログ表示用の秒数（小数1桁）
  return (ms / 1000).toFixed(1);
}

function msToSecNumber(ms) {
  // taskResults の elapsedSeconds 用に数値型へ統一する
  return Number((ms / 1000).toFixed(1));
}

function formatLogTimestamp() {
  // ログファイル向けにファイル名に使える時刻文字列を作る
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDirExists(dirPath) {
  if (!dirPath) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolveLogFilePath(logConfig) {
  if (!logConfig || !logConfig.dir || !logConfig.filenamePattern) return null;
  const filename = logConfig.filenamePattern.replace(
    /\{timestamp\}/g,
    formatLogTimestamp()
  );
  return path.join(logConfig.dir, filename);
}

function createLogger(logConfig) {
  // ログレベルの優先度（数値が小さいほど重大）
  const levelRanks = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
  };
  const minLevelName = String(logConfig?.level || "info").toLowerCase();
  const minLevel = levelRanks[minLevelName] ?? levelRanks.info;

  let fileStream = null;
  let logFilePath = null;

  if (logConfig?.captureStdoutStderr) {
    const dirPath = logConfig.dir ? path.join(REPO_ROOT, logConfig.dir) : null;
    if (dirPath) {
      ensureDirExists(dirPath);
      logFilePath = resolveLogFilePath({
        dir: dirPath,
        filenamePattern: logConfig.filenamePattern,
      });
      if (logFilePath) {
        fileStream = fs.createWriteStream(logFilePath, { flags: "a" });
      }
    }
  }

  function shouldLog(level) {
    const rank = levelRanks[level] ?? levelRanks.info;
    return rank <= minLevel;
  }

  function writeToFile(line) {
    if (fileStream) {
      fileStream.write(`${line}\n`);
    }
  }

  function emit(level, msg, consoleWriter) {
    if (!shouldLog(level)) return;
    const line = msg;
    consoleWriter(line);
    writeToFile(line);
  }

  return {
    logFilePath,
    writeStdout(chunk) {
      // タスクの標準出力をファイルに書き込む（consoleは外側で維持）
      if (fileStream) {
        fileStream.write(chunk);
      }
    },
    close() {
      if (fileStream) {
        fileStream.end();
      }
    },
    run(msg) {
      emit("info", `[RUN] ${msg}`, console.log);
    },
    phase(msg) {
      emit("info", `[PHASE] ${msg}`, console.log);
    },
    task(msg) {
      emit("info", `  [TASK] ${msg}`, console.log);
    },
    warn(msg) {
      emit("warn", `  [WARN] ${msg}`, console.warn);
    },
    error(msg) {
      emit("error", `  [ERROR] ${msg}`, console.error);
    },
    debug(msg) {
      emit("debug", `  [DEBUG] ${msg}`, console.log);
    },
  };
}

// ------------- config loading -------------

function findConfigPath() {
  const candidates = [
    path.join(REPO_ROOT, "scripts", "run-all.config.json"),
    path.join(REPO_ROOT, "run-all.config.json"),
    path.join(REPO_ROOT, "scripts", "run_all.config.json"),
    path.join(REPO_ROOT, "run_all.config.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function parseNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  return fallback;
}

function normalizeLogConfig(rawLog) {
  // ログ設定は任意。captureStdoutStderr が true の時だけファイル出力する
  const dir = typeof rawLog?.dir === "string" ? rawLog.dir : "logs";
  const filenamePattern =
    typeof rawLog?.filenamePattern === "string"
      ? rawLog.filenamePattern
      : "run-all-{timestamp}.log";
  const level = typeof rawLog?.level === "string" ? rawLog.level : "info";
  const captureStdoutStderr = parseBoolean(rawLog?.captureStdoutStderr, false);

  return {
    dir,
    filenamePattern,
    level,
    captureStdoutStderr,
  };
}

function normalizeConfig(raw) {
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const allowSharedOutputs = Array.isArray(raw.allowSharedOutputs)
    ? raw.allowSharedOutputs
    : [];
  return {
    version: raw.version,
    timezone: typeof raw.timezone === "string" ? raw.timezone : "Asia/Tokyo",
    sleepSecondsBetween: parseNumber(raw.sleepSecondsBetween, 0),
    defaultTimeoutSeconds: parseNumber(raw.defaultTimeoutSeconds, null),
    defaultRetries: parseNumber(raw.defaultRetries, 0),
    defaultRetryDelaySeconds: parseNumber(raw.defaultRetryDelaySeconds, 0),
    stopOnError: parseBoolean(raw.stopOnError, false),
    log: normalizeLogConfig(raw.log),
    allowSharedOutputs,
    tasks,
  };
}

function normalizeTaskId(id) {
  return typeof id === "string" ? id.trim() : "";
}

function buildSharedOutputAllowanceMap(allowSharedOutputs) {
  const allowanceMap = new Map();
  allowSharedOutputs.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const outputPath = typeof entry.output === "string" ? entry.output : "";
    if (!outputPath) return;

    // タスクIDは前後空白を除去して比較を安定化する。
    const taskIdSet = new Set(
      Array.isArray(entry.taskIds)
        ? entry.taskIds
            .map((id) => normalizeTaskId(id))
            .filter((id) => id.length > 0)
        : []
    );
    allowanceMap.set(outputPath, taskIdSet);
  });
  return allowanceMap;
}

function validateConfigStructure(config) {
  const errors = [];

  if (!Array.isArray(config.tasks) || config.tasks.length === 0) {
    errors.push("tasks が空です。少なくとも1件の task を定義してください。");
    return errors;
  }

  const seenTaskIds = new Set();
  const outputOwners = new Map();

  config.tasks.forEach((task, index) => {
    if (!task || typeof task !== "object") {
      errors.push(`tasks[${index}] が object ではありません。`);
      return;
    }

    const taskId = normalizeTaskId(task.id);
    if (!taskId) {
      errors.push(`tasks[${index}] は id が必須です。`);
    } else if (seenTaskIds.has(taskId)) {
      errors.push(`task id "${taskId}" が重複しています。`);
    } else {
      seenTaskIds.add(taskId);
    }

    if (typeof task.script !== "string" || task.script.trim().length === 0) {
      errors.push(`task ${taskId || `tasks[${index}]`} は script が必須です。`);
    }

    if (!Array.isArray(task.outputs) || task.outputs.length === 0) {
      errors.push(
        `task ${taskId || `tasks[${index}]`} は outputs が必須です（差分判定に必要）。`
      );
    } else {
      task.outputs.forEach((outputPath, outputIndex) => {
        if (typeof outputPath !== "string" || outputPath.trim().length === 0) {
          errors.push(
            `task ${taskId || `tasks[${index}]`} の outputs[${outputIndex}] が不正です。`
          );
          return;
        }

        const owners = outputOwners.get(outputPath) || [];
        owners.push(taskId || `(index-${index})`);
        outputOwners.set(outputPath, owners);
      });
    }
  });

  const sharedOutputAllowance = buildSharedOutputAllowanceMap(config.allowSharedOutputs);

  outputOwners.forEach((ownerIds, outputPath) => {
    if (ownerIds.length <= 1) return;

    const allowedTaskIds = sharedOutputAllowance.get(outputPath);
    if (!allowedTaskIds || allowedTaskIds.size === 0) {
      errors.push(
        `output "${outputPath}" を複数 task (${ownerIds.join(", ")}) が共有しています。allowSharedOutputs で明示してください。`
      );
      return;
    }

    // 実際に共有する task が許可リストにすべて含まれているか確認する。
    const unknownOwners = ownerIds.filter((taskId) => !allowedTaskIds.has(taskId));
    if (unknownOwners.length > 0) {
      errors.push(
        `output "${outputPath}" の共有 task に未許可IDがあります: ${unknownOwners.join(", ")}`
      );
    }
  });

  return errors;
}

function loadConfig() {
  const configPath = findConfigPath();
  if (!configPath) {
    throw new Error(
      "run-all.config.json が見つかりません。候補: scripts/run-all.config.json または run-all.config.json"
    );
  }
  const raw = fs.readFileSync(configPath, "utf8");
  const json = JSON.parse(raw);

  if (!json || typeof json !== "object") {
    throw new Error("config JSON の形式が不正です。");
  }
  const normalized = normalizeConfig(json);
  const configErrors = validateConfigStructure(normalized);
  if (configErrors.length > 0) {
    throw new Error(`config 検証エラー:\n- ${configErrors.join("\n- ")}`);
  }

  return { configPath, config: normalized };
}

// ------------- phase classification -------------

function classifyPhase(task) {
  if (task.type) {
    // 明示された type があればそれを優先する（例: fetch / validate / generate）
    return String(task.type).toLowerCase();
  }
  const id = String(task.id || "").toLowerCase();
  const script = String(task.script || "").toLowerCase();

  // 生成系
  if (id.includes("generate") || script.includes("generate")) return "generate";
  if (script.includes("date") && script.includes("pages")) return "generate";

  // タグ付与/整形系
  if (id.includes("tag") || script.includes("tag")) return "tagging";
  if (script.includes("apply_tags") || script.includes("apply-tags")) return "tagging";

  // デフォルトはスクレイピング
  return "scrape";
}

function phaseLabel(phase) {
  if (phase === "scrape") return "scrape";
  if (phase === "tagging") return "tagging";
  if (phase === "generate") return "generate";
  return String(phase);
}

// ------------- process runner -------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNodeScript(scriptPathAbs, options) {
  return new Promise((resolve) => {
    // 失敗原因を判定するため、常に stdout/stderr を受け取りつつコンソールへ転送する。
    // これにより、ERROR_TYPE=... の機械可読ログや例外メッセージを run-all 側で解析できる。
    const child = spawn(process.execPath, [scriptPathAbs], {
      cwd: REPO_ROOT,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
      env: options.env,
    });

    let timeoutId = null;
    let timedOut = false;
    let stdoutText = "";
    let stderrText = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        stdoutText += text;
        process.stdout.write(chunk);
        if (options.captureStdoutStderr) {
          options.logger?.writeStdout(chunk);
        }
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        stderrText += text;
        process.stderr.write(chunk);
        if (options.captureStdoutStderr) {
          options.logger?.writeStdout(chunk);
        }
      });
    }

    if (typeof options.timeoutSeconds === "number" && options.timeoutSeconds > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutSeconds * 1000);
    }

    child.on("close", (code, signal) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ code: code ?? 1, signal: signal ?? null, timedOut, stdoutText, stderrText });
    });

    child.on("error", (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ code: 1, signal: null, error: err, timedOut, stdoutText, stderrText });
    });
  });
}

function resolveScriptPath(taskScript) {
  // configは repo root 起点の相対パス想定だが、絶対パスでもOK
  if (!taskScript) return null;
  const s = String(taskScript);
  if (path.isAbsolute(s)) return s;
  return path.join(REPO_ROOT, s);
}

function formatTaskName(task) {
  const id = task.id ? String(task.id) : "(no-id)";
  const displayName = task.name ? String(task.name) : null;
  const script = task.script ? String(task.script) : "(no-script)";
  if (displayName) {
    return `${id} (${displayName}) (${script})`;
  }
  return `${id} (${script})`;
}

function normalizeTaskNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function resolveTaskSettings(task, config) {
  // タスク単位の設定をデフォルトで補完する
  const timeoutSeconds = normalizeTaskNumber(
    task.timeoutSeconds,
    config.defaultTimeoutSeconds
  );
  const retries = normalizeTaskNumber(task.retries, config.defaultRetries);
  const retryDelaySeconds = normalizeTaskNumber(
    task.retryDelaySeconds,
    config.defaultRetryDelaySeconds
  );
  const continueOnError = parseBoolean(task.continueOnError, false);
  const sleepSecondsAfter = normalizeTaskNumber(task.sleepSecondsAfter, null);
  const skipIfOutputsUnchanged = parseBoolean(task.skipIfOutputsUnchanged, false);

  return {
    timeoutSeconds,
    retries,
    retryDelaySeconds,
    continueOnError,
    sleepSecondsAfter,
    skipIfOutputsUnchanged,
  };
}

function normalizeDependsOn(dependsOn) {
  if (!Array.isArray(dependsOn)) return [];
  return dependsOn.map((item) => String(item));
}

function orderTasksByDependencies(tasks, logger) {
  // dependsOn が指定されていない場合は、従来通りの列挙順で返す
  const hasDependsOn = tasks.some((task) => normalizeDependsOn(task.dependsOn).length > 0);
  if (!hasDependsOn) {
    return { orderedTasks: tasks, dependencyErrors: [] };
  }

  const idToTask = new Map();
  tasks.forEach((task) => {
    if (task?.id) {
      idToTask.set(String(task.id), task);
    }
  });

  const dependencyErrors = [];
  const taskIndices = new Map();
  tasks.forEach((task, index) => {
    taskIndices.set(task, index);
  });

  const indegree = new Map();
  const graph = new Map();

  tasks.forEach((task) => {
    indegree.set(task, 0);
    graph.set(task, new Set());
  });

  tasks.forEach((task) => {
    const deps = normalizeDependsOn(task.dependsOn);
    deps.forEach((depId) => {
      const depTask = idToTask.get(depId);
      if (!depTask) {
        dependencyErrors.push(
          `task ${task.id || "(no-id)"} dependsOn "${depId}" が見つかりません`
        );
        return;
      }
      graph.get(depTask).add(task);
      indegree.set(task, (indegree.get(task) || 0) + 1);
    });
  });

  if (dependencyErrors.length > 0) {
    return { orderedTasks: tasks, dependencyErrors };
  }

  const queue = tasks
    .filter((task) => indegree.get(task) === 0)
    .sort((a, b) => (taskIndices.get(a) || 0) - (taskIndices.get(b) || 0));

  const orderedTasks = [];

  while (queue.length > 0) {
    const current = queue.shift();
    orderedTasks.push(current);
    graph.get(current).forEach((neighbor) => {
      indegree.set(neighbor, (indegree.get(neighbor) || 0) - 1);
      if (indegree.get(neighbor) === 0) {
        queue.push(neighbor);
        queue.sort((a, b) => (taskIndices.get(a) || 0) - (taskIndices.get(b) || 0));
      }
    });
  }

  if (orderedTasks.length !== tasks.length) {
    // 循環依存がある場合はエラーとする
    const cycleMessage = "dependsOn に循環があるため実行順を決定できません";
    return { orderedTasks: tasks, dependencyErrors: [cycleMessage] };
  }

  logger.debug("dependsOn を考慮してタスク順を決定しました。");
  return { orderedTasks, dependencyErrors: [] };
}

function loadOutputCache(cachePath) {
  if (!fs.existsSync(cachePath)) return {};
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

function saveOutputCache(cachePath, cacheData) {
  const dir = path.dirname(cachePath);
  ensureDirExists(dir);
  // キャッシュも原子的に保存し、途中中断で JSON が壊れる事故を防ぐ。
  writeTextAtomic(cachePath, `${JSON.stringify(cacheData, null, 2)}\n`, "utf8");
}

function getOutputStats(outputPaths) {
  return outputPaths.map((outputPath) => {
    if (!outputPath) {
      return {
        path: outputPath,
        exists: false,
        mtimeMs: null,
        size: null,
      };
    }
    const resolvedPath = path.isAbsolute(outputPath)
      ? outputPath
      : path.join(REPO_ROOT, outputPath);
    if (!fs.existsSync(resolvedPath)) {
      return { path: outputPath, exists: false, mtimeMs: null, size: null };
    }
    const stat = fs.statSync(resolvedPath);
    return {
      path: outputPath,
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  });
}

function outputsChanged(beforeStats, afterStats) {
  if (beforeStats.length !== afterStats.length) return true;
  for (let i = 0; i < beforeStats.length; i += 1) {
    const before = beforeStats[i];
    const after = afterStats[i];
    if (before.exists !== after.exists) return true;
    if (before.mtimeMs !== after.mtimeMs) return true;
    if (before.size !== after.size) return true;
  }
  return false;
}

function createTaskResult(task, status, elapsedSeconds, detail) {
  // status は success/fail/skip のみを利用する
  return {
    id: task.id,
    name: task.name,
    status,
    elapsedSeconds,
    detail,
  };
}

function logHook(hook, logger, label) {
  if (!hook) return;
  if (typeof hook === "string") {
    logger.task(`${label}: ${hook}`);
    return;
  }
  if (typeof hook === "object" && typeof hook.log === "string") {
    logger.task(`${label}: ${hook.log}`);
  }
}

function detectErrorTypeFromTaskResult(result) {
  // 1) 終了コードで明示されていれば最優先で採用する。
  const byExitCode = exitCodeToErrorType(result?.code);
  if (byExitCode && byExitCode !== ERROR_TYPES.UNKNOWN) {
    return byExitCode;
  }

  // 2) stderr の ERROR_TYPE=... を拾う。
  const stderrText = String(result?.stderrText || "");
  const marker = stderrText.match(/ERROR_TYPE=([A-Z_]+)/);
  if (marker) {
    return normalizeErrorType(marker[1]);
  }

  // 3) 既存スクリプト互換のため、エラーメッセージから推定する。
  const combined = `${stderrText}
${String(result?.stdoutText || "")}`;
  const detected = detectErrorType({ message: combined });
  return detected ? normalizeErrorType(detected) : ERROR_TYPES.UNKNOWN;
}

// ------------- main -------------

async function main() {
  const runStart = Date.now();
  const logger = createLogger(null);
  logger.run(`start ${nowIso()}`);

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    logger.error(String(e?.message || e));
    process.exitCode = 1;
    return;
  }

  const loggerWithConfig = createLogger(config.config.log);
  loggerWithConfig.run(`config: ${config.configPath}`);
  if (loggerWithConfig.logFilePath) {
    loggerWithConfig.run(`logFile: ${loggerWithConfig.logFilePath}`);
  }

  const enabledTasks = config.config.tasks.filter((t) => t && t.enabled !== false);

  if (enabledTasks.length === 0) {
    loggerWithConfig.warn("enabled な task がありません。config を確認してください。");
    loggerWithConfig.close();
    return;
  }

  loggerWithConfig.run(
    `tasks: total=${config.config.tasks.length}, enabled=${enabledTasks.length}`
  );
  if (config.config.sleepSecondsBetween > 0) {
    loggerWithConfig.run(`sleepSecondsBetween=${config.config.sleepSecondsBetween}s`);
  }

  const { orderedTasks, dependencyErrors } = orderTasksByDependencies(
    enabledTasks,
    loggerWithConfig
  );
  if (dependencyErrors.length > 0) {
    dependencyErrors.forEach((err) => loggerWithConfig.error(err));
    if (config.config.stopOnError) {
      loggerWithConfig.close();
      process.exitCode = 1;
      return;
    }
    loggerWithConfig.warn("dependsOn の解決に失敗したため列挙順で実行します。");
  }

  // フェーズごとに集計したいので、実行しながらphase計測する
  let currentPhase = null;
  let phaseStart = 0;

  const failed = [];
  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;
  const taskResults = [];
  const failByType = {};

  const outputCachePath = path.join(REPO_ROOT, "logs", "run-all-output-cache.json");
  const outputCache = loadOutputCache(outputCachePath);

  for (let i = 0; i < orderedTasks.length; i += 1) {
    const task = orderedTasks[i];
    const phase = classifyPhase(task);
    const taskSettings = resolveTaskSettings(task, config.config);

    if (phase !== currentPhase) {
      // 前フェーズの終了ログ
      if (currentPhase) {
        const phaseElapsed = Date.now() - phaseStart;
        loggerWithConfig.phase(
          `${phaseLabel(currentPhase)}: done (${msToSec(phaseElapsed)}s)`
        );
      }
      // 新フェーズ開始
      currentPhase = phase;
      phaseStart = Date.now();
      loggerWithConfig.phase(`${phaseLabel(currentPhase)}: start`);
    }

    const label = formatTaskName(task);
    const scriptPathAbs = resolveScriptPath(task.script);

    if (!scriptPathAbs) {
      loggerWithConfig.warn(`${label}: script が未指定のためスキップ`);
      failCount += 1;
      taskResults.push(createTaskResult(task, "skip", 0, "script 未指定"));
      failed.push(task.id || "(no-id)");
      if (config.config.stopOnError && !taskSettings.continueOnError) {
        break;
      }
      continue;
    }

    if (!fs.existsSync(scriptPathAbs)) {
      loggerWithConfig.warn(
        `${label}: script が存在しないためスキップ -> ${scriptPathAbs}`
      );
      failCount += 1;
      taskResults.push(createTaskResult(task, "skip", 0, "script 不存在"));
      failed.push(task.id || "(no-id)");
      if (config.config.stopOnError && !taskSettings.continueOnError) {
        break;
      }
      continue;
    }

    const taskStart = Date.now();
    const displayId = task.id || "(no-id)";
    loggerWithConfig.task(`${displayId}: start`);

    const outputPaths = Array.isArray(task.outputs) ? task.outputs : [];
    const hasOutputs = outputPaths.length > 0;
    const beforeStats = hasOutputs ? getOutputStats(outputPaths) : [];
    let skipped = false;

    if (taskSettings.skipIfOutputsUnchanged && hasOutputs) {
      if (!task.id) {
        loggerWithConfig.warn(
          `${label}: skipIfOutputsUnchanged は id が必要なためスキップ判定できません`
        );
      } else {
        const cacheEntry = outputCache[String(task.id)];
        // キャッシュ欠落・破損時は空扱いにして安全側（スキップしない）
        const cachedStats = cacheEntry?.outputs || [];
        const unchanged = !outputsChanged(cachedStats, beforeStats);
        if (unchanged) {
          skipped = true;
          skipCount += 1;
          taskResults.push(createTaskResult(task, "skip", 0, "outputs unchanged"));
          loggerWithConfig.task(`${displayId}: skip (outputs unchanged)`);
          logHook(task.onSuccess, loggerWithConfig, `${displayId} onSuccess`);
        }
      }
    }

    let result = null;
    let elapsed = 0;
    let attempt = 0;

    while (!skipped) {
      attempt += 1;
      result = await runNodeScript(scriptPathAbs, {
        timeoutSeconds: taskSettings.timeoutSeconds,
        captureStdoutStderr: config.config.log.captureStdoutStderr,
        logger: loggerWithConfig,
        env: {
          ...process.env,
          ...(task.env && typeof task.env === "object" ? task.env : {}),
        },
      });
      elapsed = Date.now() - taskStart;

      if (result.code === 0) {
        break;
      }

      const errorType = detectErrorTypeFromTaskResult(result);
      const retryable = isRetryableErrorType(errorType);
      const retriesExhausted = attempt > taskSettings.retries;
      if (!retryable || retriesExhausted) {
        break;
      }

      if (taskSettings.retryDelaySeconds > 0) {
        loggerWithConfig.warn(
          `${displayId}: retry ${attempt}/${taskSettings.retries} wait ${taskSettings.retryDelaySeconds}s type=${formatErrorTypeLabel(errorType)}`
        );
        await sleep(taskSettings.retryDelaySeconds * 1000);
      }
    }

    if (!skipped && result) {
      if (result.code === 0) {
        okCount += 1;
        loggerWithConfig.task(
          `${displayId}: done (${msToSec(elapsed)}s) exit=0`
        );
        logHook(task.onSuccess, loggerWithConfig, `${displayId} onSuccess`);
        taskResults.push(
          createTaskResult(task, "success", msToSecNumber(elapsed))
        );
      } else {
        failCount += 1;
        const errorType = detectErrorTypeFromTaskResult(result);
        const retryable = isRetryableErrorType(errorType);
        const errText = result.error
          ? ` error=${String(result.error.message || result.error)}`
          : "";
        const timeoutText = result.timedOut ? " timeout=true" : "";
        loggerWithConfig.warn(
          `${displayId}: fail (${msToSec(elapsed)}s) exit=${result.code} type=${formatErrorTypeLabel(errorType)} retryable=${retryable}${timeoutText}${errText}`
        );
        if (errorType === ERROR_TYPES.PARSE) {
          // 解析失敗は恒久的な変更の可能性が高いため、目立つログで通知を強める。
          loggerWithConfig.error(`${displayId}: PARSE failure detected / 解析失敗を検出`);
        }
        failByType[errorType] = (failByType[errorType] || 0) + 1;
        logHook(task.onFailure, loggerWithConfig, `${displayId} onFailure`);
        taskResults.push(
          createTaskResult(
            task,
            "fail",
            msToSecNumber(elapsed),
            `type=${formatErrorTypeLabel(errorType)} retryable=${retryable}`
          )
        );
        failed.push(displayId);
        if (config.config.stopOnError && !taskSettings.continueOnError) {
          break;
        }
      }
    }

    if (!skipped && hasOutputs) {
      const afterStats = getOutputStats(outputPaths);
      const changed = outputsChanged(beforeStats, afterStats);
      // outputs がある場合のみ差分を判定し、結果をログに出す
      loggerWithConfig.task(
        `${displayId}: outputs ${changed ? "更新あり" : "更新なし"}`
      );
      if (task.id) {
        outputCache[String(task.id)] = { outputs: afterStats };
      }
    }

    // 次のtaskまでsleep（最後は不要）
    const isLast = i === orderedTasks.length - 1;
    const sleepSeconds =
      typeof taskSettings.sleepSecondsAfter === "number"
        ? taskSettings.sleepSecondsAfter
        : config.config.sleepSecondsBetween;
    if (!isLast && sleepSeconds > 0) {
      await sleep(sleepSeconds * 1000);
    }
  }

  // 最終フェーズの終了ログ
  if (currentPhase) {
    const phaseElapsed = Date.now() - phaseStart;
    loggerWithConfig.phase(
      `${phaseLabel(currentPhase)}: done (${msToSec(phaseElapsed)}s)`
    );
  }

  const totalElapsed = Date.now() - runStart;
  loggerWithConfig.run(
    `done (${msToSec(totalElapsed)}s) ok=${okCount} fail=${failCount} skip=${skipCount}`
  );

  taskResults.forEach((result) => {
    const name = result.name ? `${result.id} (${result.name})` : result.id;
    const detail = result.detail ? ` ${result.detail}` : "";
    loggerWithConfig.task(
      `summary: ${name || "(no-id)"} status=${result.status} time=${result.elapsedSeconds}s${detail}`
    );
  });

  if (failed.length > 0) {
    const failTypeSummary = Object.entries(failByType)
      .map(([type, count]) => `${formatErrorTypeLabel(type)}=${count}`)
      .join(", ");
    if (failTypeSummary) {
      loggerWithConfig.run(`failed by type: ${failTypeSummary}`);
    }
    loggerWithConfig.run(`failed tasks: ${failed.join(", ")}`);
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }

  saveOutputCache(outputCachePath, outputCache);
  loggerWithConfig.close();
}

main().catch((e) => {
  const logger = createLogger(null);
  logger.error(`unexpected error: ${String(e?.message || e)}`);
  process.exitCode = 1;
});
