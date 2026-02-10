// 一覧 → 詳細ページの2段構成施設向けスクレイピングテンプレート。
// 使い方: node scripts/scraping/templates/fetch-template-listing-plus-detail.js

const path = require("path");
const { URL } = require("url");

// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("../../lib/http");
// JSON 保存処理と検証を共通化する。
const { finalizeAndSaveEvents } = require("../../lib/fetch_output");
// CLI エラー終了コードを共通化する。
const { handleCliFatalError } = require("../../lib/cli_error");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities, normalizeWhitespace, stripTagsWithLineBreaks } = require("../../lib/text");

// TODO: 施設ID、一覧URL、出力先を施設ごとに埋める。
const VENUE_ID = "your_venue_id";
const LIST_URL = "https://example.com/events";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "..", "docs", "events", `${VENUE_ID}.json`);

// TODO: 月別一覧を巡回したい施設は true にする（デフォルトは単一一覧ページ）。
const USE_MONTHLY_LIST_PAGES = false;
// TODO: 月別巡回時の最大ページ数（無限ループ防止用）。
const MAX_LIST_PAGES = 36;
// TODO: 月別巡回時の対象範囲（日数）。過去/未来の範囲を施設ごとに調整する。
const PAST_DAYS_LIMIT = 365;
const FUTURE_DAYS_LIMIT = 365;

// 日付文字列を ISO 形式 (YYYY-MM-DD) に変換する。
function toIsoDate(year, month, day) {
  const yyyy = String(year);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// テキストから日付を抽出する（必要に応じてパターンを追加する）。
function extractDate(text) {
  const normalized = normalizeWhitespace(text);
  const match = /([0-9]{4})[./年]([0-9]{1,2})[./月]([0-9]{1,2})日?/.exec(normalized);
  if (!match) return null;
  return toIsoDate(match[1], match[2], match[3]);
}

// body 用のテキストを整形する（改行単位でトリムし、最大 5000 文字に収める）。
function formatBody(text) {
  if (!text) return "";
  const lines = text
    // 改行ごとに分割する。
    .split(/\r?\n/)
    // 各行の前後をトリムする。
    .map((line) => line.trim())
    // 空行は除外する。
    .filter((line) => line.length > 0);
  const maxLength = 5000;
  const resultLines = [];
  let totalLength = 0;

  for (const line of lines) {
    // 既存行がある場合は改行 1 文字を追加する。
    const separatorLength = resultLines.length > 0 ? 1 : 0;
    const nextLength = totalLength + separatorLength + line.length;

    if (nextLength > maxLength) {
      // 追加しない代わりに、直前の行へ … を付与する。
      if (resultLines.length > 0) {
        if (totalLength + 1 <= maxLength) {
          resultLines[resultLines.length - 1] = `${resultLines[resultLines.length - 1]}…`;
        } else {
          const lastLine = resultLines[resultLines.length - 1];
          resultLines[resultLines.length - 1] = `${lastLine.slice(0, Math.max(0, lastLine.length - 1))}…`;
        }
      }
      break;
    }

    resultLines.push(line);
    totalLength = nextLength;
  }

  return resultLines.join("\n");
}

// body を入れるべきか判定する。
function shouldIncludeBody({ openTime, startTime, endTime, price, contact }) {
  return !openTime && !startTime && !endTime && !price && !contact;
}

// 月別一覧の巡回範囲を決める（当日を基準に過去/未来日数を加減算する）。
function getMonthRangeFromToday() {
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - PAST_DAYS_LIMIT);
  const end = new Date(today);
  end.setDate(end.getDate() + FUTURE_DAYS_LIMIT);
  return { start, end };
}

// 月別 URL の正規化を行う。
// TODO: 施設ごとに月別 URL のパスを調整する（page/2/ のような URL を拾わないこと）。
function normalizeMonthUrl(absUrl) {
  try {
    const url = new URL(absUrl);
    // 例: /event/date/YYYY/MM/ のみを許可する（完全一致が安全）。
    const match = /^\/event\/date\/([0-9]{4})\/([0-9]{1,2})\/?$/.exec(url.pathname);
    if (!match) {
      return null;
    }
    const yyyy = match[1];
    const mm = String(match[2]).padStart(2, "0");

    url.pathname = `/event/date/${yyyy}/${mm}/`;
    url.search = "";
    url.hash = "";

    return url.toString();
  } catch (error) {
    return null;
  }
}

// 月別 URL から年月を取り出す（正規化済み URL を前提）。
function extractYearMonthFromMonthUrl(absUrl) {
  try {
    const url = new URL(absUrl);
    const match = /^\/event\/date\/([0-9]{4})\/([0-9]{2})\/$/.exec(url.pathname);
    if (!match) {
      return null;
    }
    return { year: Number(match[1]), month: Number(match[2]) };
  } catch (error) {
    return null;
  }
}

