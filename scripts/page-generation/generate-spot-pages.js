"use strict";

const fs = require("fs");
const path = require("path");

// サイト全体で同じ表記を使うため、定数で管理する。
const SITE_NAME = "イベントガイド【四国版】";
// canonical / OGP の正規ドメインは event-guide.jp に統一する。
const SITE_ORIGIN = "https://event-guide.jp";
// OGP/Twitterで使う共通画像。ページ個別画像が無い場合の既定値として使う。
const DEFAULT_OG_IMAGE_PATH = "/assets/images/ogp-default.svg";
// OGP画像の代替テキストを共通管理し、SNSカードの文脈を補う。
const DEFAULT_OG_IMAGE_ALT = "イベントガイド【四国版】のサイト共通OGP画像";
// スポット一覧データの入力元。
const SPOTS_PATH = path.join(process.cwd(), "docs", "data", "spots.json");
// スポット詳細ページの出力先ルート。
const SPOT_ROOT_DIR = path.join(process.cwd(), "docs", "spot");
// 施設ごとのイベントJSON。静的HTMLへ要約を埋め込むために参照する。
const EVENTS_DIR = path.join(process.cwd(), "docs", "events");
// フッター年は実行年を使い、年更新漏れを防ぐ。
const CURRENT_YEAR = new Date().getFullYear();
// 施設詳細ページの初期表示に埋め込むイベント件数（多すぎると可読性が落ちるため上限を持たせる）。
const STATIC_EVENT_PREVIEW_LIMIT = 10;
// description が短すぎると検索結果の文脈が伝わりにくいため、最低文字数の目安を設ける。
const MIN_DESCRIPTION_LENGTH = 60;

// HTML 文字列として安全に埋め込むための最小限エスケープ。
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 概要文が未設定でも検索結果に意味が伝わる説明を生成する。
function buildDescription(spot) {
  // 元データの説明文を優先しつつ、短文・途切れ文は補足して品質を底上げする。
  const rawDescription = spot.description && String(spot.description).trim()
    ? String(spot.description).trim()
    : "";
  const area = [spot.prefecture, spot.municipality].filter(Boolean).join(" ");
  const category = spot.category ? `${spot.category}の` : "";
  const prefix = area ? `${area}にある` : "四国にある";
  const fallbackDescription = `${prefix}${category}${spot.name}の施設詳細ページです。開催予定のイベントやアクセス情報を確認できます。`;
  const baseDescription = rawDescription || fallbackDescription;

  // 説明文が「、」や「。」で終わるだけだと未完文になりやすいため、補足文を追加して意味を完結させる。
  const needsSentenceFix = /[、。]$/.test(baseDescription);
  const needsLengthFix = baseDescription.length < MIN_DESCRIPTION_LENGTH;

  if (!needsSentenceFix && !needsLengthFix) {
    return baseDescription;
  }

  // 末尾に空白が残らないよう trim したうえで、SEOとユーザビリティの両方に効く補足を付ける。
  return `${baseDescription.trim()} 公式サイトや開催予定イベント、アクセス情報への導線をこのページでまとめて確認できます。`;
}

// YYYY-MM-DD を人間が読みやすい形式へ整える（失敗時は入力値をそのまま表示）。
function formatDateWithWeekday(dateText) {
  const normalized = String(dateText || "").trim();
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return normalized;

  const dateObj = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const isValid =
    dateObj.getUTCFullYear() === Number(match[1]) &&
    dateObj.getUTCMonth() === Number(match[2]) - 1 &&
    dateObj.getUTCDate() === Number(match[3]);
  if (!isValid) return normalized;

  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  return `${normalized}（${weekdays[dateObj.getUTCDay()]}）`;
}

// 施設イベントを date_from 昇順で並べ、静的プレビュー用に整形する。
function getSortedEventsForSpot(spotId, eventsBySpotId) {
  const events = eventsBySpotId.get(String(spotId)) || [];
  return events
    .slice()
    .sort((a, b) => String(a?.date_from || "").localeCompare(String(b?.date_from || ""), "ja"));
}

