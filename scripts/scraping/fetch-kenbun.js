// 愛媛県県民文化会館（kenbun.jp）のイベント一覧から
// 一覧ページ→詳細ページの2段階でイベント情報を取得して保存するバッチ。
// 使い方: node scripts/scraping/fetch-kenbun.js

const path = require("path");
const { URL } = require("url");

// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("../lib/http");
// JSON 保存処理を共通化する。
const { finalizeAndSaveEvents } = require("../lib/fetch_output");
const { handleCliFatalError } = require("../lib/cli_error");
const { sleep, mapWithConcurrencyLimit } = require("../lib/concurrency");
const { getJstTodayUtcDate } = require("../lib/date");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities, normalizeWhitespace, stripTagsWithLineBreaks } = require("../lib/text");
const {
  normalizeFullWidthBasic,
  extractTextLinesFromHtml,
  extractLabeledValue,
  toIsoDate,
} = require("../lib/scraping");

const VENUE_ID = "kenbun";
const VENUE_NAME = "愛媛県県民文化会館";
const ENTRY_URL = "https://www.kenbun.jp/event/";
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "events", "kenbun.json");
// 月別一覧は3年分程度を上限にガードする。
const MAX_LIST_PAGES = 36;
// 過去・未来の対象日数は 1 年分に制限する。
const PAST_DAYS_LIMIT = 365;
const FUTURE_DAYS_LIMIT = 365;
// body の最大長は既存方針に合わせる。
const MAX_BODY_LENGTH = 5000;
const BODY_TRUNCATION_SUFFIX = "…";
// 詳細ページ取得の同時実行数（負荷が高ければ 2 に下げられる）。
const DETAIL_CONCURRENCY = 3;
// 連続アクセスを避けるためのジッター。
// 1 リクエストごとの待機を短くしつつ、瞬間的な集中アクセスは避ける。
const DETAIL_JITTER_MS = 80;
// 詳細取得のリトライ回数は共通 HTTP ユーティリティへ委譲する。
const DETAIL_FETCH_RETRY_COUNT = 2;
// リトライ待機の基準値も共通 HTTP ユーティリティへ渡す。
const DETAIL_FETCH_RETRY_BASE_DELAY_MS = 500;

let lastListStats = { listPages: 0, listLinks: 0 };

// 月別一覧ページの URL から年・月を抽出する。
function extractMonthFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/^\/event\/date\/(\d{4})\/(\d{1,2})\/?$/);
    if (!match) {
      return null;
    }
    return {
      year: Number(match[1]),
      month: Number(match[2]),
    };
  } catch (error) {
    return null;
  }
}

