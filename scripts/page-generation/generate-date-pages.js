"use strict";

const fs = require("fs");
const path = require("path");

// 出力対象のサイト名（title と h1 に使用）
const SITE_NAME = "イベントガイド【四国版】";
// Google Analytics 4 の測定ID（トップページと同じIDを日付ページにも適用する）
const GA4_MEASUREMENT_ID = "G-RS12737WLG";
// 年が省略された日付の補完は、実行日の月から数ヶ月先までに限定する
const YEARLESS_LOOKAHEAD_MONTHS = 6;
// canonical/OGで使う公開URLの基点。ドメイン変更時はここだけ直せばよい。
const SITE_ORIGIN = "https://event-navi.jp";
// 長文本文を「その他」表示で省略する際の最大文字数。
// 数値を1か所に集約しておくと、将来調整時に置換漏れを防げる。
const OTHER_BODY_MAX_LENGTH = 300;
// date_from/date_to の許容日数上限。
// 安全対策の閾値を定数化し、条件式と警告文の整合性を保ちやすくする。
const MAX_DATE_RANGE_DAYS = 365;
// 日付加算・差分計算で使う「1日」のミリ秒。
// 複数箇所で同じ式を再利用するため、マジックナンバーを排除する。
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// フッター年は実行年を使い、年更新漏れを防ぐ。
const CURRENT_YEAR = new Date().getFullYear();

// 入力ディレクトリは既定で docs/events を参照し、引数で上書きできるようにする
// 例: node scripts/page-generation/generate-date-pages.js dist/json
const INPUT_DIR = process.argv[2]
  ? path.join(process.cwd(), process.argv[2])
  : path.join(process.cwd(), "docs", "events");
// GitHub Pages は docs/ 配下を公開する前提のため、出力先も docs/date にする
const OUTPUT_DIR = path.join(process.cwd(), "docs", "date");
const SPOTS_DATA_PATH = path.join(process.cwd(), "docs", "data", "spots.json");
// 広告枠の HTML は partial を差し込む方式で管理し、後から編集しやすくする
const DATE_AD_PARTIAL_PATH = path.join(process.cwd(), "docs", "partials", "date-ad.html");
// トップページの更新対象は docs/index.html に固定する
const INDEX_HTML_PATH = path.join(process.cwd(), "docs", "index.html");
// 日付導線セクションの置換範囲を明確にするための固定マーカー
const DATE_NAV_START_MARKER = "<!-- DATE_NAV_START -->";
const DATE_NAV_END_MARKER = "<!-- DATE_NAV_END -->";

// 0埋め2桁の数値文字列を作成する
function pad2(value) {
  return String(value).padStart(2, "0");
}

// UTC の Date を YYYY-MM-DD の文字列に変換する
function formatDateKey(dateObj) {
  return `${dateObj.getUTCFullYear()}-${pad2(dateObj.getUTCMonth() + 1)}-${pad2(dateObj.getUTCDate())}`;
}

// UTC の Date から曜日ラベル（日〜土）を取得する
function getWeekdayLabelFromUtcDate(dateObj) {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  return weekdays[dateObj.getUTCDay()];
}

// 日本語の見出し用に YYYY年MM月DD日（曜）を作成する
function formatJapaneseDate(dateObj) {
  const weekdayLabel = getWeekdayLabelFromUtcDate(dateObj);
  return `${dateObj.getUTCFullYear()}年${pad2(dateObj.getUTCMonth() + 1)}月${pad2(dateObj.getUTCDate())}日（${weekdayLabel}）`;
}

// UTC の Date を見出し用の MM/DD（曜）表記に変換する
function formatMonthDayLabel(dateObj) {
  const weekdayLabel = getWeekdayLabelFromUtcDate(dateObj);
  return `${pad2(dateObj.getUTCMonth() + 1)}/${pad2(dateObj.getUTCDate())}（${weekdayLabel}）`;
}