// 静的HTMLへ埋め込むイベントカード群を生成する。
function renderStaticEventPreview(spot, eventsBySpotId) {
  const sortedEvents = getSortedEventsForSpot(spot.spot_id, eventsBySpotId);
  const previewEvents = sortedEvents.slice(0, STATIC_EVENT_PREVIEW_LIMIT);

  if (previewEvents.length === 0) {
    return {
      // 0件時でも次の行動が取れるリンクを出し、薄いページ体験を避ける。
      html: `            <p id="spot-events-status" class="spot-events__status">現在公開中のイベント情報はありません。</p>
            <ul id="spot-events-list" class="spot-events__list">
              <li class="spot-event-card">
                <h4 class="spot-event-card__title">最新情報の確認方法</h4>
                <p class="spot-event-card__date">施設公式サイト・日付別ページ・施設一覧をご活用ください。</p>
                <div class="spot-events__fallback-links">
                  <a class="spot-event-card__link" href="/date/">日付からイベントを探す</a>
                  <a class="spot-event-card__link" href="/facility-name/">施設名から探す</a>
                </div>
              </li>
            </ul>`,
      count: 0,
      events: []
    };
  }

  const itemsHtml = previewEvents
    .map((eventItem) => {
      const titleText = eventItem?.title || "イベント名未定";
      const fromText = formatDateWithWeekday(eventItem?.date_from);
      const toText = formatDateWithWeekday(eventItem?.date_to);
      const dateText = fromText && toText && fromText !== toText ? `${fromText}〜${toText}` : (fromText || toText || "日程未定");
      // リンク文言をイベント名ベースにして、文脈が伝わるアンカーテキストへ改善する。
      const linkHtml = eventItem?.source_url
        ? `<a class="spot-event-card__link" href="${escapeHtml(eventItem.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(titleText)}の公式・参考情報を見る</a>`
        : "";

      return `            <li class="spot-event-card">
              <p class="spot-event-card__date">${escapeHtml(dateText)}</p>
              <h4 class="spot-event-card__title">${escapeHtml(titleText)}</h4>
              ${linkHtml}
            </li>`;
    })
    .join("\n");

  return {
    html: `            <p id="spot-events-status" class="spot-events__status">開催予定のイベントを表示しています（初期表示は${STATIC_EVENT_PREVIEW_LIMIT}件まで）。</p>
            <ul id="spot-events-list" class="spot-events__list">
${itemsHtml}
            </ul>`,
    count: previewEvents.length,
    events: previewEvents
  };
}

// 構造化データ（Breadcrumb + Place）を1ブロックで生成する。
function renderStructuredData(spot, canonicalUrl, descriptionText, staticEvents) {
  const areaText = [spot.prefecture, spot.municipality].filter(Boolean).join(" ");
  const structuredData = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "ホーム",
          item: `${SITE_ORIGIN}/`
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "施設詳細",
          item: `${SITE_ORIGIN}/facility-name/`
        },
        {
          "@type": "ListItem",
          position: 3,
          name: spot.name,
          item: canonicalUrl
        }
      ]
    },
    {
      "@context": "https://schema.org",
      "@type": "Place",
      name: spot.name,
      description: descriptionText,
      url: canonicalUrl,
      geo: (typeof spot.lat === "number" && typeof spot.lng === "number")
        ? {
            "@type": "GeoCoordinates",
            latitude: spot.lat,
            longitude: spot.lng
          }
        : undefined,
      address: areaText
        ? {
            "@type": "PostalAddress",
            addressRegion: spot.prefecture || "",
            addressLocality: spot.municipality || ""
          }
        : undefined,
      sameAs: spot.official_url || undefined
    }
  ];

  // 施設ページ内で表示しているイベント一覧を ItemList としても表現し、一覧性を補強する。
  if (staticEvents.length > 0) {
    structuredData.push({
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: `${spot.name}の開催予定イベント`,
      itemListOrder: "https://schema.org/ItemListOrderAscending",
      numberOfItems: staticEvents.length,
      itemListElement: staticEvents.map((eventItem, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: eventItem.title || "イベント",
        url: eventItem.source_url || canonicalUrl
      }))
    });
  }

  // 施設ページでもイベント情報をJSON-LD化し、ページ主題（施設＋開催情報）を検索エンジンへ明示する。
  staticEvents.forEach((eventItem) => {
    if (!eventItem?.date_from || !eventItem?.title) return;
    structuredData.push({
      "@context": "https://schema.org",
      "@type": "Event",
      name: eventItem.title,
      startDate: eventItem.date_from,
      endDate: eventItem.date_to || eventItem.date_from,
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      location: {
        "@type": "Place",
        name: spot.name,
        address: {
          "@type": "PostalAddress",
          addressRegion: spot.prefecture || "",
          addressLocality: spot.municipality || ""
        }
      },
      url: eventItem.source_url || canonicalUrl,
      eventStatus: "https://schema.org/EventScheduled"
    });
  });

  return `  <script type="application/ld+json">\n${JSON.stringify(structuredData, null, 2)}\n  </script>`;
}

