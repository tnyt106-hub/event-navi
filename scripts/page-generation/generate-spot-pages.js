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
// スポット詳細ページでも計測条件を揃えるため、GA4測定IDを定数化する。
const GA4_MEASUREMENT_ID = "G-RS12737WLG";
// スポット一覧データの入力元。
const SPOTS_PATH = path.join(process.cwd(), "docs", "data", "spots.json");
// スポット詳細ページの出力先ルート。
const SPOT_ROOT_DIR = path.join(process.cwd(), "docs", "spot");
// フッター年は実行年を使い、年更新漏れを防ぐ。
const CURRENT_YEAR = new Date().getFullYear();

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
  if (spot.description && String(spot.description).trim()) {
    return String(spot.description).trim();
  }

  const area = [spot.prefecture, spot.municipality].filter(Boolean).join(" ");
  const category = spot.category ? `${spot.category}の` : "";
  const prefix = area ? `${area}にある` : "四国にある";
  return `${prefix}${category}${spot.name}の施設詳細ページです。開催予定のイベントやアクセス情報を確認できます。`;
}

// 構造化データ（Breadcrumb + Place）を1ブロックで生成する。
function renderStructuredData(spot, canonicalUrl, descriptionText) {
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

  return `  <script type="application/ld+json">\n${JSON.stringify(structuredData, null, 2)}\n  </script>`;
}

// 1スポット分の静的HTMLを生成する。
function renderSpotPage(spot) {
  const spotName = spot.name ? String(spot.name).trim() : "施設詳細";
  const titleText = `${spotName}｜${SITE_NAME}`;
  const descriptionText = buildDescription(spot);
  const canonicalUrl = `${SITE_ORIGIN}/spot/${encodeURIComponent(spot.spot_id)}/`;
  // canonicalと同じドメイン配下の既定OG画像を使い、SNSシェア表示を安定させる。
  const ogImageUrl = `${SITE_ORIGIN}${DEFAULT_OG_IMAGE_PATH}`;
  // send_page_view:false を維持し、ページごとに明示送信して二重計測を防ぐ。
  const ga4Snippet = `  <script async src="https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}"></script>\n  <script>\n    window.dataLayer = window.dataLayer || [];\n    function gtag(){dataLayer.push(arguments);}\n    gtag('js', new Date());\n    gtag('config', '${GA4_MEASUREMENT_ID}', { send_page_view: false });\n    gtag('event', 'page_view', {\n      page_path: '/spot/${encodeURIComponent(spot.spot_id)}/',\n      page_title: '${escapeHtml(titleText)}'\n    });\n  </script>`;

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
${renderStructuredData(spot, canonicalUrl, descriptionText)}
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

    <article id="spot-content" class="spot-content" hidden>
      <div class="spot-content__meta">
        <p id="spot-category" class="spot-category"></p>
        <p id="spot-area" class="spot-area"></p>
      </div>
      <h2 id="spot-title" class="spot-title"></h2>
      <section class="spot-intro">
        <h3 class="spot-intro__title">このスポットについて</h3>
        <p id="spot-intro" class="spot-intro__text"></p>
      </section>

      <section class="spot-events">
        <div class="spot-events__header">
          <h3 class="spot-events__title">開催予定のイベント</h3>
          <p id="spot-events-updated" class="spot-events__updated" hidden></p>
        </div>
        <div id="spot-events-body" class="spot-events__body">
          <div class="spot-events__panel">
            <div id="spot-events-tabs" class="spot-events__tabs" hidden></div>
            <p id="spot-events-status" class="spot-events__status">イベント情報を読み込んでいます。</p>
            <ul id="spot-events-list" class="spot-events__list" hidden></ul>
            <button id="spot-events-more" class="spot-events__more" type="button" hidden>もっと見る</button>
          </div>
        </div>
      </section>

      <div class="spot-actions">
        <a id="spot-google-link" class="spot-action-btn spot-action-btn--primary" href="#" target="_blank" rel="noopener noreferrer">Googleマップで開く</a>
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
    © ${CURRENT_YEAR} ${SITE_NAME} - 公共施設イベント情報を正確に届けるアーカイブサイト
  </footer>

  <script src="../spot.js"></script>
</body>
</html>
`;
}

function main() {
  if (!fs.existsSync(SPOTS_PATH)) {
    throw new Error(`spots.json が見つかりません: ${SPOTS_PATH}`);
  }

  const spots = JSON.parse(fs.readFileSync(SPOTS_PATH, "utf8"));
  if (!Array.isArray(spots)) {
    throw new Error("spots.json の形式が不正です（配列ではありません）");
  }

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
    fs.writeFileSync(path.join(spotDir, "index.html"), renderSpotPage(spot), "utf8");
  });

  console.log(`[generate-spot-pages] spots=${spots.length}`);
}

main();