// 月別一覧ページの URL を正規化して返す（対象外は null）。
function normalizeMonthUrl(absUrl) {
  try {
    const parsedUrl = new URL(absUrl);
    const match = parsedUrl.pathname.match(/^\/event\/date\/(\d{4})\/(\d{1,2})\/?$/);
    if (!match) {
      return null;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    // month は 1..12 の範囲のみ許可する。
    if (Number.isNaN(month) || month < 1 || month > 12) {
      return null;
    }
    const monthPadded = String(month).padStart(2, "0");
    // 正規化した URL はホストと末尾スラッシュを固定する。
    return `https://www.kenbun.jp/event/date/${year}/${monthPadded}/`;
  } catch (error) {
    return null;
  }
}

// 月が指定範囲にかかるか判定する。
function isMonthInRange(year, month, start, end) {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  monthEnd.setUTCDate(monthEnd.getUTCDate() - 1);
  return monthStart <= end && monthEnd >= start;
}

// 一覧 HTML から月別一覧ページのリンクを抽出する。
function extractMonthPageLinks(listHtml, currentUrl) {
  const links = [];
  const regex = /href=["']([^"']+)["']/gi;
  let match = null;

  while ((match = regex.exec(listHtml)) !== null) {
    const href = match[1];
    if (!href) continue;
    // 相対/絶対どちらの href でも URL を正規化してから判定する。
    let absUrl = "";
    try {
      absUrl = new URL(href, currentUrl).toString();
    } catch (error) {
      continue;
    }
    // URL を正規化して、月別一覧ページだけを集める。
    const normalizedUrl = normalizeMonthUrl(absUrl);
    if (normalizedUrl) {
      links.push(normalizedUrl);
    }
  }

  return links;
}

// 一覧 HTML から詳細ページのリンクを抽出する。
function extractDetailLinksFromList(listHtml) {
  const links = [];
  const regex = /href=["']([^"']+)["']/gi;
  let match = null;

  while ((match = regex.exec(listHtml)) !== null) {
    const href = match[1];
    if (!href) continue;
    if (href.includes("/event/date/")) continue;
    if (href.includes("/event/feed/")) continue;
    if (/\/event\/\d+\/?$/.test(href) || /\/event\/\d+\/?(\?|#)/.test(href)) {
      links.push(href);
    }
  }

  return links;
}

// 一覧ページを巡回しながら詳細リンクを集める。
async function fetchAllDetailLinks(seedUrl) {
  const visitedListUrls = new Set();
  // 既にキューへ積んだ URL も管理し、重複投入による無駄ループを防ぐ。
  const queuedListUrls = new Set();
  const queue = [];
  const detailLinks = new Set();
  let listLinks = 0;
  const todayJst = getJstTodayUtcDate();
  const rangeStart = new Date(todayJst);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - PAST_DAYS_LIMIT);
  const rangeEnd = new Date(todayJst);
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + FUTURE_DAYS_LIMIT);

  console.log(
    `[fetch] month_range: ${rangeStart.toISOString().slice(0, 7)} .. ${rangeEnd.toISOString().slice(0, 7)}`
  );

  // 入口ページは 1 回だけ取得し、月別 URL をキューに積む。
  try {
    const seedHtml = await fetchText(seedUrl, { acceptEncoding: "identity", encoding: "utf-8" });
    const monthLinks = extractMonthPageLinks(seedHtml, seedUrl);
    for (const absUrl of monthLinks) {
      const monthInfo = extractMonthFromUrl(absUrl);
      if (!monthInfo) {
        continue;
      }
      if (!isMonthInRange(monthInfo.year, monthInfo.month, rangeStart, rangeEnd)) {
        continue;
      }
      if (!visitedListUrls.has(absUrl) && !queuedListUrls.has(absUrl)) {
        queue.push(absUrl);
        queuedListUrls.add(absUrl);
      }
    }

    const detailLinksFromSeed = extractDetailLinksFromList(seedHtml);
    listLinks += detailLinksFromSeed.length;
    for (const href of detailLinksFromSeed) {
      let absUrl = "";
      try {
        absUrl = new URL(href, seedUrl).toString();
      } catch (error) {
        continue;
      }
      detailLinks.add(absUrl);
    }
  } catch (error) {
    console.warn(`一覧取得に失敗: ${seedUrl} (${error.message})`);
    lastListStats = { listPages: visitedListUrls.size, listLinks };
    return detailLinks;
  }

  while (queue.length > 0) {
    if (visitedListUrls.size >= MAX_LIST_PAGES) {
      console.warn(`[warn] list_pages が上限(${MAX_LIST_PAGES})に達したため打ち切ります。`);
      break;
    }

    const currentUrl = queue.shift();
    if (!currentUrl || visitedListUrls.has(currentUrl)) {
      continue;
    }

    // 取り出した時点でキュー管理集合からは除外する。
    queuedListUrls.delete(currentUrl);
    visitedListUrls.add(currentUrl);

    let html = "";
    try {
      html = await fetchText(currentUrl, { acceptEncoding: "identity", encoding: "utf-8" });
    } catch (error) {
      console.warn(`一覧取得に失敗: ${currentUrl} (${error.message})`);
      continue;
    }

    const monthLinks = extractMonthPageLinks(html, currentUrl);
    for (const absUrl of monthLinks) {
      const monthInfo = extractMonthFromUrl(absUrl);
      if (!monthInfo) {
        continue;
      }
      if (!isMonthInRange(monthInfo.year, monthInfo.month, rangeStart, rangeEnd)) {
        continue;
      }
      if (!visitedListUrls.has(absUrl) && !queuedListUrls.has(absUrl)) {
        queue.push(absUrl);
        queuedListUrls.add(absUrl);
      }
    }

    const detailLinksFromList = extractDetailLinksFromList(html);
    listLinks += detailLinksFromList.length;
    for (const href of detailLinksFromList) {
      let absUrl = "";
      try {
        absUrl = new URL(href, currentUrl).toString();
      } catch (error) {
        continue;
      }
      detailLinks.add(absUrl);
    }
  }

  lastListStats = { listPages: visitedListUrls.size, listLinks };
  return detailLinks;
}

