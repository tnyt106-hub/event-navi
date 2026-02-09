#!/usr/bin/env node
"use strict";

// 目的:
// - マージ競合マーカー(<<<<<<< など)の残存を機械的に検知し、
//   競合未解消のままコミットされる事故を防ぐ。
// 使い方:
// - node scripts/check-conflict-markers.js [対象ファイル...]
// - 引数なしの場合は scripts 配下の .js を対象にする。

const fs = require("fs");
const path = require("path");

// Git の競合マーカーは通常「行頭」に7文字連続で現れるため、
// 誤検知を避けるために行頭マッチで判定する。
const CONFLICT_LINE_REGEX = /^([<]{7}|[=]{7}|[>]{7})(?:\s|$)/;

function listJsFilesRecursively(rootDir) {
  const results = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // node_modules は対象外にして高速化する。
        if (entry.name === "node_modules") continue;
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".js")) {
        results.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return results;
}

function findConflictLines(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const found = [];

  lines.forEach((line, index) => {
    if (CONFLICT_LINE_REGEX.test(line)) {
      const marker = line.trim().slice(0, 7);
      found.push({ lineNumber: index + 1, marker });
    }
  });

  return found;
}

function resolveTargetFiles(args) {
  if (args.length > 0) {
    return args.map((p) => path.resolve(process.cwd(), p));
  }
  return listJsFilesRecursively(path.resolve(process.cwd(), "scripts"));
}

function main() {
  const args = process.argv.slice(2);
  const targets = resolveTargetFiles(args);
  let hitCount = 0;

  for (const filePath of targets) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      // 引数で存在しないファイルを渡された場合は警告のみ表示して続行する。
      console.warn(`[warn] 対象ファイルが見つかりません: ${filePath}`);
      continue;
    }

    const hits = findConflictLines(filePath);
    if (hits.length === 0) {
      continue;
    }

    hitCount += hits.length;
    for (const hit of hits) {
      console.error(`[conflict] ${filePath}:${hit.lineNumber} marker=${hit.marker}`);
    }
  }

  if (hitCount > 0) {
    console.error(`[result] conflict markers detected: ${hitCount}`);
    process.exit(1);
  }

  console.log("[result] no conflict markers detected");
}

main();
