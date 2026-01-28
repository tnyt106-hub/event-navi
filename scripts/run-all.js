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

const REPO_ROOT = path.join(__dirname, "..");

// ------------- logging helpers -------------

function nowIso() {
  return new Date().toISOString();
}

function msToSec(ms) {
  return (ms / 1000).toFixed(1);
}

function logRun(msg) {
  console.log(`[RUN] ${msg}`);
}

function logPhase(msg) {
  console.log(`[PHASE] ${msg}`);
}

function logTask(msg) {
  console.log(`  [TASK] ${msg}`);
}

function warnTask(msg) {
  console.warn(`  [WARN] ${msg}`);
}

function errorTask(msg) {
  console.error(`  [ERROR] ${msg}`);
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
  const tasks = Array.isArray(json.tasks) ? json.tasks : [];
  const sleepSecondsBetween =
    typeof json.sleepSecondsBetween === "number" && json.sleepSecondsBetween >= 0
      ? json.sleepSecondsBetween
      : 0;

  return { configPath, tasks, sleepSecondsBetween };
}

// ------------- phase classification -------------

function classifyPhase(task) {
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

function runNodeScript(scriptPathAbs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPathAbs], {
      cwd: REPO_ROOT,
      stdio: "inherit", // bat/log側で拾える。進捗はこの上に出る
      windowsHide: true,
    });

    child.on("close", (code, signal) => {
      resolve({ code: code ?? 1, signal: signal ?? null });
    });

    child.on("error", (err) => {
      resolve({ code: 1, signal: null, error: err });
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
  const script = task.script ? String(task.script) : "(no-script)";
  return `${id} (${script})`;
}

// ------------- main -------------

async function main() {
  const runStart = Date.now();
  logRun(`start ${nowIso()}`);

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    errorTask(String(e?.message || e));
    process.exitCode = 1;
    return;
  }

  logRun(`config: ${config.configPath}`);
  const enabledTasks = config.tasks.filter((t) => t && t.enabled !== false);

  if (enabledTasks.length === 0) {
    warnTask("enabled な task がありません。config を確認してください。");
    return;
  }

  logRun(`tasks: total=${config.tasks.length}, enabled=${enabledTasks.length}`);
  if (config.sleepSecondsBetween > 0) {
    logRun(`sleepSecondsBetween=${config.sleepSecondsBetween}s`);
  }

  // フェーズごとに集計したいので、実行しながらphase計測する
  let currentPhase = null;
  let phaseStart = 0;

  const failed = [];
  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < enabledTasks.length; i += 1) {
    const task = enabledTasks[i];
    const phase = classifyPhase(task);

    if (phase !== currentPhase) {
      // 前フェーズの終了ログ
      if (currentPhase) {
        const phaseElapsed = Date.now() - phaseStart;
        logPhase(`${phaseLabel(currentPhase)}: done (${msToSec(phaseElapsed)}s)`);
      }
      // 新フェーズ開始
      currentPhase = phase;
      phaseStart = Date.now();
      logPhase(`${phaseLabel(currentPhase)}: start`);
    }

    const label = formatTaskName(task);
    const scriptPathAbs = resolveScriptPath(task.script);

    if (!scriptPathAbs) {
      warnTask(`${label}: script が未指定のためスキップ`);
      failCount += 1;
      failed.push(task.id || "(no-id)");
      continue;
    }

    if (!fs.existsSync(scriptPathAbs)) {
      warnTask(`${label}: script が存在しないためスキップ -> ${scriptPathAbs}`);
      failCount += 1;
      failed.push(task.id || "(no-id)");
      continue;
    }

    const taskStart = Date.now();
    logTask(`${task.id || "(no-id)"}: start`);

    const result = await runNodeScript(scriptPathAbs);
    const elapsed = Date.now() - taskStart;

    if (result.code === 0) {
      okCount += 1;
      logTask(`${task.id || "(no-id)"}: done (${msToSec(elapsed)}s) exit=0`);
    } else {
      failCount += 1;
      const errText = result.error ? ` error=${String(result.error.message || result.error)}` : "";
      warnTask(
        `${task.id || "(no-id)"}: fail (${msToSec(elapsed)}s) exit=${result.code}${errText}`
      );
      failed.push(task.id || "(no-id)");
    }

    // 次のtaskまでsleep（最後は不要）
    const isLast = i === enabledTasks.length - 1;
    if (!isLast && config.sleepSecondsBetween > 0) {
      await sleep(config.sleepSecondsBetween * 1000);
    }
  }

  // 最終フェーズの終了ログ
  if (currentPhase) {
    const phaseElapsed = Date.now() - phaseStart;
    logPhase(`${phaseLabel(currentPhase)}: done (${msToSec(phaseElapsed)}s)`);
  }

  const totalElapsed = Date.now() - runStart;
  logRun(`done (${msToSec(totalElapsed)}s) ok=${okCount} fail=${failCount}`);

  if (failed.length > 0) {
    logRun(`failed tasks: ${failed.join(", ")}`);
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

main().catch((e) => {
  errorTask(`unexpected error: ${String(e?.message || e)}`);
  process.exitCode = 1;
});
