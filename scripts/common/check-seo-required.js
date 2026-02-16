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
  { key: "og:url", match: /<meta\s+property=["']og:url["'][^>]*>/i },
  { key: "og:image", match: /<meta\s+property=["']og:image["'][^>]*>/i },
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

// 指定した meta / link の content(href) 値を抽出する。
// 目的: canonical / og:url / 画像URL など、SEOメタ間の不整合を検出するため。
function extractFirstAttributeValue(htmlText, regex, attributeName) {
  const tagMatch = htmlText.match(regex);
  if (!tagMatch) return "";

  const tagText = String(tagMatch[0] || "");
  const attrRegex = new RegExp(`${attributeName}=["']([^"']+)["']`, "i");
  const attrMatch = tagText.match(attrRegex);
  return attrMatch ? String(attrMatch[1] || "").trim() : "";
}

// メタ要素が「存在するだけ」で通ってしまうと、URL食い違いを見逃す。
// canonical / og:url / 画像URL の値一致を追加チェックする。
function collectConsistencyProblems(relativePath, htmlText) {
  const problems = [];

  const canonicalUrl = extractFirstAttributeValue(
    htmlText,
    /<link\s+rel=["']canonical["'][^>]*>/i,
    "href"
  );
  const ogUrl = extractFirstAttributeValue(
    htmlText,
    /<meta\s+property=["']og:url["'][^>]*>/i,
    "content"
  );
  const ogImage = extractFirstAttributeValue(
    htmlText,
    /<meta\s+property=["']og:image["'][^>]*>/i,
    "content"
  );
  const twitterImage = extractFirstAttributeValue(
    htmlText,
    /<meta\s+name=["']twitter:image["'][^>]*>/i,
    "content"
  );

  if (canonicalUrl && ogUrl && canonicalUrl !== ogUrl) {
    problems.push(`${relativePath}: canonical と og:url が不一致`);
  }

  if (ogImage && twitterImage && ogImage !== twitterImage) {
    problems.push(`${relativePath}: og:image と twitter:image が不一致`);
  }

  return problems;
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

    problems.push(...collectConsistencyProblems(relativePath, htmlText));

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