// YYYY-MM-DD に曜日（例: 2025-01-01（水））を付与して表示する
// ※同名関数の二重定義があると後勝ち上書きで意図しない差分が出るため、定義は1つだけに保つ。
function formatDateWithWeekday(dateText) {
  const match = String(dateText).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    // 想定外フォーマットはそのまま返し、表示崩れを防ぐ
    return String(dateText);
  }

  const dateObj = buildUtcDate(Number(match[1]), Number(match[2]), Number(match[3]));
  if (!dateObj) {
    // 不正な日付（例: 2025-02-30）は変換せずに返す
    return String(dateText);
  }

  const weekdayLabel = getWeekdayLabelFromUtcDate(dateObj);
  return `${dateText}（${weekdayLabel}）`;
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

// HTML に埋め込む文字列を安全にするため、危険な記号をエスケープする
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 空文字・null・undefined をまとめて「空」と判定する。
// URLクエリ比較用にテキストを正規化する（前後空白と連続空白を揃える）。
function normalizeEventQueryText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isBlank(value) {
  if (value == null) return true;
  return String(value).trim().length === 0;
}

// イベントカードで扱う構造化項目が存在するかどうかを判定する。
function hasStructuredDetails(eventItem) {
  const structuredFields = ["open_time", "start_time", "end_time", "price", "contact"];
  return structuredFields.some((field) => !isBlank(eventItem?.[field]));
}

// body を「その他」で表示する際の文面を整える（長文は先頭300文字程度で省略する）。
function buildOtherBodyText(bodyText) {
  if (isBlank(bodyText)) return "";
  const normalized = String(bodyText).replace(/\s+/g, " ").trim();
  if (normalized.length > OTHER_BODY_MAX_LENGTH) {
    return `${normalized.slice(0, OTHER_BODY_MAX_LENGTH)}…`;
  }
  return normalized;
}

// 構造化済みの詳細情報（時刻・料金・問い合わせ）を HTML の一覧に変換する。
function renderStructuredDetails(eventItem) {
  // 各項目を表示ラベルつきで定義し、並び順をここで固定する。
  const detailRows = [
    { label: "開場", value: eventItem?.open_time },
    { label: "開始", value: eventItem?.start_time },
    { label: "終了", value: eventItem?.end_time },
    { label: "料金", value: eventItem?.price },
    { label: "問い合わせ", value: eventItem?.contact }
  ].filter((row) => !isBlank(row.value));

  if (detailRows.length === 0) {
    return "";
  }

  const detailItemsHtml = detailRows
    .map((row) => `      <li>${escapeHtml(row.label)}: ${escapeHtml(row.value)}</li>`)
    .join("\n");

  return `    <ul class="spot-event-card__details">\n${detailItemsHtml}\n    </ul>\n`;
}

// date_from と date_to の差が大きすぎる場合は安全のため丸める
function normalizeDateRange(dateFromObj, dateToObj, venueId, index) {
  const diffDays = Math.floor((dateToObj.getTime() - dateFromObj.getTime()) / ONE_DAY_MS);

  if (diffDays > MAX_DATE_RANGE_DAYS) {
    console.warn(
      `期間が${MAX_DATE_RANGE_DAYS}日超のため date_to を date_from に丸めました:`,
      venueId,
      "#",
      index,
      "from",
      formatDateKey(dateFromObj),
      "to",
      formatDateKey(dateToObj)
    );
    return dateFromObj;
  }

  return dateToObj;
}