// 1スポット分の静的HTMLを生成する。
function renderSpotPage(spot, eventsBySpotId) {
  const spotName = spot.name ? String(spot.name).trim() : "施設詳細";
  const titleText = `${spotName}｜${SITE_NAME}`;
  const descriptionText = buildDescription(spot);
  const canonicalUrl = `${SITE_ORIGIN}/spot/${encodeURIComponent(spot.spot_id)}/`;
  // 初期HTMLにもイベントを埋め込み、JS実行前でも本文情報を読める状態にする。
  const staticPreview = renderStaticEventPreview(spot, eventsBySpotId);
  // canonicalと同じドメイン配下の既定OG画像を使い、SNSシェア表示を安定させる。
  const ogImageUrl = `${SITE_ORIGIN}${DEFAULT_OG_IMAGE_PATH}`;
  // 測定IDは /js/ga4.js 側で一元管理し、このページはpage_view情報のみ渡す。
  const ga4Snippet = `  <script src="../../js/ga4.js"></script>\n  <script>\n    // JS文字列として安全に扱うため、JSON.stringifyの結果をそのまま渡す。\n    window.EventNaviAnalytics && window.EventNaviAnalytics.trackPageView(${JSON.stringify(`/spot/${encodeURIComponent(spot.spot_id)}/`)}, ${JSON.stringify(titleText)});\n  </script>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
${ga4Snippet}
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escapeHtml(titleText)}</title>
  <meta name="description" content="${escapeHtml(descriptionText)}" />
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <meta property="og:type" content="website" />
  <meta property="og:locale" content="ja_JP" />
  <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />
  <meta property="og:title" content="${escapeHtml(titleText)}" />
  <meta property="og:description" content="${escapeHtml(descriptionText)}" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <meta property="og:image" content="${escapeHtml(ogImageUrl)}" />
  <meta property="og:image:alt" content="${escapeHtml(DEFAULT_OG_IMAGE_ALT)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(titleText)}" />
  <meta name="twitter:description" content="${escapeHtml(descriptionText)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImageUrl)}" />
${renderStructuredData(spot, canonicalUrl, descriptionText, staticPreview.events)}
  <link rel="stylesheet" href="../../css/style.css" />
</head>
<body class="spot-page" data-spot-id="${escapeHtml(spot.spot_id)}">
  <a class="skip-link" href="#main-content">本文へスキップ</a>
  <nav class="breadcrumb" aria-label="パンくずリスト">
    <ol class="breadcrumb__list">
      <li class="breadcrumb__item"><a href="/">ホーム</a></li>
      <li class="breadcrumb__item"><a href="/facility-name/">🔍施設名から探す</a></li>
      <li class="breadcrumb__item" aria-current="page"><span>${escapeHtml(spotName)}</span></li>
    </ol>
  </nav>

  <header>
    <h1>${escapeHtml(spotName)}</h1>
  </header>

  <main id="main-content" class="spot-container">
    <section id="spot-error" class="spot-error" hidden>
      <h2 class="spot-error__title">スポットが見つかりません</h2>
      <p class="spot-error__text">URLにスポットIDが含まれていないか、該当データが存在しません。</p>
      <a class="spot-error__link" href="/">トップへ戻る</a>
    </section>

    <article id="spot-content" class="spot-content">
      <div class="spot-content__meta">
        <p id="spot-category" class="spot-category">${spot.category ? `#${escapeHtml(spot.category)}` : ""}</p>
        <p id="spot-area" class="spot-area">${escapeHtml([spot.prefecture, spot.municipality].filter(Boolean).join(" "))}</p>
      </div>
      <h2 id="spot-title" class="spot-title">${escapeHtml(spotName)}</h2>
      <section class="spot-intro">
        <h3 class="spot-intro__title">このスポットについて</h3>
        <p id="spot-intro" class="spot-intro__text">${escapeHtml(descriptionText)}</p>
      </section>

      <section class="spot-events">
        <div class="spot-events__header">
          <h3 class="spot-events__title">開催予定のイベント</h3>
          <p id="spot-events-updated" class="spot-events__updated" hidden></p>
        </div>
        <div id="spot-events-body" class="spot-events__body">
          <div class="spot-events__panel">
            <div id="spot-events-tabs" class="spot-events__tabs" hidden></div>
${staticPreview.html}
            <button id="spot-events-more" class="spot-events__more" type="button" hidden>もっと見る</button>
          </div>
        </div>
      </section>

      <div class="spot-actions">
        <a id="spot-google-link" class="spot-action-btn spot-action-btn--primary" href="${escapeHtml(spot.google_url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(spot.name || "")}`)}" target="_blank" rel="noopener noreferrer">Googleマップで開く</a>
      </div>
    </article>
  </main>

  <noscript>
    <!-- SEOとユーザビリティのため、JS無効時でも施設名と説明を読める最低限情報を出す -->
    <section class="spot-events" aria-label="JavaScript無効時の施設概要">
      <h2 class="spot-events__title">${escapeHtml(spotName)}の概要</h2>
      <p class="spot-error__text">${escapeHtml(descriptionText)}</p>
      <p class="spot-error__text">詳細なイベント一覧はJavaScriptを有効にすると表示できます。</p>
      ${spot.official_url ? `<p><a href="${escapeHtml(spot.official_url)}" target="_blank" rel="noopener noreferrer">公式サイトを見る</a></p>` : ""}
    </section>
  </noscript>

  <nav class="mobile-global-nav" aria-label="スマートフォン用固定ナビゲーション">
    <a class="mobile-global-nav__link" href="/date/">📅日付から探す</a>
    <a class="mobile-global-nav__link" href="/facility/">🗺️エリアから探す</a>
    <a class="mobile-global-nav__link" href="/facility-name/">🔍施設名から探す</a>
  </nav>

  <footer class="trial-footer">
    © ${CURRENT_YEAR} ${SITE_NAME} - 公共施設のイベント情報をお届けします
  </footer>

  <script src="../spot.js"></script>
</body>
</html>
`;
}

// docs/events/*.json を読み込み、venue_id単位でイベント配列を保持する。
function loadEventsBySpotId() {
  const eventMap = new Map();
  if (!fs.existsSync(EVENTS_DIR)) {
    return eventMap;
  }

  const files = fs.readdirSync(EVENTS_DIR).filter((name) => name.endsWith(".json"));
  files.forEach((fileName) => {
    const filePath = path.join(EVENTS_DIR, fileName);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const venueId = String(raw?.venue_id || fileName.replace(/\.json$/, ""));
    const events = Array.isArray(raw?.events) ? raw.events : [];
    eventMap.set(venueId, events);
  });

  return eventMap;
}

function main() {
  if (!fs.existsSync(SPOTS_PATH)) {
    throw new Error(`spots.json が見つかりません: ${SPOTS_PATH}`);
  }

  const spots = JSON.parse(fs.readFileSync(SPOTS_PATH, "utf8"));
  if (!Array.isArray(spots)) {
    throw new Error("spots.json の形式が不正です（配列ではありません）");
  }

  // 施設ページへ静的イベント要約を埋め込むため、先にイベントJSONを読み込む。
  const eventsBySpotId = loadEventsBySpotId();

  // 既存のスポット詳細ディレクトリを一旦削除して、削除済みスポットの残骸を防ぐ。
  const existingEntries = fs.readdirSync(SPOT_ROOT_DIR, { withFileTypes: true });
  existingEntries.forEach((entry) => {
    if (entry.isDirectory()) {
      fs.rmSync(path.join(SPOT_ROOT_DIR, entry.name), { recursive: true, force: true });
    }
  });

  spots.forEach((spot) => {
    if (!spot?.spot_id) {
      console.warn("spot_id が無いデータはスキップします:", spot?.name ?? "(名称不明)");
      return;
    }

    const spotDir = path.join(SPOT_ROOT_DIR, String(spot.spot_id));
    fs.mkdirSync(spotDir, { recursive: true });
    fs.writeFileSync(path.join(spotDir, "index.html"), renderSpotPage(spot, eventsBySpotId), "utf8");
  });

  console.log(`[generate-spot-pages] spots=${spots.length}`);
}

main();
