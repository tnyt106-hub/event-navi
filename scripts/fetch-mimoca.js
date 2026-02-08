// 丸亀市猪熊弦一郎現代美術館 (MIMOCA) の展覧会/イベントを取得し、
// docs/events/mimoca.json に統合保存するスクリプト。
// 使い方: node scripts/fetch-mimoca.js

const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// 共通 HTTP 取得ユーティリティで HTML を取得する。
const { fetchText } = require("./lib/http");
// JSON 保存処理を共通化する。
const { finalizeAndSaveEvents } = require("./lib/fetch_output");
const { handleCliFatalError } = require("./lib/cli_error");
// HTML テキスト処理の共通関数を使う。
const { decodeHtmlEntities, stripTags, stripTagsWithLineBreaks, normalizeWhitespace } = require("./lib/text");
const {
  buildLocalDate,
  formatIsoDateFromLocalDate,
  getJstTodayUtcDate,
} = require("./lib/date");
const {
  buildPastCutoffDate,
  evaluateEventAgainstPastCutoff,
  formatUtcDateToIso,
} = require("./lib/date_window");
const { mapWithConcurrencyLimit, sleep } = require("./lib/concurrency");

const EXHIBITIONS_LIST_URL = "https://www.mimoca.jp/exhibitions/current/";
const EVENTS_LIST_URL = "https://www.mimoca.jp/events/";
const OUTPUT_PATH = path.join(__dirname, "..", "docs", "events", "mimoca.json");
const VENUE_ID = "mimoca";
const DETAIL_CONCURRENCY = 3;
const DETAIL_JITTER_MS = 300;

// 改行を残しながら各行の余分な空白を削除する。
function normalizeWhitespacePreservingLineBreaks(text) {
  return text
    .split(/\n|\r/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line)
    .join("\n");
}