// 月単位で指定範囲と交差するか判定する（月初〜月末でチェック）。
function isMonthInRange(year, month, start, end) {
  const monthStart = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);
  return monthEnd >= start && monthStart <= end;
}

// 一覧 HTML から月別ページリンクを抽出する。
// TODO: 施設ごとに HTML 構造に合わせて抽出ロジックを調整する。
function extractMonthPageLinks(listHtml, currentUrl) {
  const links = [];
  const anchorRegex = /<a\b[^>]*href=['"]([^'"]+)['"][^>]*>/gi;

  for (const match of listHtml.matchAll(anchorRegex)) {
    const href = match[1];
    if (!href) {
      continue;
    }
    try {
      const absoluteUrl = new URL(href, currentUrl).toString();
      const normalizedUrl = normalizeMonthUrl(absoluteUrl);
      if (normalizedUrl) {
        links.push(normalizedUrl);
      }
    } catch (error) {
      continue;
    }
  }

  return links;
}

// 一覧 HTML から詳細ページのリンク一覧を抽出する。
// TODO: 施設の HTML 構造に合わせて抽出ロジックを調整する。
function extractDetailLinks(html) {
  const links = [];
  const anchorRegex = /<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    const href = match[1];
    const text = normalizeWhitespace(decodeHtmlEntities(stripTagsWithLineBreaks(match[2])));
    if (!href || !text) {
      continue;
    }
    links.push({ href, text });
  }

  return links;
}

// HTML からタイトルを抽出する（h1 → h2 → h3 → fallback の順）。
function extractTitleFromHtml(html) {
  // 見出しタグから順に探す。
  const headingTags = ["h1", "h2", "h3"];
  for (const tag of headingTags) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const match = regex.exec(html);
    if (match) {
      const headingText = normalizeWhitespace(decodeHtmlEntities(stripTagsWithLineBreaks(match[1])));
      return headingText;
    }
  }

  // fallback: プレーンテキストの先頭 60 文字を使う。
  const plainText = normalizeWhitespace(decodeHtmlEntities(stripTagsWithLineBreaks(html)));
  if (!plainText) return "";
  const maxLength = 60;
  if (plainText.length > maxLength) {
    return `${plainText.slice(0, maxLength)}…`;
  }
  return plainText;
}

// 詳細 HTML からイベント情報を抽出する。
// TODO: 施設の HTML 構造に合わせて抽出ロジックを調整する。
function extractEventFromDetail(detailHtml, detailUrl) {
  const plainText = normalizeWhitespace(decodeHtmlEntities(stripTagsWithLineBreaks(detailHtml)));
  const title = extractTitleFromHtml(detailHtml);
  const dateFrom = extractDate(plainText);

  // TODO: 可能であれば構造化項目を抽出する。
  const openTime = null;
  const startTime = null;
  const endTime = null;
  const price = null;
  const contact = null;

  // TODO: body を使う場合は詳細説明テキストを抽出する。
  const bodyText = "";

  if (!title || !dateFrom) {
    return null;
  }

  const event = {
    title,
    date_from: dateFrom,
    date_to: dateFrom,
    source_url: detailUrl,
  };

  if (openTime) event.open_time = openTime;
  if (startTime) event.start_time = startTime;
  if (endTime) event.end_time = endTime;
  if (price) event.price = price;
  if (contact) event.contact = contact;

  if (bodyText && shouldIncludeBody({ openTime, startTime, endTime, price, contact })) {
    const formattedBody = formatBody(bodyText);
    if (formattedBody) {
      event.body = formattedBody;
    }
  }

  return event;
}

// 詳細ページ URL を解決する（相対/絶対をどちらでも受ける）。
function resolveDetailUrl(link, baseUrl) {
  return new URL(link.href, baseUrl).toString();
}

// 詳細リンクのユニーク数を数える（ログ用）。
function countUniqueDetailLinks(detailLinks, baseUrl) {
  const unique = new Set();
  for (const link of detailLinks) {
    try {
      unique.add(resolveDetailUrl(link, baseUrl));
    } catch (error) {
      continue;
    }
  }
  return unique.size;
}

