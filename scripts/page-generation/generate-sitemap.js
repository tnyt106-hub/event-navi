#!/usr/bin/env node
"use strict";

/**
 * generate-sitemap.js
 * - docs 配下の HTML を走査し、検索エンジン向け sitemap.xml を自動生成する
 * - run-all.js から毎日実行されることを想定し、毎回最新状態へ上書きする
 */

const fs = require("fs");
const path = require("path");
const { formatIsoDateFromUtcDate } = require("../lib/date");

const REPO_ROOT = path.join(__dirname, "..", "..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");
const CNAME_PATH = path.join(DOCS_DIR, "CNAME");
const OUTPUT_PATH = path.join(DOCS_DIR, "sitemap.xml");

/**
 * XML で予約される記号をエスケープして、壊れた XML になる事故を防ぐ
 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * CNAME があればそれを優先し、なければ環境変数、最後に localhost を使う
 * - スキーム付き URL に正規化することで sitemap の仕様に合わせる
 */
function resolveBaseUrl() {
  const envBase = process.env.SITEMAP_BASE_URL ? process.env.SITEMAP_BASE_URL.trim() : "";
  const cname = fs.existsSync(CNAME_PATH)
    ? fs.readFileSync(CNAME_PATH, "utf8").trim()
    : "";

  const candidate = envBase || cname || "localhost";
  if (/^https?:\/\//i.test(candidate)) {
    return candidate.replace(/\/+$/, "");
  }
  return `https://${candidate.replace(/^\/+|\/+$/g, "")}`;
}

/**
 * docs 配下を再帰走査して、sitemap に載せる HTML ファイルを集める
 */
function collectHtmlFiles(dirPath) {
  const found = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const absPath = path.join(dirPath, entry.name);

    // 隠しファイルやログ類を誤って拾わないように除外する
    if (entry.name.startsWith(".")) continue;

    if (entry.isDirectory()) {
      // partials は部品ファイルなのでサイトマップ対象から除外する。
      if (entry.name === "partials") {
        continue;
      }
      found.push(...collectHtmlFiles(absPath));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".html")) continue;

    // date 配下の index などを URL 化するため、絶対パスで保持する
    found.push(absPath);
  }

  return found;
}

/**
 * ファイルパスから公開 URL を組み立てる
 * - ".../index.html" はディレクトリ URL (末尾スラッシュ付き) に変換
 * - それ以外の html はそのまま "/file.html" 形式で公開
 */
function toPublicUrl(baseUrl, absoluteHtmlPath) {
  const rel = path.relative(DOCS_DIR, absoluteHtmlPath).replace(/\\/g, "/");
  if (rel === "index.html") {
    return `${baseUrl}/`;
  }
  if (rel.endsWith("/index.html")) {
    return `${baseUrl}/${rel.slice(0, -"index.html".length)}`;
  }
  return `${baseUrl}/${rel}`;
}

/**
 * lastmod は検索エンジンが更新タイミングを判断するためのヒント
 * - 日次バッチ想定なので、日付（YYYY-MM-DD）までを出力する
 */
function formatLastmod(filePath) {
  // ファイル更新日時は UTC 日付へ丸め、サイトマップ全体で形式を揃える。
  const stat = fs.statSync(filePath);
  return formatIsoDateFromUtcDate(new Date(stat.mtimeMs));
}


/**
 * noindex 指定ページは sitemap から除外し、クロール優先度を重要ページへ寄せる
 */
function hasNoindexDirective(filePath) {
  const html = fs.readFileSync(filePath, "utf8");
  return /<meta\s+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html);
}

function buildSitemapXml(urlItems) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];

  for (const item of urlItems) {
    lines.push("  <url>");
    lines.push(`    <loc>${escapeXml(item.loc)}</loc>`);
    lines.push(`    <lastmod>${escapeXml(item.lastmod)}</lastmod>`);
    lines.push("  </url>");
  }

  lines.push("</urlset>");
  lines.push("");

  return lines.join("\n");
}

function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    throw new Error(`docs ディレクトリが見つかりません: ${DOCS_DIR}`);
  }

  const baseUrl = resolveBaseUrl();
  const htmlFiles = collectHtmlFiles(DOCS_DIR);

  // URL の重複を防ぎつつ、安定した並び順で生成して差分を見やすくする
  const deduped = new Map();
  htmlFiles
    .sort((a, b) => a.localeCompare(b, "en"))
    .forEach((filePath) => {
      const rel = path.relative(DOCS_DIR, filePath).replace(/\\/g, "/");
      // spot/index.html はクエリ互換用のテンプレートページなのでインデックス対象から除外する。
      if (rel === "spot/index.html") {
        return;
      }

      // noindex 付きページをサイトマップから除外し、低優先ページの送信を防ぐ。
      if (hasNoindexDirective(filePath)) {
        return;
      }

      const loc = toPublicUrl(baseUrl, filePath);
      deduped.set(loc, {
        loc,
        lastmod: formatLastmod(filePath),
      });
    });

  const xml = buildSitemapXml([...deduped.values()]);
  fs.writeFileSync(OUTPUT_PATH, xml, "utf8");

  console.log(`[generate-sitemap] baseUrl=${baseUrl}`);
  console.log(`[generate-sitemap] pages=${deduped.size}`);
  console.log(`[generate-sitemap] wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
}

main();