// 全角数字を半角に変換する。
function normalizeNumbers(text) {
  return text.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

// YYYY-MM-DD 文字列を返す。
function formatDate(date) {
  // 日付整形は共通関数に寄せて、施設間で表記揺れが出ないようにする。
  return formatIsoDateFromLocalDate(date);
}

// 年月日が妥当な日付かチェックする。
function buildDate(year, month, day) {
  // 不正日付を弾くロジックを共通化して、重複実装をなくす。
  return buildLocalDate(year, month, day);
}

// JST の日付文字列 (YYYY-MM-DD) を返す。
// 期間共通モジュールの JST 基準日を使って、日付表現を統一する。
function buildJstDateString() {
  return formatUtcDateToIso(getJstTodayUtcDate());
}

// 一覧 HTML から href を抽出する。
function extractHrefList(html) {
  const links = [];
  const regex = /href=["']([^"']+)["']/gi;
  let match = null;
  while ((match = regex.exec(html)) !== null) {
    links.push(match[1]);
  }
  return links;
}

// 展覧会一覧の詳細 URL を抽出する。
function extractExhibitionDetailUrls(html) {
  const hrefs = extractHrefList(html);
  const result = new Set();
  const samplePathnames = [];
  let invalidAbsCount = 0;

  hrefs.forEach((href) => {
    // href の形式が相対/絶対どちらでも正しく処理できるよう、必ず絶対 URL に変換する。
    let absUrl = "";
    try {
      absUrl = new URL(href, EXHIBITIONS_LIST_URL).toString();
    } catch (error) {
      invalidAbsCount += 1;
      return;
    }

    // pathname のみでフィルタ判断し、クエリやハッシュの違いに影響されないようにする。
    const pathname = new URL(absUrl).pathname;
    if (!pathname.startsWith("/exhibitions/")) return;
    if (/^\/exhibitions\/(current|upcoming|past)\/?$/.test(pathname)) return;
    if (/^\/exhibitions\/20\d{2}\/?$/.test(pathname)) return;
    if (/\/feed\/?$/.test(pathname)) return;
    if (!/^\/exhibitions\/[^/]+\/?$/.test(pathname)) return;

    if (samplePathnames.length < 3) {
      samplePathnames.push(pathname);
    }

    result.add(absUrl);
  });

  return {
    urls: Array.from(result),
    totalHrefCount: hrefs.length,
    invalidAbsCount,
    samplePathnames,
  };
}

// イベント一覧の詳細 URL を抽出する。
function extractEventDetailUrls(html) {
  const hrefs = extractHrefList(html);
  const result = new Set();
  const samplePathnames = [];
  let invalidAbsCount = 0;

  hrefs.forEach((href) => {
    // href を絶対 URL に変換して、pathname 判定を安定させる。
    let absUrl = "";
    try {
      absUrl = new URL(href, EVENTS_LIST_URL).toString();
    } catch (error) {
      invalidAbsCount += 1;
      return;
    }

    // pathname だけを使って条件を判定する。
    const pathname = new URL(absUrl).pathname;
    if (!pathname.startsWith("/events/")) return;
    if (/^\/events\/?$/.test(pathname)) return;
    if (/^\/events\/\d{4}\/?$/.test(pathname)) return;
    if (/\/feed\/?$/.test(pathname)) return;
    if (!/^\/events\/[^/]+\/?$/.test(pathname)) return;

    if (samplePathnames.length < 3) {
      samplePathnames.push(pathname);
    }

    result.add(absUrl);
  });

  return {
    urls: Array.from(result),
    totalHrefCount: hrefs.length,
    invalidAbsCount,
    samplePathnames,
  };
}

// 詳細ページの代表見出しからタイトルを抽出する。
function extractTitle(html) {
  const headingRegex = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  let mainTitle = "";
  let match = null;
  while ((match = headingRegex.exec(html)) !== null) {
    const text = normalizeWhitespace(decodeHtmlEntities(stripTags(match[1])));
    if (text) {
      mainTitle = text;
      break;
    }
  }

  if (!mainTitle) return "";

  // サブタイトルらしき要素を追加する。
  const subtitleMatch = html.match(
    /<h[2-3][^>]*(class=["'][^"']*(sub|subtitle)[^"']*["'])[^>]*>([\s\S]*?)<\/h[2-3]>/i
  );
  if (subtitleMatch) {
    const subtitle = normalizeWhitespace(decodeHtmlEntities(stripTags(subtitleMatch[3])));
    if (subtitle && subtitle !== mainTitle) {
      return `${mainTitle} ${subtitle}`;
    }
  }

  return mainTitle;
}

// ラベル近傍の HTML 断片を抽出する。
function extractScopedTextFragment(html, keywords, windowChars) {
  if (!html || keywords.length === 0) return "";
  // まず HTML を改行ありのプレーンテキストに変換し、タグ断片をなくす。
  const textWithLineBreaks = stripTagsWithLineBreaks(html);
  const textWithoutTags = stripTags(textWithLineBreaks);
  const decodedText = decodeHtmlEntities(textWithoutTags);
  const normalizedText = normalizeWhitespacePreservingLineBreaks(decodedText);

  // 最初に出現したキーワード位置を見つけ、周辺の断片だけを返す。
  let firstIndex = -1;
  keywords.forEach((keyword) => {
    const index = normalizedText.indexOf(keyword);
    if (index !== -1 && (firstIndex === -1 || index < firstIndex)) {
      firstIndex = index;
    }
  });

  if (firstIndex === -1) {
    return "";
  }

  // キーワード前後の断片だけを対象にすることで無関係日付やノイズの混入を避ける。
  const start = Math.max(0, firstIndex - windowChars);
  const end = Math.min(normalizedText.length, firstIndex + windowChars);
  return normalizedText.slice(start, end);
}

// テキストから日付リストを抽出する。
function extractDatesFromText(text) {
  const normalizedText = normalizeNumbers(text);
  const dates = [];

  for (const match of normalizedText.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = buildDate(year, month, day);
    if (date) {
      dates.push(date);
    }
  }

  return dates;
}

// 断片から日付レンジを抽出する。
function extractDateRangeFromFragment(fragmentText) {
  if (!fragmentText) return null;
  const dates = extractDatesFromText(fragmentText);
  if (dates.length === 0) return null;
  dates.sort((a, b) => a - b);
  return {
    dateFrom: formatDate(dates[0]),
    dateTo: formatDate(dates[dates.length - 1]),
    dateCount: dates.length,
  };
}

// 詳細ページの本文から日付を抽出する。
function extractDateRange(html, options) {
  // 対象ラベル近傍の断片を優先し、必要時のみ全体抽出にフォールバックする。
  const { labels, fallbackLabels, scopeRadius, fallbackMaxDates, allowFallback, minDates } = options;
  // minDates が未指定のときは 1 件以上を必須とする。
  const requiredMinDates = Number.isInteger(minDates) ? minDates : 1;
  // allowFallback が明示 false ならフォールバックしない。
  const isFallbackAllowed = allowFallback !== false;
  const scopedFragmentPrimary = extractScopedTextFragment(html, labels, scopeRadius);
  const scopedFragmentFallback =
    !scopedFragmentPrimary && fallbackLabels
      ? extractScopedTextFragment(html, fallbackLabels, scopeRadius)
      : "";
  const scopedFragment = scopedFragmentPrimary || scopedFragmentFallback;
  const scopedResult = extractDateRangeFromFragment(scopedFragment);
  const scopedDateCount = scopedResult ? scopedResult.dateCount : 0;

  // 断片から得られた日付件数が必要数を満たす場合のみ採用する。
  if (scopedResult && scopedDateCount >= requiredMinDates) {
    return {
      dateFrom: scopedResult.dateFrom,
      dateTo: scopedResult.dateTo,
      usedScoped: true,
      hasDate: true,
      scopeFound: Boolean(scopedFragment),
      fallbackTooMany: false,
      scopedDateCount,
      fallbackDateCount: 0,
    };
  }

  // 断片のみで完結させたい場合はここで終了する。
  if (!isFallbackAllowed) {
    return {
      dateFrom: "",
      dateTo: "",
      usedScoped: true,
      hasDate: false,
      scopeFound: Boolean(scopedFragment),
      fallbackTooMany: false,
      scopedDateCount,
      fallbackDateCount: 0,
    };
  }

  // 断片で日付が取れない場合のみ全体抽出を行う。
  const fallbackText = normalizeWhitespacePreservingLineBreaks(
    decodeHtmlEntities(stripTags(stripTagsWithLineBreaks(html)))
  );
  const fallbackDates = extractDatesFromText(fallbackText);
  const fallbackDateCount = fallbackDates.length;
  if (fallbackDates.length === 0) {
    return {
      dateFrom: "",
      dateTo: "",
      usedScoped: false,
      hasDate: false,
      scopeFound: Boolean(scopedFragment),
      fallbackTooMany: false,
      scopedDateCount,
      fallbackDateCount,
    };
  }

  // 全体抽出で日付が多すぎる場合は誤抽出の可能性が高いので除外する。
  if (fallbackDates.length >= fallbackMaxDates) {
    return {
      dateFrom: "",
      dateTo: "",
      usedScoped: false,
      hasDate: false,
      scopeFound: Boolean(scopedFragment),
      fallbackTooMany: true,
      scopedDateCount,
      fallbackDateCount,
    };
  }

  fallbackDates.sort((a, b) => a - b);
  return {
    dateFrom: formatDate(fallbackDates[0]),
    dateTo: formatDate(fallbackDates[fallbackDates.length - 1]),
    usedScoped: false,
    hasDate: true,
    scopeFound: Boolean(scopedFragment),
    fallbackTooMany: false,
    scopedDateCount,
    fallbackDateCount,
  };
}

// 時刻レンジ (HH:MM-HH:MM) を抽出する。
function extractTimeRange(html) {
  const text = normalizeNumbers(stripTags(html));
  const normalized = text.replace(/[−―ー－〜～]/g, "-");
  const match = normalized.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  if (!match) return null;
  return {
    start: match[1],
    end: match[2],
  };
}

// HTML を改行単位の配列に変換する。
function buildTextLinesFromText(text) {
  return normalizeWhitespacePreservingLineBreaks(text)
    .split(/\n|\r/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line);
}

// 見出し語だけかどうかを判定する。
function isHeadingOnly(line, keywords) {
  const normalizedLine = line.replace(/[：:\s]/g, "");
  return keywords.some((keyword) => normalizedLine === keyword.replace(/[：:\s]/g, ""));
}

// 料金行を抽出する。
function extractPriceLine(html) {
  const keywords = ["料金", "観覧料", "入館料", "参加費"];
  // 料金ラベル近傍のテキスト断片だけを対象にし、UI ノイズを避ける。
  const scopedText = extractScopedTextFragment(html, keywords, 2000);
  if (!scopedText) return "";
  const lines = buildTextLinesFromText(scopedText);
  // 価格らしい文字列だけを採用する（円/無料が含まれる行）。
  const pricePattern = /(円|無料)/;
  const forbiddenPattern = /(Language|▲|\.jpg|\.png)/i;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isHeadingOnly(line, keywords)) continue;
    if (forbiddenPattern.test(line)) continue;
    if (line.includes("年") && line.includes("月") && line.includes("日")) continue;
    if (!pricePattern.test(line)) continue;
    return line;
  }

  return "";
}

// 連絡先行を抽出する。
function extractContactLine(html) {
  const keywords = ["お問い合わせ", "TEL", "電話"];
  // 連絡先ラベル近傍のテキスト断片だけを対象にし、UI ノイズを避ける。
  const scopedText = extractScopedTextFragment(html, keywords, 2000);
  if (!scopedText) return "";
  const lines = buildTextLinesFromText(scopedText);
  const phoneCandidates = [];
  const phonePattern = /(TEL|Tel|電話)?[:：]?\s*\d{2,4}-\d{2,4}-\d{3,4}/i;
  // UI 文言や装飾記号を含む行は連絡先として採用しない。
  const forbiddenPattern = /(Language|▲)/;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (forbiddenPattern.test(line)) {
      continue;
    }

    if (isHeadingOnly(line, keywords)) {
      continue;
    }

    // 電話番号を含む行のみ採用する。
    if (phonePattern.test(line)) {
      phoneCandidates.push(line);
    }
  }

  if (phoneCandidates.length > 0) {
    return phoneCandidates[0];
  }

  return "";
}

