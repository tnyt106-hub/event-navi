// 愛媛県県民文化会館（kenbun.jp）のイベント一覧から
// 一覧ページ→詳細ページの2段階でイベント情報を取得して保存するバッチ。
// 使い方: node scripts/fetch-kenbun.js

const path = require("path");
const { URL } = require("url");

// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("./lib/http");
// JSON 保存処理を共通化する。
const { writeJsonPretty } = require("./lib/io");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities, normalizeWhitespace, stripTagsWithLineBreaks } = require("./lib/text");

const VENUE_ID = "kenbun";
const VENUE_NAME = "愛媛県県民文化会館";
const ENTRY_URL = "https://www.kenbun.jp/event/";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "kenbun.json");
// 月別一覧は3年分程度を上限にガードする。
const MAX_LIST_PAGES = 36;
// 過去・未来の対象日数は 1 年分に制限する。
const PAST_DAYS_LIMIT = 365;
const FUTURE_DAYS_LIMIT = 365;
// body の最大長は既存方針に合わせる。
const MAX_BODY_LENGTH = 5000;
const BODY_TRUNCATION_SUFFIX = "…";
// JST の日付を作るためのオフセット。
const JST_OFFSET_HOURS = 9;
// 詳細ページ取得の同時実行数（負荷が高ければ 2 に下げられる）。
const DETAIL_CONCURRENCY = 3;
// 詳細取得の再試行回数（初回失敗後に最大 2 回まで）。
const DETAIL_RETRY = 2;
// 再試行時のベース待機時間（指数バックオフの基準）。
const DETAIL_RETRY_BASE_DELAY_MS = 500;
// 連続アクセスを避けるためのジッター。
const DETAIL_JITTER_MS = 200;

let lastListStats = { listPages: 0, listLinks: 0 };

// JST の日付文字列 (YYYY-MM-DD) を返す。
function buildJstDateString() {
  const now = new Date();
  const jstNow = new Date(now.getTime() + JST_OFFSET_HOURS * 60 * 60 * 1000);
  const year = jstNow.getUTCFullYear();
  const month = String(jstNow.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jstNow.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// JST 基準で "今日 00:00" を作る（Date.now + 9h 方式）。
function buildTodayJst() {
  const now = new Date();
  const jstNow = new Date(now.getTime() + JST_OFFSET_HOURS * 60 * 60 * 1000);
  return new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate()));
}

// 指定ミリ秒だけ待機する。
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// リトライ対象かどうかを HTTP ステータスから判定する。
function shouldRetryDetailFetch(error) {
  if (!error || !error.message) {
    return true;
  }
  const match = error.message.match(/HTTP\s+(\d+)/);
  if (!match) {
    return true;
  }
  const statusCode = Number(match[1]);
  return statusCode === 429 || (statusCode >= 500 && statusCode < 600);
}

// 詳細取得のリトライ付きラッパー。
async function fetchTextWithRetry(url) {
  for (let attempt = 0; attempt <= DETAIL_RETRY; attempt += 1) {
    try {
      return await fetchText(url, { acceptEncoding: "identity", encoding: "utf-8" });
    } catch (error) {
      if (attempt >= DETAIL_RETRY || !shouldRetryDetailFetch(error)) {
        throw error;
      }
      const delayMs = DETAIL_RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * DETAIL_JITTER_MS;
      console.warn(`[warn] detail retry ${attempt + 1}/${DETAIL_RETRY} (${url}): ${error.message}`);
      await sleep(delayMs);
    }
  }
  return "";
}

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

// 全角数字とコロンを半角へ正規化する。
function normalizeFullWidth(text) {
  if (!text) return "";
  return text
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ":")
    .replace(/[‐‑‒–—―ー]/g, "-");
}

// YYYY年M月D日 形式を ISO に変換する。
function toIsoDate(year, month, day) {
  const yyyy = String(year);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// HTML から行単位のテキストを作る（改行を保ったまま整形）。
function extractTextLines(html) {
  const withLineBreaks = stripTagsWithLineBreaks(html);
  const decoded = decodeHtmlEntities(withLineBreaks);
  return decoded
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0);
}

