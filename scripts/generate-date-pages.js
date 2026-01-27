"use strict";

const fs = require("fs");
const path = require("path");

// 出力対象のサイト名（title と h1 に使用）
const SITE_NAME = "イベントナビ【四国版】";
// 年が省略された日付の補完は、実行日の月から数ヶ月先までに限定する
const YEARLESS_LOOKAHEAD_MONTHS = 6;

const INPUT_DIR = path.join(process.cwd(), "dist", "json");
const OUTPUT_DIR = path.join(process.cwd(), "dist", "date");

// 0埋め2桁の数値文字列を作成する
function pad2(value) {
  return String(value).padStart(2, "0");
}

// UTC の Date を YYYY-MM-DD の文字列に変換する
function formatDateKey(dateObj) {
  return `${dateObj.getUTCFullYear()}-${pad2(dateObj.getUTCMonth() + 1)}-${pad2(dateObj.getUTCDate())}`;
}

// 日本語の見出し用に YYYY年MM月DD日 を作成する
function formatJapaneseDate(dateObj) {
  return `${dateObj.getUTCFullYear()}年${pad2(dateObj.getUTCMonth() + 1)}月${pad2(dateObj.getUTCDate())}日`;
}

// UTC の Date を安全に生成し、月日が正しいか検証する
function buildUtcDate(year, month, day) {
  const dateObj = new Date(Date.UTC(year, month - 1, day));
  if (
    dateObj.getUTCFullYear() !== year ||
    dateObj.getUTCMonth() + 1 !== month ||
    dateObj.getUTCDate() !== day
  ) {
    return null;
  }
  return dateObj;
}

// 実行日の月を起点に、補完可能な範囲を UTC で算出する
function getYearlessWindow(now) {
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const end = new Date(Date.UTC(now.getFullYear(), now.getMonth() + YEARLESS_LOOKAHEAD_MONTHS + 1, 0));
  return { start, end };
}

// 日付文字列を UTC の Date に変換する（不確実な形式は null）
function parseDateText(dateText, now) {
  if (!dateText) return null;
  const normalized = String(dateText).trim();
  if (!normalized) return null;

  // YYYY-MM-DD または YYYY/MM/DD 形式を優先的に処理する
  const fullMatch = normalized.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (fullMatch) {
    const year = Number(fullMatch[1]);
    const month = Number(fullMatch[2]);
    const day = Number(fullMatch[3]);
    return buildUtcDate(year, month, day);
  }

  // 年省略（MM-DD または MM/DD）は補完条件を満たす場合のみ採用する
  const shortMatch = normalized.match(/^(\d{1,2})[\/-](\d{1,2})$/);
  if (shortMatch) {
    const month = Number(shortMatch[1]);
    const day = Number(shortMatch[2]);
    const { start, end } = getYearlessWindow(now);
    const candidateYears = [now.getFullYear(), now.getFullYear() + 1];

    const candidates = candidateYears
      .map((year) => buildUtcDate(year, month, day))
      .filter(Boolean)
      .filter((dateObj) => dateObj >= start && dateObj <= end);

    if (candidates.length === 1) {
      return candidates[0];
    }

    // 補完できない場合は不確実と判断して null を返す
    return null;
  }

  return null;
}