// contact のノイズを除去する（Language ▲ なら null）
function sanitizeContact(raw) {
  if (raw == null) return null;
  const text = String(raw).replace(/\s+/g, " ").trim();
  if (!text) return null;

  // 要件：Language▲系は null にする
  if (text.includes("Language") || text.includes("▲")) return null;

  return text;
}


// 詳細ページからイベント情報を組み立てる。
function buildEventFromDetail(detailUrl, html, dateOptions) {
  const title = extractTitle(html);
  if (!title) {
    return {
      eventItem: null,
      invalidReason: "no_title",
      usedScoped: false,
      dateDebug: null,
    };
  }

  const dateRange = extractDateRange(html, dateOptions);
  if (!dateRange.hasDate) {
    // 断片のみで抽出しているため、日付が取れない場合は無効扱いにする。
    let invalidReason = "no_date_scoped";
    if (dateRange.fallbackTooMany) {
      invalidReason = "too_many_dates";
    }
    return {
      eventItem: null,
      invalidReason,
      usedScoped: dateRange.usedScoped,
      dateDebug: {
        scopedDateCount: dateRange.scopedDateCount,
        fallbackDateCount: dateRange.fallbackDateCount,
        fallbackTooMany: dateRange.fallbackTooMany,
      },
    };
  }

  const eventItem = {
    title,
    date_from: dateRange.dateFrom,
    date_to: dateRange.dateTo,
    source_url: detailUrl,
  };

  const timeRange = extractTimeRange(html);
  if (timeRange) {
    eventItem.open_time = timeRange.start;
    eventItem.start_time = null;
    eventItem.end_time = timeRange.end;
  }

  const priceLine = extractPriceLine(html);
  if (priceLine) {
    eventItem.price = priceLine;
  }

  const contactLine = extractContactLine(html);
  // 重要：nullでも代入して、既存JSONの "Language ▲" を確実に上書きする
  eventItem.contact = sanitizeContact(contactLine);


  return {
    eventItem,
    invalidReason: "",
    usedScoped: dateRange.usedScoped,
    dateDebug: {
      scopedDateCount: dateRange.scopedDateCount,
      fallbackDateCount: dateRange.fallbackDateCount,
      fallbackTooMany: dateRange.fallbackTooMany,
    },
  };
}

