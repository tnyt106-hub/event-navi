#!/usr/bin/env node
"use strict";

/**
 * generate-sitemap.js
 * - docs 配下の HTML を走査し、検索エンジン向け sitemap を自動生成する
 * - URL種別ごとに sitemap を分割して、クロール対象を理解しやすくする
 */

const fs = require("fs");
const path = require("path");
const { formatIsoDateFromUtcDate } = require("../lib/date");

const REPO_ROOT = path.join(__dirname, "..", "..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");
const CNAME_PATH = path.join(DOCS_DIR, "CNAME");
const SITEMAP_INDEX_PATH = path.join(DOCS_DIR, "sitemap.xml");
const SITEMAP_DATE_PATH = path.join(DOCS_DIR, "sitemap-date.xml");
const SITEMAP_SPOT_PATH = path.join(DOCS_DIR, "sitemap-spot.xml");
const SITEMAP_FACILITY_PATH = path.join(DOCS_DIR, "sitemap-facility.xml");
const SITEMAP_OTHER_PATH = path.join(DOCS_DIR, "sitemap-other.xml");

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

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

function collectHtmlFiles(dirPath) {
  const found = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const absPath = path.join(dirPath, entry.name);

    if (entry.name.startsWith(".")) continue;

    if (entry.isDirectory()) {
      if (entry.name === "partials") continue;
      found.push(...collectHtmlFiles(absPath));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".html")) continue;

    found.push(absPath);
  }

  return found;
}

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

function formatLastmod(filePath) {
  const stat = fs.statSync(filePath);
  return formatIsoDateFromUtcDate(new Date(stat.mtimeMs));
}

function hasNoindexDirective(filePath) {
  const html = fs.readFileSync(filePath, "utf8");
  return /<meta\s+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html);
}

function buildUrlsetXml(urlItems) {
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

function buildSitemapIndexXml(indexItems) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];

  for (const item of indexItems) {
    lines.push("  <sitemap>");
    lines.push(`    <loc>${escapeXml(item.loc)}</loc>`);
    lines.push(`    <lastmod>${escapeXml(item.lastmod)}</lastmod>`);
    lines.push("  </sitemap>");
  }

  lines.push("</sitemapindex>");
  lines.push("");
  return lines.join("\n");
}

// URLパスでカテゴリを判定し、sitemap分割先を決める。
function resolveSitemapCategory(relativePath) {
  if (relativePath.startsWith("date/")) return "date";
  if (relativePath.startsWith("spot/")) return "spot";
  if (relativePath.startsWith("facility/") || relativePath.startsWith("facility-name/")) return "facility";
  return "other";
}

function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    throw new Error(`docs ディレクトリが見つかりません: ${DOCS_DIR}`);
  }

  const baseUrl = resolveBaseUrl();
  const htmlFiles = collectHtmlFiles(DOCS_DIR);

  const buckets = {
    date: new Map(),
    spot: new Map(),
    facility: new Map(),
    other: new Map()
  };

  htmlFiles
    .sort((a, b) => a.localeCompare(b, "en"))
    .forEach((filePath) => {
      const rel = path.relative(DOCS_DIR, filePath).replace(/\\/g, "/");
      if (rel === "spot/index.html") return;
      if (/^google[\w-]*\.html$/i.test(rel)) return;
      if (hasNoindexDirective(filePath)) return;

      const loc = toPublicUrl(baseUrl, filePath);
      const category = resolveSitemapCategory(rel);
      buckets[category].set(loc, {
        loc,
        lastmod: formatLastmod(filePath)
      });
    });

  // 各カテゴリの sitemap を先に書き出して、最後に sitemap-index から参照する。
  const outputs = [
    { key: "date", path: SITEMAP_DATE_PATH, publicPath: "/sitemap-date.xml" },
    { key: "spot", path: SITEMAP_SPOT_PATH, publicPath: "/sitemap-spot.xml" },
    { key: "facility", path: SITEMAP_FACILITY_PATH, publicPath: "/sitemap-facility.xml" },
    { key: "other", path: SITEMAP_OTHER_PATH, publicPath: "/sitemap-other.xml" }
  ];

  const now = formatIsoDateFromUtcDate(new Date());
  outputs.forEach((output) => {
    const items = [...buckets[output.key].values()];
    const xml = buildUrlsetXml(items);
    fs.writeFileSync(output.path, xml, "utf8");
    console.log(`[generate-sitemap] ${path.basename(output.path)} pages=${items.length}`);
  });

  const sitemapIndexItems = outputs
    .filter((output) => fs.existsSync(output.path))
    .map((output) => ({
      loc: `${baseUrl}${output.publicPath}`,
      lastmod: now
    }));

  const indexXml = buildSitemapIndexXml(sitemapIndexItems);
  fs.writeFileSync(SITEMAP_INDEX_PATH, indexXml, "utf8");

  console.log(`[generate-sitemap] baseUrl=${baseUrl}`);
  console.log(`[generate-sitemap] wrote ${path.relative(REPO_ROOT, SITEMAP_INDEX_PATH)}`);
}

main();