// UTC の Date を1日ずつ増やし、範囲内のすべての日付を配列で返す
function expandDateRange(startDate, endDate) {
  const dates = [];
  const cursor = new Date(startDate.getTime());

  while (cursor <= endDate) {
    dates.push(new Date(cursor.getTime()));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

// HTML のヘッダー部分を生成する
function renderHeader(dateObj) {
  const dateText = formatJapaneseDate(dateObj);
  const titleText = `${dateText}のイベント一覧｜${SITE_NAME}`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${titleText}</title>
  <link rel="stylesheet" href="/css/style.css" />
</head>
<body>
  <header>
    <h1>${dateText}のイベント</h1>
  </header>
  <main>
`;
}

// HTML のフッター部分を生成する
function renderFooter() {
  return `  </main>
  <footer class="trial-footer">
    © 2026 ${SITE_NAME} - 公共施設イベント情報を正確に届けるアーカイブサイト
  </footer>
</body>
</html>
`;
}

// イベントカードの HTML を生成する
function renderEventCard(eventItem) {
  const titleText = eventItem.title || "イベント名未定";
  const dateText = eventItem.date_from === eventItem.date_to
    ? eventItem.date_from
    : `${eventItem.date_from}〜${eventItem.date_to}`;

  const linkHtml = eventItem.source_url
    ? `    <a class="spot-event-card__link" href="${eventItem.source_url}" target="_blank" rel="noopener noreferrer">公式・参考リンク</a>`
    : "";

  return `  <li class="spot-event-card">
    <p class="spot-event-card__date">${dateText}</p>
    <h2 class="spot-event-card__title">${titleText}</h2>
${linkHtml}
  </li>
`;
}

// 日付ページの本文を生成する
function renderDayPage(dateObj, events, prevDateKey, nextDateKey) {
  const navLinks = [];
  if (prevDateKey) {
    navLinks.push(`<a class="spot-action-btn" href="/date/${prevDateKey}/">前日</a>`);
  }
  if (nextDateKey) {
    navLinks.push(`<a class="spot-action-btn" href="/date/${nextDateKey}/">翌日</a>`);
  }

  const navHtml = navLinks.length
    ? `  <nav class="spot-actions" aria-label="日付ナビゲーション">
    ${navLinks.join("\n    ")}
  </nav>
`
    : "";

  const eventCards = events.map((eventItem) => renderEventCard(eventItem)).join("");

  return (
    renderHeader(dateObj)
    + navHtml
    + `  <section class="spot-events" aria-labelledby="events-title">
    <div class="spot-events__header">
      <h2 id="events-title" class="spot-events__title">イベント一覧</h2>
    </div>
    <div class="spot-events__body">
      <div class="spot-events__panel">
        <ul class="spot-events__list">
${eventCards}        </ul>
      </div>
    </div>
  </section>
`
    + renderFooter()
  );
}

// 既存ファイルと内容が同一なら書き込まない
function writeFileIfChanged(filePath, content) {
  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, "utf8");
    if (current === content) {
      return false;
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

// JSON を読み込み、イベントを日付ごとに集約する
function collectEventsByDate() {
  const now = new Date();
  const dateMap = new Map();

  let files = [];
  try {
    files = fs.readdirSync(INPUT_DIR).filter((fileName) => fileName.endsWith(".json"));
  } catch (error) {
    console.error("入力ディレクトリの読み込みに失敗しました:", INPUT_DIR, error);
    return dateMap;
  }

  files.forEach((fileName) => {
    const filePath = path.join(INPUT_DIR, fileName);
    let jsonData;

    try {
      const raw = fs.readFileSync(filePath, "utf8");
      jsonData = JSON.parse(raw);
    } catch (error) {
      console.error("JSONの読み込みに失敗したためスキップします:", fileName, error);
      return;
    }

    const venueId = jsonData.venue_id || fileName.replace(/\.json$/, "");
    const events = Array.isArray(jsonData.events) ? jsonData.events : [];

    events.forEach((eventItem, index) => {
      const dateFromObj = parseDateText(eventItem?.date_from, now);
      const dateToObj = parseDateText(eventItem?.date_to, now) || dateFromObj;

      if (!dateFromObj || !dateToObj) {
        console.warn(
          "日付が不確実なためイベントをスキップしました:",
          venueId,
          "#",
          index
        );
        return;
      }

      if (dateFromObj > dateToObj) {
        console.warn(
          "date_from > date_to のためイベントをスキップしました:",
          venueId,
          "#",
          index
        );
        return;
      }

      const normalizedEvent = {
        venue_id: venueId,
        title: eventItem?.title ? String(eventItem.title) : "イベント名未定",
        date_from: formatDateKey(dateFromObj),
        date_to: formatDateKey(dateToObj),
        source_url: eventItem?.source_url ? String(eventItem.source_url) : "",
        date_from_obj: dateFromObj,
      };

      // date_from 〜 date_to の範囲を1日ずつ展開する
      const dateEntries = expandDateRange(dateFromObj, dateToObj);
      dateEntries.forEach((dateObj) => {
        const key = formatDateKey(dateObj);
        if (!dateMap.has(key)) {
          dateMap.set(key, { date: dateObj, events: [] });
        }
        dateMap.get(key).events.push(normalizedEvent);
      });
    });
  });

  return dateMap;
}

// 日付ごとのページを生成して保存する
function generatePages() {
  const dateMap = collectEventsByDate();
  const dates = Array.from(dateMap.values())
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  let writtenCount = 0;

  dates.forEach((entry, index) => {
    const prevEntry = index > 0 ? dates[index - 1] : null;
    const nextEntry = index < dates.length - 1 ? dates[index + 1] : null;

    // 日付ごとにイベントを安定した順序で並べる
    entry.events.sort((a, b) => {
      const diff = a.date_from_obj.getTime() - b.date_from_obj.getTime();
      if (diff !== 0) return diff;
      return a.title.localeCompare(b.title, "ja");
    });

    const dateKey = formatDateKey(entry.date);
    const prevKey = prevEntry ? formatDateKey(prevEntry.date) : null;
    const nextKey = nextEntry ? formatDateKey(nextEntry.date) : null;

    const html = renderDayPage(entry.date, entry.events, prevKey, nextKey);
    const outputPath = path.join(OUTPUT_DIR, dateKey, "index.html");

    if (writeFileIfChanged(outputPath, html)) {
      writtenCount += 1;
    }
  });

  console.log("日付ページ生成完了:", writtenCount, "件更新");
}

// 実行エントリーポイント
generatePages();