// 既存 JSON を読み込む。
function loadExistingData() {
  if (!fs.existsSync(OUTPUT_PATH)) {
    return { venue_id: VENUE_ID, last_success_at: null, events: [] };
  }

  const raw = fs.readFileSync(OUTPUT_PATH, "utf8");
  try {
    const parsed = JSON.parse(raw);
    const events = Array.isArray(parsed.events) ? parsed.events : [];
    const filteredEvents = events.filter((eventItem) => {
      // MIMOCA 以外のドメインや URL 不在は混入防止のため除外する。
      if (!eventItem || !eventItem.source_url) {
        return false;
      }
      try {
        const url = new URL(eventItem.source_url);
        return url.host === "www.mimoca.jp";
      } catch (error) {
        return false;
      }
    });

    return {
      venue_id: parsed.venue_id || VENUE_ID,
      last_success_at: parsed.last_success_at || null,
      events: filteredEvents,
    };
  } catch (error) {
    return { venue_id: VENUE_ID, last_success_at: null, events: [] };
  }
}

// 重複キー用の文字列を作る。
function buildEventKey(eventItem) {
  // source_url がある場合は URL を優先キーにして誤レコードの重複を防ぐ。
  if (eventItem.source_url) {
    return eventItem.source_url;
  }
  return `${eventItem.title}__${eventItem.date_from}__${eventItem.date_to}`;
}