// ラベル行から値を抽出する（例: "開催日：2024年2月3日"）。
function extractLabeledValue(lines, label) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes(label)) {
      continue;
    }

    const match = line.match(new RegExp(`${label}\\s*[:：]?\\s*(.+)`));
    if (match && match[1]) {
      return match[1].trim();
    }

    if (line === label && lines[i + 1]) {
      return lines[i + 1].trim();
    }
  }

  return "";
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
  const queue = [];
  const detailLinks = new Set();
  let listLinks = 0;
  const todayJst = buildTodayJst();
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
      if (!visitedListUrls.has(absUrl)) {
        queue.push(absUrl);
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
      if (!visitedListUrls.has(absUrl)) {
        queue.push(absUrl);
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
  const lines = extractTextLines(html);
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
  const lines = extractTextLines(html);
  const dateText = extractLabeledValue(lines, "開催日");
  const candidateText = dateText || lines.join(" ");
  const normalized = normalizeFullWidth(candidateText);
  const match = normalized.match(/([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日/);
  if (!match) return null;
  return toIsoDate(match[1], match[2], match[3]);
}

// 詳細ページから開場・開演・終演時刻を抽出する。
function extractTimeFields(html) {
  const lines = extractTextLines(html);
  const joined = normalizeFullWidth(lines.join(" "));

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
  const lines = extractTextLines(html);
  const value = extractLabeledValue(lines, "入場料など") || extractLabeledValue(lines, "入場料");
  return value || null;
}

// 詳細ページから連絡先 (TEL) を抽出する。
function extractContact(html) {
  const lines = extractTextLines(html);
  const phonePattern = /\d{2,4}-\d{2,4}-\d{3,4}/;

  for (const line of lines) {
    const normalized = normalizeFullWidth(line);
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
  const data = {
    venue_id: VENUE_ID,
    venue_name: VENUE_NAME,
    last_success_at: buildJstDateString(),
    events,
  };

  writeJsonPretty(OUTPUT_PATH, data);
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

    const events = [];
    let currentIndex = 0;
    const totalLinks = detailLinksList.length;

    // 共有インデックスから次の URL を取り出す。
    const pickNextDetailUrl = () => {
      if (currentIndex >= totalLinks) {
        return null;
      }
      const url = detailLinksList[currentIndex];
      currentIndex += 1;
      return url;
    };

    // 詳細ページ取得は同時数制限付きで並列処理する。
    const worker = async (workerId) => {
      for (;;) {
        const detailUrl = pickNextDetailUrl();
        if (!detailUrl) {
          break;
        }

        let normalizedUrl = "";
        try {
          normalizedUrl = new URL(detailUrl).toString();
        } catch (error) {
          excludedInvalid += 1;
          continue;
        }

        // 取得前に小さな待機を挟み、アクセス集中を避ける。
        await sleep(Math.random() * DETAIL_JITTER_MS);

        try {
          const detailHtml = await fetchTextWithRetry(normalizedUrl);
          detailFetchSuccess += 1;
          const event = buildEventFromDetail(detailHtml, normalizedUrl);
          if (!event) {
            excludedInvalid += 1;
            continue;
          }
          events.push(event);
        } catch (error) {
          detailFetchFailed += 1;
          console.warn(`詳細取得に失敗: ${normalizedUrl} (${error.message})`);
        } finally {
          // 取得後にもジッターを入れて連続アクセスを緩和する。
          await sleep(Math.random() * DETAIL_JITTER_MS);
        }
      }
    };

    // 指定された同時数だけワーカーを起動する。
    const workers = Array.from({ length: DETAIL_CONCURRENCY }, (_, index) => worker(index));
    await Promise.all(workers);

    const dedupedEvents = dedupeEvents(events);
    const eventsBuilt = dedupedEvents.length;

    console.log(`[fetch] detail_fetch_success: ${detailFetchSuccess}`);
    console.log(`[fetch] detail_fetch_failed: ${detailFetchFailed}`);
    console.log(`[fetch] excluded_invalid: ${excludedInvalid}`);
    console.log(`[fetch] events_built: ${eventsBuilt}`);
    console.log(`[fetch] output_path: ${OUTPUT_PATH}`);

    if (eventsBuilt === 0) {
      process.exit(1);
    }

    saveEventsFile(dedupedEvents);
  } catch (error) {
    console.error(`失敗: ${error.message}`);
    process.exit(1);
  }
}

main();
