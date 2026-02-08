#!/usr/bin/env node
"use strict";

// templates/README.md に書かれた参照ファイルが実在するか確認するスクリプト。
// 目的: テンプレートの運用手順で参照切れを早期検知し、将来の保守コストを下げる。

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const TEMPLATE_README_PATH = path.join(__dirname, "templates", "README.md");

// Markdown 文字列から、`scripts/...` 形式で書かれた参照パスを抽出する。
function extractScriptPathReferences(markdownText) {
  if (typeof markdownText !== "string" || markdownText.length === 0) {
    return [];
  }

  const references = new Set();
  const codeSpanRegex = /`(scripts\/[\w./-]+)`/g;
  let match = null;

  while ((match = codeSpanRegex.exec(markdownText)) !== null) {
    const scriptPath = String(match[1] || "").trim();
    if (!scriptPath) {
      continue;
    }
    references.add(scriptPath);
  }

  return Array.from(references);
}

function main() {
  const readmeText = fs.readFileSync(TEMPLATE_README_PATH, "utf8");
  const references = extractScriptPathReferences(readmeText);

  if (references.length === 0) {
    console.warn("[check-template-links] scripts/ 参照が見つかりませんでした。");
    process.exitCode = 1;
    return;
  }

  const missingPaths = [];
  references.forEach((relativePath) => {
    const absolutePath = path.join(REPO_ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) {
      missingPaths.push(relativePath);
    }
  });

  console.log(`[check-template-links] checked=${references.length}`);

  if (missingPaths.length > 0) {
    missingPaths.forEach((missingPath) => {
      console.error(`[check-template-links] missing: ${missingPath}`);
    });
    process.exitCode = 1;
    return;
  }

  console.log("[check-template-links] all referenced files exist.");
  process.exitCode = 0;
}

main();