// 既存イベントと新規イベントをマージする。
function mergeEvents(existingEvents, newEvents) {
  const merged = new Map();

  existingEvents.forEach((eventItem) => {
    const key = buildEventKey(eventItem);
    merged.set(key, { ...eventItem });
  });

  newEvents.forEach((eventItem) => {
    const key = buildEventKey(eventItem);
    if (!merged.has(key)) {
      merged.set(key, { ...eventItem });
      return;
    }

    const existing = merged.get(key);
    const updated = { ...existing, ...eventItem };

    if (existing.tags && !eventItem.tags) {
      updated.tags = existing.tags;
    }

    merged.set(key, updated);
  });

  return Array.from(merged.values());
}

// 同一キーの重複を除去する。
function dedupeEvents(events) {
  const result = [];
  const seen = new Set();

  events.forEach((eventItem) => {
    const key = buildEventKey(eventItem);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(eventItem);
  });

  return result;
}

async function fetchDetails(urls, label, dateOptions) {
  const results = [];
  let successCount = 0;
  let failedCount = 0;
  let excludedInvalidCount = 0;
  const invalidSamples = [];
  let usedScopedCount = 0;
  let usedFallbackCount = 0;
  const dateCountSamples = [];

  // 詳細ページは同時数を制限して並列取得し、先方負荷を抑えつつ実行時間を短縮する。
  const detailResults = await mapWithConcurrencyLimit(urls, DETAIL_CONCURRENCY, async (url) => {
    // リクエストの瞬間集中を避けるため、取得前に小さなジッターを入れる。
    await sleep(Math.floor(Math.random() * DETAIL_JITTER_MS));

    try {
      const html = await fetchText(url, {
        acceptEncoding: "identity",
        encoding: "utf-8",
        debugLabel: "mimoca-detail",
      });
      const parsed = buildEventFromDetail(url, html, dateOptions);
      return { url, ok: true, ...parsed };
    } catch (error) {
      return { url, ok: false, error };
    }
  });

  detailResults.forEach((result) => {
    if (!result.ok) {
      failedCount += 1;
      if (invalidSamples.length < 3) {
        const errorMessage = result.error instanceof Error ? result.error.message : String(result.error);
        invalidSamples.push({ url: result.url, reason: `fetch_failed:${errorMessage}` });
      }
      return;
    }

    const { eventItem, invalidReason, usedScoped, dateDebug } = result;
    if (dateDebug && dateCountSamples.length < 3) {
      dateCountSamples.push({ url: result.url, scopedDateCount: dateDebug.scopedDateCount });
    }
    if (!eventItem) {
      excludedInvalidCount += 1;
      if (invalidSamples.length < 3) {
        invalidSamples.push({ url: result.url, reason: invalidReason || "unknown" });
      }
      return;
    }

    results.push(eventItem);
    successCount += 1;
    if (usedScoped) {
      usedScopedCount += 1;
    } else {
      usedFallbackCount += 1;
    }
  });

  console.log(`${label}_detail_concurrency: ${DETAIL_CONCURRENCY}`);
  console.log(`${label}_date_scope_used_scoped: ${usedScopedCount}`);
  console.log(`${label}_date_scope_used_fallback: ${usedFallbackCount}`);
  dateCountSamples.forEach((sample) => {
    console.log(`[date_scoped_count] label=${label} scoped_count=${sample.scopedDateCount} url=${sample.url}`);
  });
  invalidSamples.forEach((sample) => {
    console.log(`[invalid] reason=${sample.reason} url=${sample.url}`);
  });
  console.log(`${label}_detail_fetch_success: ${successCount}`);
  console.log(`${label}_detail_fetch_failed: ${failedCount}`);

  return { events: results, excludedInvalidCount };
}


