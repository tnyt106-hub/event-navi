#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

// 生成物の公開ディレクトリを固定し、誤って別階層を検査しないようにする。
const DOCS_DIR = path.join(process.cwd(), "docs");

// 例外ページ（所有権確認ファイルなど）はSEOメタ検査対象から除外する。
const EXCLUDED_PATHS = new Set([
  "google0c365f80d270c9ec.html",
  "partials/date-ad.html"
]);

// 主要HTMLページで最低限必要なSEO要素。
const REQUIRED_MARKERS = [
  { key: "title", match: /<title>[^<]+<\/title>/i },
  { key: "description", match: /<meta\s+name=["']description["'][^>]*>/i },
  { key: "canonical", match: /<link\s+rel=["']canonical["'][^>]*>/i },
  { key: "og:image:alt", match: /<meta\s+property=["']og:image:alt["'][^>]*>/i },
  { key: "twitter:title", match: /<meta\s+name=["']twitter:title["'][^>]*>/i },
  { key: "twitter:description", match: /<meta\s+name=["']twitter:description["'][^>]*>/i }
];

// 一覧/詳細ハブなど、構造化データが重要なページ。
const JSON_LD_REQUIRED_PATHS = [
  "index.html",
  "spot/index.html",
  "facility/index.html",
  "facility-name/index.html"
];

function listHtmlFiles(dirPath) {
  const results = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listHtmlFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".html")) {
      results.push(fullPath);
    }
  }

  return results;
}

function isExcluded(relativePath) {
  return EXCLUDED_PATHS.has(relativePath);
}

function hasJsonLd(htmlText) {
  return /<script\s+type=["']application\/ld\+json["'][\s\S]*?<\/script>/i.test(htmlText);
}

function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    console.error("[SEO CHECK] docs ディレクトリが見つかりません:", DOCS_DIR);
    process.exit(1);
  }

  const htmlFiles = listHtmlFiles(DOCS_DIR);
  const problems = [];

  for (const fullPath of htmlFiles) {
    const relativePath = path.relative(DOCS_DIR, fullPath).replace(/\\/g, "/");
    if (isExcluded(relativePath)) {
      continue;
    }

    const htmlText = fs.readFileSync(fullPath, "utf8");

    for (const marker of REQUIRED_MARKERS) {
      if (!marker.match.test(htmlText)) {
        problems.push(`${relativePath}: ${marker.key} が不足`);
      }
    }

    if (JSON_LD_REQUIRED_PATHS.includes(relativePath) && !hasJsonLd(htmlText)) {
      problems.push(`${relativePath}: application/ld+json が不足`);
    }
  }

  if (problems.length > 0) {
    console.error("[SEO CHECK] 必須SEO要素の不足を検出しました。");
    problems.forEach((problem) => console.error(" -", problem));
    process.exit(1);
  }

  console.log(`[SEO CHECK] OK: ${htmlFiles.length} ファイルを検査し、必須SEO要素の不足はありませんでした。`);
}

main();