// HTML の先頭部分を生成する（パンくずをヘッダーより前に置けるように分離）。
function renderHeader(titleText, headingText, cssPath, isNoindex, descriptionText = "", canonicalPath = "", preHeaderHtml = "") {
  const safeTitle = escapeHtml(titleText);
  const safeHeading = escapeHtml(headingText);
  // noindex 指定が必要なページだけ robots メタタグを挿入する
  // <title> の直前に独立行として入れることでテンプレを読みやすくする
  const noindexMeta = isNoindex ? '  <meta name="robots" content="noindex,follow" />\n' : "";
  const safeDescription = descriptionText ? escapeHtml(descriptionText) : "";
  const canonicalUrl = canonicalPath ? `${SITE_ORIGIN}${canonicalPath}` : "";
  const canonicalHtml = canonicalUrl ? `  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />\n` : "";
  const descriptionHtml = safeDescription ? `  <meta name="description" content="${safeDescription}" />\n` : "";
  const ogHtml = (safeDescription && canonicalUrl)
    ? `  <meta property="og:type" content="website" />\n  <meta property="og:locale" content="ja_JP" />\n  <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />\n  <meta property="og:title" content="${safeTitle}" />\n  <meta property="og:description" content="${safeDescription}" />\n  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />\n  <meta name="twitter:card" content="summary" />\n`
    : "";
  // 日付ページでもアクセス計測できるよう、GA4タグをヘッダーに埋め込む。
  // なお page_view は手動制御を維持するため send_page_view を false にしておく。
  const ga4Snippet = `  <!-- Google Analytics 4 の計測タグ（日付ページ向け） -->\n  <script async src="https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}"></script>\n  <script>\n    window.dataLayer = window.dataLayer || [];\n    function gtag(){dataLayer.push(arguments);}\n    gtag('js', new Date());\n    gtag('config', '${GA4_MEASUREMENT_ID}', { send_page_view: false });\n  </script>\n`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
${ga4Snippet}  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
${noindexMeta}${descriptionHtml}${canonicalHtml}${ogHtml}  <title>${safeTitle}</title>
  <link rel="stylesheet" href="${cssPath}" />
</head>
<body>
${preHeaderHtml}
  <header>
    <h1>${safeHeading}</h1>
  </header>
  <main>
`;
}

// パンくずリストのHTMLを生成する。
// items は [{ label: "表示名", href: "リンク先(任意)" }] の配列を受け取り、
// 最後の要素（現在ページ）は自動的に非リンクとして出力する。
function renderBreadcrumbs(items) {
  const breadcrumbItems = items.map((item, index) => {
    const safeLabel = escapeHtml(item.label);
    const isCurrentPage = index === items.length - 1;

    if (isCurrentPage || !item.href) {
      return `      <li class="breadcrumb__item" aria-current="page"><span>${safeLabel}</span></li>`;
    }

    return `      <li class="breadcrumb__item"><a href="${escapeHtml(item.href)}">${safeLabel}</a></li>`;
  }).join("\n");

  return `  <nav class="breadcrumb" aria-label="パンくずリスト">
    <ol class="breadcrumb__list">
${breadcrumbItems}
    </ol>
  </nav>
`;
}

// HTML のフッター部分を生成する
function renderFooter() {
  return `  </main>
  <!-- スマホ共通の固定導線: ページを問わず主要3導線へ遷移しやすくする -->
  <nav class="mobile-global-nav" aria-label="スマートフォン用固定ナビゲーション">
    <a class="mobile-global-nav__link" href="/date/">📅日付から探す</a>
    <a class="mobile-global-nav__link" href="/facility/">🗺️エリアから探す</a>
    <a class="mobile-global-nav__link" href="/facility-name/">🔍施設名から探す</a>
  </nav>
  <footer class="trial-footer">
    © ${CURRENT_YEAR} ${SITE_NAME} - 公共施設イベント情報を正確に届けるアーカイブサイト
  </footer>
</body>
</html>
`;
}

// トップページに差し込む日付導線セクションを HTML 文字列として組み立てる
function renderDateNavSection(primaryLinks, weekLinks) {
  const lines = [];
  lines.push("    <!-- 日付別ページへの静的導線（自動生成） -->");
  lines.push('    <p style="margin: 8px 12px 4px; font-size: 12px; font-weight: bold; color: var(--accent);">');
  lines.push("      <strong>📅日付から探す</strong>");
  lines.push("    </p>");
  lines.push('    <section class="spot-actions" aria-label="日付別イベントへのクイックリンク" style="margin: 0 12px 12px;">');
  primaryLinks.forEach((linkItem) => {
    lines.push(
      `      <a class="${escapeHtml(linkItem.className)}" href="${escapeHtml(linkItem.href)}">${escapeHtml(linkItem.label)}</a>`
    );
  });
  if (weekLinks.length > 0) {
    lines.push("      <!-- 今週7日分のリンク（UTC基準） -->");
    weekLinks.forEach((linkItem) => {
      lines.push(
        `      <a class="${escapeHtml(linkItem.className)}" href="${escapeHtml(linkItem.href)}">${escapeHtml(linkItem.label)}</a>`
      );
    });
  }
  lines.push('      <a class="spot-action-btn" href="date/">日付一覧</a>');
  lines.push("    </section>");
  return lines.join("\n");
}

// トップページの固定マーカー範囲を置換して日付導線を更新する
function updateIndexDateNav(todayUtc, availableDateKeys) {
  if (!fs.existsSync(INDEX_HTML_PATH)) {
    console.warn("トップページが見つからないため日付導線は更新しません:", INDEX_HTML_PATH);
    return false;
  }

  const indexHtml = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  const markerRegex = new RegExp(
    `${DATE_NAV_START_MARKER}[\\s\\S]*?${DATE_NAV_END_MARKER}`,
    "m"
  );

  if (!markerRegex.test(indexHtml)) {
    console.warn("日付導線のマーカーが見つからないため更新をスキップします。");
    return false;
  }

  const primaryLinks = [];

  // イベントが存在する日付だけに絞り、0件日のリンクを生成しないようにする
  const todayKey = formatDateKey(todayUtc);
  if (availableDateKeys.has(todayKey)) {
    primaryLinks.push({
      label: "今日",
      href: `date/${todayKey}/`,
      className: "spot-action-btn spot-action-btn--primary",
    });
  }

  const tomorrowUtc = new Date(todayUtc.getTime() + ONE_DAY_MS);
  const tomorrowKey = formatDateKey(tomorrowUtc);
  if (availableDateKeys.has(tomorrowKey)) {
    primaryLinks.push({
      label: "明日",
      href: `date/${tomorrowKey}/`,
      className: "spot-action-btn",
    });
  }

  const weekLinks = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const dateObj = new Date(todayUtc.getTime() + ONE_DAY_MS * offset);
    const dateKey = formatDateKey(dateObj);
    // 0件日は除外し、実在する日付ページだけを表示する
    if (!availableDateKeys.has(dateKey)) {
      continue;
    }
    weekLinks.push({
      label: formatMonthDayLabel(dateObj),
      href: `date/${dateKey}/`,
      className: "spot-action-btn",
    });
  }

  const navHtml = renderDateNavSection(primaryLinks, weekLinks);
  const markerIndent = "    ";
  const replacement = `${markerIndent}${DATE_NAV_START_MARKER}\n${navHtml}\n${markerIndent}${DATE_NAV_END_MARKER}`;
  const updatedHtml = indexHtml.replace(markerRegex, replacement);

  return writeFileIfChanged(INDEX_HTML_PATH, updatedHtml);
}

// 広告 partial を読み込み、存在しない場合は空文字で返して処理を継続する
function loadDateAdPartial() {
  if (!fs.existsSync(DATE_AD_PARTIAL_PATH)) {
    console.warn("date-ad.html が見つからないため広告枠は出力しません:", DATE_AD_PARTIAL_PATH);
    return "";
  }

  try {
    return fs.readFileSync(DATE_AD_PARTIAL_PATH, "utf8");
  } catch (error) {
    console.warn("date-ad.html の読み込みに失敗したため広告枠は出力しません:", error);
    return "";
  }
}

// 旧テンプレート（ad-card）を検出した場合は、広告スニペット本体だけを取り出す。
// 生成済みHTML側を直接触らず、生成スクリプト側で見た目移行を完結させるための互換処理。
function extractAdEmbedHtml(adHtml) {
  if (!adHtml) return "";

  const normalized = String(adHtml).trim();
  if (!normalized) return "";

  // ad-card の場合はラベル等を除外し、配信タグ（a/img + 1px計測）だけを残す。
  if (normalized.includes('class="ad-card"')) {
    const embedParts = [];
    const bannerLinkMatch = normalized.match(/<a[^>]*class="ad-card__link"[\s\S]*?<\/a>/i);
    const pixelMatch = normalized.match(/<img[^>]*class="ad-card__pixel"[^>]*>/i);

    if (bannerLinkMatch) {
      embedParts.push(bannerLinkMatch[0]);
    }
    if (pixelMatch) {
      embedParts.push(pixelMatch[0]);
    }

    if (embedParts.length > 0) {
      return embedParts.join("\n");
    }
  }

  return normalized;
}

// 広告枠の差し込み位置を一元管理し、HTMLの編集場所を明確にする
function renderAdSection(adHtml, positionLabel) {
  if (!adHtml) return "";
  const safePositionLabel = escapeHtml(positionLabel);
  const embedHtml = extractAdEmbedHtml(adHtml);

  if (!embedHtml) return "";

  return `  <section class="date-ad" data-ad-position="${safePositionLabel}">
    <div class="date-ad__embed" role="complementary" aria-label="スポンサーリンク">
${embedHtml}
    </div>
  </section>
`;
}

// イベントカードの HTML を生成する
function renderEventCard(eventItem, venueLabel) {
  const titleText = eventItem.title || "イベント名未定";
  const safeVenueLabel = venueLabel || "会場未定";
  const eventQueryText = normalizeEventQueryText(titleText);
  const venueQueryText = normalizeEventQueryText(safeVenueLabel);
  // 日付表示は曜日付きにして、日取りを直感的に把握しやすくする
  const dateFromText = formatDateWithWeekday(eventItem.date_from);
  const dateToText = formatDateWithWeekday(eventItem.date_to);
  const dateText = eventItem.date_from === eventItem.date_to
    ? dateFromText
    : `${dateFromText}〜${dateToText}`;
  // 構造化済みの詳細情報（開始/終了時刻など）がある場合は優先表示する。
  const structuredDetailsHtml = renderStructuredDetails(eventItem);
  // 構造化項目が取れない場合のみ、本文を「その他」として表示する。
  const otherBodyText = buildOtherBodyText(eventItem?.body);
  const showOther = otherBodyText && !hasStructuredDetails(eventItem);
  const otherHtml = showOther
    ? `    <ul class="spot-event-card__details">
      <li>その他: ${escapeHtml(otherBodyText)}</li>
    </ul>
`
    : "";

  const linkHtml = eventItem.source_url
    ? `    <a class="spot-event-card__link" href="${escapeHtml(eventItem.source_url)}" target="_blank" rel="noopener noreferrer">公式・参考リンク</a>`
    : "";

  return `  <li class="spot-event-card" data-event-name="${escapeHtml(eventQueryText)}" data-event-venue="${escapeHtml(venueQueryText)}">
    <p class="spot-event-card__date">${escapeHtml(dateText)}</p>
    <h2 class="spot-event-card__title">${escapeHtml(titleText)}</h2>
    <p class="spot-event-card__venue">会場: ${escapeHtml(safeVenueLabel)}</p>
${otherHtml}
${structuredDetailsHtml}
${linkHtml}
  </li>
`;
}

// 日付ページの本文を生成する
function renderDayPage(dateObj, events, prevDateKey, nextDateKey, isNoindex, adHtml) {
  const navLinks = [];
  if (prevDateKey) {
    // docs 配信前提で docs/date/YYYY-MM-DD/ から相対リンクにする
    navLinks.push(`<a class="spot-action-btn" href="../${prevDateKey}/">前日</a>`);
  }
  if (nextDateKey) {
    // docs 配信前提で docs/date/YYYY-MM-DD/ から相対リンクにする
    navLinks.push(`<a class="spot-action-btn" href="../${nextDateKey}/">翌日</a>`);
  }

  const navHtml = navLinks.length
    ? `  <nav class="spot-actions" aria-label="日付ナビゲーション">
    ${navLinks.join("\n    ")}
  </nav>
`
    : "";

  const eventCards = events.map((eventItem) => renderEventCard(eventItem, eventItem.venue_label)).join("");
  const dateText = formatJapaneseDate(dateObj);
  const breadcrumbHtml = renderBreadcrumbs([
    { label: "ホーム", href: "../../index.html" },
    { label: "日付一覧", href: "../" },
    { label: dateText }
  ]);
  // 広告は「パンくず直下」に固定し、静的ページ全体で配置ルールを統一する。
  const topAdHtml = renderAdSection(adHtml, "top");
  // preHeaderHtml に連結することで、パンくずのすぐ下へ広告を差し込む。
  const preHeaderHtml = `${breadcrumbHtml}${topAdHtml}`;
  // 下部広告は必要になった時だけ有効化できるようにトグルを用意する
  const includeBottomAd = false;
  const bottomAdHtml = includeBottomAd ? renderAdSection(adHtml, "bottom") : "";

  return (
    // docs 配信前提で docs/date/YYYY-MM-DD/index.html は ../../css/style.css を参照する
    // ユーザビリティ向上のため、パンくずはヘッダーより先に配置する。
    renderHeader(`${dateText}のイベント一覧｜${SITE_NAME}`, `${dateText}`, "../../css/style.css", isNoindex, "", "", preHeaderHtml)
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
${bottomAdHtml}
  <script src="../../js/date-page.js"></script>
`
    + renderFooter()
  );
}