// 詳細ページからタイトルを抽出する。
function extractTitleFromDetail(html) {
  const lines = extractTextLinesFromHtml(html);
  const titleFromLabel = extractLabeledValue(lines, "イベント名");
  if (titleFromLabel) {
    return titleFromLabel;
  }

  const headingTags = ["h1", "h2", "h3"];
  for (const tag of headingTags) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const match = regex.exec(html);
    if (match) {
      const headingText = normalizeWhitespace(decodeHtmlEntities(stripTagsWithLineBreaks(match[1])));
      if (headingText) {
        return headingText;
      }
    }
  }

  const plainText = normalizeWhitespace(decodeHtmlEntities(stripTagsWithLineBreaks(html)));
  if (!plainText) return "";
  if (plainText.length > 60) {
    return `${plainText.slice(0, 60)}…`;
  }
  return plainText;
}

// 詳細ページから開催日を抽出する。
function extractJapaneseDateFromDetail(html) {
  const lines = extractTextLinesFromHtml(html);
  const dateText = extractLabeledValue(lines, "開催日");
  const candidateText = dateText || lines.join(" ");
  const normalized = normalizeFullWidthBasic(candidateText);
  const match = normalized.match(/([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日/);
  if (!match) return null;
  return toIsoDate(match[1], match[2], match[3]);
}

// 詳細ページから開場・開演・終演時刻を抽出する。
function extractTimeFields(html) {
  const lines = extractTextLinesFromHtml(html);
  const joined = normalizeFullWidthBasic(lines.join(" "));

  const extractTime = (label) => {
    const regex = new RegExp(`${label}\\s*[:：]?\\s*([0-9]{1,2}:[0-9]{2})`);
    const match = joined.match(regex);
    return match ? match[1] : null;
  };

  return {
    open_time: extractTime("開場"),
    start_time: extractTime("開演"),
    end_time: extractTime("終演"),
  };
}

// 詳細ページから入場料などの価格情報を抽出する。
function extractPrice(html) {
  const lines = extractTextLinesFromHtml(html);
  const value = extractLabeledValue(lines, "入場料など") || extractLabeledValue(lines, "入場料");
  return value || null;
}

// 詳細ページから連絡先 (TEL) を抽出する。
function extractContact(html) {
  const lines = extractTextLinesFromHtml(html);
  const phonePattern = /\d{2,4}-\d{2,4}-\d{3,4}/;

  for (const line of lines) {
    const normalized = normalizeFullWidthBasic(line);
    if (!/TEL|電話/.test(normalized)) {
      continue;
    }
    if (phonePattern.test(normalized)) {
      return normalizeWhitespace(normalized);
    }
  }

  return null;
}

// body を入れるべきか判定する。
function shouldIncludeBody({ openTime, startTime, endTime, price, contact }) {
  return !openTime && !startTime && !endTime && !price && !contact;
}

// 詳細ページの本文・備考テキストを整形する。
function extractBodyFallback(html) {
  const withLineBreaks = stripTagsWithLineBreaks(html);
  const decoded = decodeHtmlEntities(withLineBreaks);
  const normalizedLines = decoded
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0);
  const normalizedText = normalizedLines.join("\n");
  return formatBody(normalizedText);
}

// body 用のテキストを整形する（改行単位でトリムし、最大 5000 文字に収める）。
function formatBody(text) {
  if (!text) return "";
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const resultLines = [];
  let totalLength = 0;

  for (const line of lines) {
    const separatorLength = resultLines.length > 0 ? 1 : 0;
    const nextLength = totalLength + separatorLength + line.length;

    if (nextLength > MAX_BODY_LENGTH) {
      if (resultLines.length === 0) {
        // 先頭行だけでも収めるため、末尾に … を付けて切り詰める。
        const allowedLength = Math.max(0, MAX_BODY_LENGTH - BODY_TRUNCATION_SUFFIX.length);
        resultLines.push(`${line.slice(0, allowedLength)}${BODY_TRUNCATION_SUFFIX}`);
      } else {
        // 既存の最後の行に … を付けて打ち切る。
        resultLines[resultLines.length - 1] = `${resultLines[resultLines.length - 1]}${BODY_TRUNCATION_SUFFIX}`;
      }
      break;
    }

    resultLines.push(line);
    totalLength = nextLength;
  }

  return resultLines.join("\n");
}

// 詳細 HTML からイベント情報を抽出する。
function buildEventFromDetail(detailHtml, detailUrl) {
  const title = extractTitleFromDetail(detailHtml);
  const dateFrom = extractJapaneseDateFromDetail(detailHtml);
  if (!title || !dateFrom || !detailUrl) {
    return null;
  }

  const { open_time: openTime, start_time: startTime, end_time: endTime } = extractTimeFields(detailHtml);
  const price = extractPrice(detailHtml);
  const contact = extractContact(detailHtml);

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

  if (shouldIncludeBody({ openTime, startTime, endTime, price, contact })) {
    const bodyText = extractBodyFallback(detailHtml);
    if (bodyText) {
      event.body = bodyText;
    }
  }

  return event;
}

// source_url をキーに重複排除する。
function dedupeEvents(events) {
  const map = new Map();
  for (const event of events) {
    if (!event || !event.source_url) continue;
    if (!map.has(event.source_url)) {
      map.set(event.source_url, event);
    }
  }
  return Array.from(map.values());
}

// 成功時のみファイルを書き換える。
function saveEventsFile(events) {
  finalizeAndSaveEvents({
    venueId: VENUE_ID,
    venueName: VENUE_NAME,
    outputPath: OUTPUT_PATH,
    events,
  });
}

async function main() {
  let detailFetchSuccess = 0;
  let detailFetchFailed = 0;
  let excludedInvalid = 0;

  try {
    const detailLinks = await fetchAllDetailLinks(ENTRY_URL);
    const detailLinksList = Array.from(detailLinks);

    console.log(`[fetch] list_pages: ${lastListStats.listPages}`);
    console.log(`[fetch] list_links: ${lastListStats.listLinks}`);
    console.log(`[fetch] detail_links_unique: ${detailLinks.size}`);
    console.log(`[fetch] detail_concurrency: ${DETAIL_CONCURRENCY}`);

    // 詳細ページ取得は同時数制限付きで並列処理する。
    // 共通 mapWithConcurrencyLimit を使い、ワーカーループ実装の重複を避ける。
    const detailResults = await mapWithConcurrencyLimit(
      detailLinksList,
      DETAIL_CONCURRENCY,
      async (detailUrl) => {
        let normalizedUrl = "";
        try {
          normalizedUrl = new URL(detailUrl).toString();
        } catch (error) {
          excludedInvalid += 1;
          return null;
        }

        // 取得前に小さな待機を挟み、アクセス集中を避ける。
        await sleep(Math.random() * DETAIL_JITTER_MS);

        try {
          const detailHtml = await fetchText(normalizedUrl, {
            acceptEncoding: "identity",
            encoding: "utf-8",
            // 個別実装の retry/backoff ではなく共通実装に寄せる。
            retryCount: DETAIL_FETCH_RETRY_COUNT,
            retryBaseDelayMs: DETAIL_FETCH_RETRY_BASE_DELAY_MS,
          });
          detailFetchSuccess += 1;
          const event = buildEventFromDetail(detailHtml, normalizedUrl);
          if (!event) {
            excludedInvalid += 1;
            return null;
          }
          return event;
        } catch (error) {
          detailFetchFailed += 1;
          console.warn(`詳細取得に失敗: ${normalizedUrl} (${error.message})`);
          return null;
        }
      }
    );

    const events = detailResults.filter(Boolean);

    const dedupedEvents = dedupeEvents(events);
    const eventsBuilt = dedupedEvents.length;

    console.log(`[fetch] detail_fetch_success: ${detailFetchSuccess}`);
    console.log(`[fetch] detail_fetch_failed: ${detailFetchFailed}`);
    console.log(`[fetch] excluded_invalid: ${excludedInvalid}`);
    console.log(`[fetch] events_built: ${eventsBuilt}`);
    console.log(`[fetch] output_path: ${OUTPUT_PATH}`);

    if (eventsBuilt === 0) {
      throw new Error("events_built が 0 件のため中断します。");
    }

    saveEventsFile(dedupedEvents);
  } catch (error) {
    handleCliFatalError(error, { prefix: "失敗" });
  }
}

if (require.main === module) {
  main();
}