async function main() {
  const existingData = loadExistingData();
  let excludedInvalidCount = 0;

  const exhibitionsHtml = await fetchText(EXHIBITIONS_LIST_URL, {
    acceptEncoding: "identity",
    encoding: "utf-8",
    debugLabel: "mimoca-exhibitions",
  });
  const exhibitionHrefResult = extractExhibitionDetailUrls(exhibitionsHtml);
  const exhibitionUrls = exhibitionHrefResult.urls;
  console.log(`exhibitions_list_href_total: ${exhibitionHrefResult.totalHrefCount}`);
  console.log(`exhibitions_list_links: ${exhibitionUrls.length}`);
  // 絶対 URL 化に失敗した件数と、採用された pathname のサンプルを短く出力する。
  console.log(`exhibitions_abs_url_invalid: ${exhibitionHrefResult.invalidAbsCount}`);
  console.log(
    `exhibitions_pathname_samples: ${
      exhibitionHrefResult.samplePathnames.length > 0
        ? exhibitionHrefResult.samplePathnames.join(", ")
        : "none"
    }`
  );

  const exhibitionResult = await fetchDetails(exhibitionUrls, "exhibitions", {
    // 展覧会は「会期」近傍の断片のみで日付を抽出する。
    labels: ["会期"],
    scopeRadius: 2000,
    fallbackMaxDates: 10,
    allowFallback: false,
    // 展覧会は会期の開始・終了が揃っている場合のみ採用する。
    minDates: 2,
  });
  const exhibitionEvents = exhibitionResult.events;
  excludedInvalidCount += exhibitionResult.excludedInvalidCount;

  const eventsHtml = await fetchText(EVENTS_LIST_URL, {
    acceptEncoding: "identity",
    encoding: "utf-8",
    debugLabel: "mimoca-events",
  });
  const eventHrefResult = extractEventDetailUrls(eventsHtml);
  const eventUrls = eventHrefResult.urls;
  console.log(`events_list_href_total: ${eventHrefResult.totalHrefCount}`);
  console.log(`events_list_links: ${eventUrls.length}`);
  // 絶対 URL 化に失敗した件数と、採用された pathname のサンプルを短く出力する。
  console.log(`events_abs_url_invalid: ${eventHrefResult.invalidAbsCount}`);
  console.log(
    `events_pathname_samples: ${
      eventHrefResult.samplePathnames.length > 0 ? eventHrefResult.samplePathnames.join(", ") : "none"
    }`
  );

  const eventResult = await fetchDetails(eventUrls, "events", {
    // イベントは日時/開催日などのラベル近傍の断片のみで日付を抽出する。
    labels: ["日時", "開催日", "日程"],
    scopeRadius: 2500,
    fallbackMaxDates: 10,
    allowFallback: false,
    // イベントは 1 件でも日時が取れれば採用する。
    minDates: 1,
  });
  const eventEvents = eventResult.events;
  excludedInvalidCount += eventResult.excludedInvalidCount;

  const collectedEvents = dedupeEvents([...exhibitionEvents, ...eventEvents]);
  // 過去365日フィルタの閾値は共通モジュールで計算する。
  const cutoffDate = buildPastCutoffDate();
  let filteredOldCount = 0;

  const filteredEvents = collectedEvents.filter((eventItem) => {
    // 既存仕様維持: date_to 欠損イベントは残す。
    const evaluation = evaluateEventAgainstPastCutoff(eventItem, cutoffDate, {
      fallbackToDateFrom: false,
      keepOnMissingDate: true,
      keepOnInvalidDate: false,
    });
    if (!evaluation.keep && evaluation.reason === "expired") {
      filteredOldCount += 1;
    }
    return evaluation.keep;
  });

  console.log(`filtered_old_count: ${filteredOldCount}`);
  console.log(`excluded_invalid_count: ${excludedInvalidCount}`);

  const dedupedTotal = filteredEvents.length;
  console.log(`deduped_total: ${dedupedTotal}`);

  if (dedupedTotal === 0) {
    handleCliFatalError(new Error("deduped_total が 0 件のため中断します。"), { prefix: "[ERROR]" });
    return;
  }

  const mergedEvents = mergeEvents(existingData.events || [], filteredEvents);
  finalizeAndSaveEvents({
    venueId: existingData.venue_id || VENUE_ID,
    outputPath: OUTPUT_PATH,
    events: mergedEvents,
    lastSuccessAt: buildJstDateString(),
  });
}

main().catch((error) => {
  handleCliFatalError(error, { prefix: "[ERROR] スクリプト実行中に失敗しました。" });
});