// 月別一覧を巡回して詳細リンクを収集する（visited + queue で巡回）。
async function fetchAllDetailLinks(seedUrl) {
  const visited = new Set();
  const queue = [seedUrl];
  const detailLinkMap = new Map();
  let listPages = 0;
  let listLinks = 0;

  const { start, end } = getMonthRangeFromToday();
  const monthRangeLabel = `${start.toISOString().slice(0, 7)} .. ${end.toISOString().slice(0, 7)}`;

  while (queue.length > 0 && listPages < MAX_LIST_PAGES) {
    const currentUrl = queue.shift();
    if (visited.has(currentUrl)) {
      continue;
    }
    visited.add(currentUrl);
    listPages += 1;

    const listHtml = await fetchText(currentUrl, {
      acceptEncoding: "identity",
      encoding: "utf-8",
    });

    const detailLinks = extractDetailLinks(listHtml);
    listLinks += detailLinks.length;

    for (const link of detailLinks) {
      try {
        const absoluteUrl = resolveDetailUrl(link, currentUrl);
        detailLinkMap.set(absoluteUrl, {
          href: absoluteUrl,
          text: link.text,
        });
      } catch (error) {
        continue;
      }
    }

    const monthLinks = extractMonthPageLinks(listHtml, currentUrl);
    for (const monthUrl of monthLinks) {
      const monthInfo = extractYearMonthFromMonthUrl(monthUrl);
      if (!monthInfo) {
        continue;
      }
      if (!isMonthInRange(monthInfo.year, monthInfo.month, start, end)) {
        continue;
      }
      if (!visited.has(monthUrl)) {
        queue.push(monthUrl);
      }
    }
  }

  if (queue.length > 0 && listPages >= MAX_LIST_PAGES) {
    console.warn(`[fetch] list_pages が MAX_LIST_PAGES(${MAX_LIST_PAGES}) に到達したため打ち切り`);
  }

  return {
    detailLinks: Array.from(detailLinkMap.values()),
    stats: {
      listPages,
      listLinks,
      detailLinksUnique: detailLinkMap.size,
      monthRangeLabel,
    },
  };
}

// 成功時のみファイルを書き換える。
function saveEventsFile(events) {
  finalizeAndSaveEvents({
    venueId: VENUE_ID,
    outputPath: OUTPUT_PATH,
    events,
    // 詳細テンプレートでは date_from 必須で保存する。
    requireDateFrom: true,
  });
}

async function main() {
  let listPages = 0;
  let listLinks = 0;
  let detailLinksUnique = 0;
  let detailFetchSuccess = 0;
  let detailFetchFailed = 0;
  let eventsBuilt = 0;
  let excludedInvalid = 0;
  let monthRangeLabel = "";

  try {
    let detailLinks = [];

    if (USE_MONTHLY_LIST_PAGES) {
      const { detailLinks: monthlyDetailLinks, stats } = await fetchAllDetailLinks(LIST_URL);
      detailLinks = monthlyDetailLinks;
      listPages = stats.listPages;
      listLinks = stats.listLinks;
      detailLinksUnique = stats.detailLinksUnique;
      monthRangeLabel = stats.monthRangeLabel;
    } else {
      const listHtml = await fetchText(LIST_URL, {
        acceptEncoding: "identity",
        encoding: "utf-8",
      });

      detailLinks = extractDetailLinks(listHtml);
      listPages = 1;
      listLinks = detailLinks.length;
      detailLinksUnique = countUniqueDetailLinks(detailLinks, LIST_URL);
    }

    const events = [];

    // 詳細ページ取得は、サーバー負荷とログ追跡を安定させるために逐次処理としている。
    // TODO: 将来的に concurrency 上限つきの並列取得へ切り替えられるように検討する（現状の挙動は維持）。
    for (const link of detailLinks) {
      let detailUrl = "";
      try {
        detailUrl = resolveDetailUrl(link, LIST_URL);
      } catch (error) {
        detailFetchFailed += 1;
        console.warn(`詳細URLが不正のため除外: ${link.href}`);
        continue;
      }

      try {
        const detailHtml = await fetchText(detailUrl, {
          acceptEncoding: "identity",
          encoding: "utf-8",
        });
        detailFetchSuccess += 1;
        const event = extractEventFromDetail(detailHtml, detailUrl);
        if (!event) {
          excludedInvalid += 1;
          continue;
        }
        events.push(event);
      } catch (error) {
        detailFetchFailed += 1;
        console.warn(`詳細取得に失敗: ${detailUrl} (${error.message})`);
      }
    }

    eventsBuilt = events.length;

    if (USE_MONTHLY_LIST_PAGES && monthRangeLabel) {
      console.log(`[fetch] month_range: ${monthRangeLabel}`);
    }
    console.log(`[fetch] list_pages: ${listPages}`);
    console.log(`[fetch] list_links: ${listLinks}`);
    console.log(`[fetch] detail_links_unique: ${detailLinksUnique}`);
    console.log(`[fetch] detail_fetch_success: ${detailFetchSuccess}`);
    console.log(`[fetch] detail_fetch_failed: ${detailFetchFailed}`);
    console.log(`[fetch] excluded_invalid: ${excludedInvalid}`);
    console.log(`[fetch] events_built: ${eventsBuilt}`);
    console.log(`[fetch] output_path: ${OUTPUT_PATH}`);

    saveEventsFile(events);
  } catch (error) {
    handleCliFatalError(error, { prefix: `[${VENUE_ID}] 失敗` });
  }
}

main();