// 日付一覧ページを生成する
function renderDateIndexPage(dateEntries, adHtml) {
  // Step1方針: 一覧ページ名は「📅日付から探す」に統一し、検索意図と一致させる
  const titleText = `📅日付から探す｜${SITE_NAME}`;
  const headingText = "📅日付から探す";
  // H1とH2を同名にすると読み上げ時の重複感が出るため、一覧セクションは別ラベルにする
  const listSectionTitle = "開催日一覧";
  const breadcrumbHtml = renderBreadcrumbs([
    { label: "ホーム", href: "../index.html" },
    { label: headingText }
  ]);
  // 一覧ページも同様に、パンくずの直後へ広告を配置する。
  const preHeaderHtml = `${breadcrumbHtml}${renderAdSection(adHtml, "index")}`;

  const items = dateEntries.map((entry) => {
    const dateKey = formatDateKey(entry.date);
    const dateLabel = formatJapaneseDate(entry.date);
    const countText = `${entry.events.length}件`;
    // 日付一覧のサマリは date_from_obj → title で安定ソートしてから抽出する
    const sortedEvents = entry.events
      // 安定ソートを保証するため、元の並び順インデックスも保持する
      .map((eventItem, sortIndex) => ({ eventItem, sortIndex }))
      .sort((a, b) => {
        const diff = a.eventItem.date_from_obj.getTime() - b.eventItem.date_from_obj.getTime();
        if (diff !== 0) return diff;
        const titleDiff = a.eventItem.title.localeCompare(b.eventItem.title, "ja");
        if (titleDiff !== 0) return titleDiff;
        return a.sortIndex - b.sortIndex;
      })
      .map(({ eventItem }) => eventItem);
    // 日付ごとの先頭3件だけイベント名と会場名を軽量に表示する
    const summaryItems = sortedEvents.slice(0, 3).map((eventItem) => {
      const titleText = eventItem.title || "イベント名未定";
      const venueText = eventItem.venue_label || eventItem.venue_id || "会場未定";
      return `        <li>${escapeHtml(titleText)}（${escapeHtml(venueText)}）</li>`;
    }).join("\n");
    const summaryHtml = summaryItems
      ? `\n      <ul class="date-index__summary">\n${summaryItems}\n      </ul>`
      : "";
    return `    <li class="date-index__item"><a href="./${dateKey}/">${escapeHtml(dateLabel)}（${escapeHtml(countText)}）</a>${summaryHtml}</li>`;
  }).join("\n");

  return (
    // docs 配信前提で docs/date/index.html は ../css/style.css を参照する
    // ユーザビリティ向上のため、パンくずはヘッダーより先に配置する。
    renderHeader(
      titleText,
      headingText,
      "../css/style.css",
      false,
      "四国で開催されるイベントを日付別に一覧で確認できるページです。日程ごとの件数と代表イベントから詳細ページへ進めます。",
      "/date/",
      preHeaderHtml
    )
    + `  <section class="spot-events" aria-labelledby="events-title">
    <div class="spot-events__header">
      <h2 id="events-title" class="spot-events__title">${escapeHtml(listSectionTitle)}</h2>
    </div>
    <div class="spot-events__body">
      <div class="spot-events__panel">
        <ul class="date-index__list">
${items}
        </ul>
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

// スポットIDから会場名を引けるように辞書化する
function loadSpotNameMap() {
  const spotNameMap = new Map();

  try {
    const raw = fs.readFileSync(SPOTS_DATA_PATH, "utf8");
    const spots = JSON.parse(raw);

    if (Array.isArray(spots)) {
      spots.forEach((spot) => {
        const spotId = spot?.spot_id ? String(spot.spot_id) : "";
        const spotName = spot?.name ? String(spot.name) : "";
        if (spotId && spotName) {
          spotNameMap.set(spotId, spotName);
        }
      });
    }
  } catch (error) {
    console.warn("spots.json の読み込みに失敗したため、会場名はIDで代替します:", error);
  }

  return spotNameMap;
}

// JSON を読み込み、イベントを日付ごとに集約する
function collectEventsByDate(spotNameMap) {
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
    // 会場名が見つからない場合は venue_id をそのまま使う
    const venueLabel = spotNameMap.get(venueId) || venueId;
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

      // 期間が長すぎる場合は date_to を date_from に丸めて安全に処理する
      const safeDateToObj = normalizeDateRange(dateFromObj, dateToObj, venueId, index);

      const normalizedEvent = {
        venue_id: venueId,
        venue_label: venueLabel,
        title: eventItem?.title ? String(eventItem.title) : "イベント名未定",
        date_from: formatDateKey(dateFromObj),
        date_to: formatDateKey(safeDateToObj),
        source_url: eventItem?.source_url ? String(eventItem.source_url) : "",
        open_time: eventItem?.open_time ?? null,
        start_time: eventItem?.start_time ?? null,
        end_time: eventItem?.end_time ?? null,
        price: eventItem?.price ?? null,
        contact: eventItem?.contact ?? null,
        body: typeof eventItem?.body === "string" ? eventItem.body : null,
        date_from_obj: dateFromObj,
      };

      // date_from 〜 date_to の範囲を1日ずつ展開する
      const dateEntries = expandDateRange(dateFromObj, safeDateToObj);
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
  const spotNameMap = loadSpotNameMap();
  const dateMap = collectEventsByDate(spotNameMap);
  const dateAdHtml = loadDateAdPartial();
  const dates = Array.from(dateMap.values())
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  // 今日のUTC日付を基準に publish / index window を計算する
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const publishStart = new Date(todayUtc.getTime() - 365 * ONE_DAY_MS);
  const publishEnd = new Date(todayUtc.getTime() + 365 * ONE_DAY_MS);
  const indexStart = new Date(todayUtc.getTime() - 180 * ONE_DAY_MS);

  // publish window 外の日付は生成対象から除外する
  const publishDates = dates.filter((entry) => entry.date >= publishStart && entry.date <= publishEnd);
  // トップページではイベント0件日を表示しないため、存在する日付だけを集合化する
  const availableDateKeys = new Set(publishDates.map((entry) => formatDateKey(entry.date)));

  let writtenCount = 0;

  publishDates.forEach((entry, index) => {
    const prevEntry = index > 0 ? publishDates[index - 1] : null;
    const nextEntry = index < publishDates.length - 1 ? publishDates[index + 1] : null;

    // 日付ごとにイベントを安定した順序で並べる
    entry.events.sort((a, b) => {
      const diff = a.date_from_obj.getTime() - b.date_from_obj.getTime();
      if (diff !== 0) return diff;
      return a.title.localeCompare(b.title, "ja");
    });

    const dateKey = formatDateKey(entry.date);
    const prevKey = prevEntry ? formatDateKey(prevEntry.date) : null;
    const nextKey = nextEntry ? formatDateKey(nextEntry.date) : null;
    // publishEnd と indexEnd は同値のため、noindex 判定は indexStart のみで行う
    const isNoindex = entry.date < indexStart;

    const html = renderDayPage(entry.date, entry.events, prevKey, nextKey, isNoindex, dateAdHtml);
    const outputPath = path.join(OUTPUT_DIR, dateKey, "index.html");

    if (writeFileIfChanged(outputPath, html)) {
      writtenCount += 1;
    }
  });

// 日付一覧ページは今日以降の直近60日分を対象にする
  const todayKey = formatDateKey(todayUtc);
  const recentDates = publishDates
    .filter(entry => formatDateKey(entry.date) >= todayKey)
    .slice(0, 90);

  if (recentDates.length > 0) {
    const indexHtml = renderDateIndexPage(recentDates, dateAdHtml);
    const indexPath = path.join(OUTPUT_DIR, "index.html");
    if (writeFileIfChanged(indexPath, indexHtml)) {
      writtenCount += 1;
    }
  }

  // トップページの日付導線を publish window に合わせて更新する
  if (updateIndexDateNav(todayUtc, availableDateKeys)) {
    writtenCount += 1;
  }

  console.log("日付ページ生成完了:", writtenCount, "件更新");
}

// 実行エントリーポイント
generatePages();
