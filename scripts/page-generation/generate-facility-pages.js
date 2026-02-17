"use strict";

const fs = require("fs");
const path = require("path");

// 施設ページでもサイト名表記を統一して、利用者が迷わないようにする。
const SITE_NAME = "イベントガイド【四国版】";
// 今回は四国4県を常に表示する要件のため、表示順を固定で管理する。
const PREFECTURES = ["香川県", "愛媛県", "徳島県", "高知県"];
// URL生成時に使うスラッグを1か所に集約し、将来の変更点を減らす。
const PREF_SLUG_MAP = {
  "香川県": "kagawa",
  "愛媛県": "ehime",
  "徳島県": "tokushima",
  "高知県": "kochi"
};

const SPOTS_PATH = path.join(process.cwd(), "docs", "data", "spots.json");
const EVENTS_DIR = path.join(process.cwd(), "docs", "events");
const FACILITY_ROOT_DIR = path.join(process.cwd(), "docs", "facility");
// 「🔍施設名から探す」は別導線として独立URLで生成し、用途を検索エンジンにも明確化する。
const FACILITY_NAME_ROOT_DIR = path.join(process.cwd(), "docs", "facility-name");
// 施設ページでも同じ広告テンプレートを使い、サイト全体の広告体験を統一する。
const DATE_AD_PARTIAL_PATH = path.join(process.cwd(), "docs", "partials", "date-ad.html");

// GitHub Pagesの公開URLを正規URL（canonical）に使う。
// 将来ドメインが変わっても、この定数だけ直せば全ページへ反映できる。
const SITE_ORIGIN = "https://event-guide.jp";
// OGP/Twitterで使う共通画像。差し替え時の修正箇所を1か所にする。
const DEFAULT_OG_IMAGE_PATH = "/assets/images/ogp-default.svg";
// OGP画像の代替テキストを共通管理し、SNSカードの意味を補う。
const DEFAULT_OG_IMAGE_ALT = "イベントガイド【四国版】のサイト共通OGP画像";
// フッター年は実行年を使い、年更新漏れを防ぐ。
const CURRENT_YEAR = new Date().getFullYear();

// HTMLに差し込む値は最低限エスケープして、表示崩れや意図しない解釈を防ぐ。
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// JSON-LDを script タグへ安全に埋め込むため、`<` をエスケープしてタグ破壊を防ぐ。
function serializeJsonLd(value) {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
}

// 複数の構造化データを head 内へ並べて出力する。
// 一覧ページでは BreadcrumbList + ItemList をセットで渡す想定。
function renderStructuredDataScripts(structuredDataObjects = []) {
  if (!Array.isArray(structuredDataObjects) || structuredDataObjects.length === 0) {
    return "";
  }

  return structuredDataObjects
    .map((item) => `  <script type="application/ld+json">\n${serializeJsonLd(item)}\n  </script>`)
    .join("\n");
}

// 県名からURLパスを安定して作る。未定義県はothersへフォールバックする。
function toPrefSlug(prefecture) {
  return PREF_SLUG_MAP[prefecture] ?? "others";
}

// スポット名は日本語の自然な並びにしたいため、Intl.Collatorで五十音順を行う。
function sortSpotsByKanaName(spots) {
  const collator = new Intl.Collator("ja");
  return [...spots].sort((a, b) => collator.compare(a.name ?? "", b.name ?? ""));
}

// 施設ごとのイベント件数を計算して、ページ表示で使えるようMapにまとめる。
function buildEventCountMap() {
  const eventCountMap = new Map();

  if (!fs.existsSync(EVENTS_DIR)) {
    return eventCountMap;
  }

  const eventFiles = fs.readdirSync(EVENTS_DIR).filter((file) => file.endsWith(".json"));

  eventFiles.forEach((fileName) => {
    const fullPath = path.join(EVENTS_DIR, fileName);
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      const venueId = parsed?.venue_id;
      const events = Array.isArray(parsed?.events) ? parsed.events : [];
      if (venueId) {
        eventCountMap.set(venueId, events.length);
      }
    } catch (error) {
      // 不正JSONがあっても全体生成を止めず、原因が追えるよう警告を残す。
      console.warn("イベント件数集計をスキップ:", fileName, error.message);
    }
  });

  return eventCountMap;
}

// ヘッダーにSEO用メタ情報をまとめて出力する。
// description/canonicalPathはページごとに変わるため引数で受け取る。
// preHeaderHtml を使うと、パンくずなどを <header> より前へ安全に配置できる。
function renderPageHeader({
  title,
  heading,
  cssPath,
  description,
  canonicalPath,
  isNoindex = false,
  preHeaderHtml = "",
  structuredDataObjects = []
}) {
  const canonicalUrl = `${SITE_ORIGIN}${canonicalPath}`;
  // canonicalをもとに OGP画像URLも一意に決め、URL不整合を防ぐ。
  const ogImageUrl = `${SITE_ORIGIN}${DEFAULT_OG_IMAGE_PATH}`;
  // 測定IDは /js/ga4.js 側で一元管理し、このテンプレートはページ情報だけ渡す。
  const ga4ScriptPath = cssPath.replace("/css/", "/js/").replace("style.css", "ga4.js");
  const ga4Snippet = `  <script src="${escapeHtml(ga4ScriptPath)}"></script>\n  <script>\n    // JS文字列として安全に扱うため、JSON.stringifyの結果をそのまま渡す。\n    window.EventNaviAnalytics && window.EventNaviAnalytics.trackPageView(${JSON.stringify(canonicalPath)}, ${JSON.stringify(title)});\n  </script>`;
  // head へまとめて埋め込むことで、クローラがページの意味を取りやすくする。
  const structuredDataScripts = renderStructuredDataScripts(structuredDataObjects);
  // 施設0件ページは内容が薄くなりやすいため、検索結果への露出は抑えつつ導線は残す。
  const robotsMeta = isNoindex ? '  <meta name="robots" content="noindex,follow" />\n' : "";
  return `<!DOCTYPE html>
<html lang="ja">
<head>
${ga4Snippet}
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
${robotsMeta}  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <meta property="og:type" content="website" />
  <meta property="og:locale" content="ja_JP" />
  <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <meta property="og:image" content="${escapeHtml(ogImageUrl)}" />
  <meta property="og:image:alt" content="${escapeHtml(DEFAULT_OG_IMAGE_ALT)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImageUrl)}" />
${structuredDataScripts ? `${structuredDataScripts}\n` : ""}  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${escapeHtml(cssPath)}" />
</head>
<body>
  <a class="skip-link" href="#main-content">本文へスキップ</a>
${preHeaderHtml}  <header>
    <h1>${escapeHtml(heading)}</h1>
  </header>
  <main id="main-content">
`;
}

// パンくず構造化データを共通生成し、ページ階層を検索エンジンへ明示する。
function buildBreadcrumbStructuredData(items) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${SITE_ORIGIN}${item.path}`
    }))
  };
}

// 一覧ページ向けの ItemList を作る。
// ページURLを itemListOrder と合わせて持たせ、一覧性を明確化する。
function buildItemListStructuredData(items, listTitle) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: listTitle,
    itemListOrder: "https://schema.org/ItemListOrderAscending",
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      url: `${SITE_ORIGIN}${item.path}`
    }))
  };
}

// 広告partialを読み込み、見つからない場合は空文字で安全にフォールバックする。
function loadAdHtml() {
  if (!fs.existsSync(DATE_AD_PARTIAL_PATH)) {
    console.warn("date-ad.html が見つからないため施設ページの広告枠は出力しません:", DATE_AD_PARTIAL_PATH);
    return "";
  }

  try {
    return fs.readFileSync(DATE_AD_PARTIAL_PATH, "utf8").trim();
  } catch (error) {
    console.warn("date-ad.html の読み込みに失敗したため施設ページの広告枠は出力しません:", error);
    return "";
  }
}

// 旧テンプレート（ad-card）を検出した場合は、配信タグ本体だけを抽出する。
// 生成スクリプト側で整形しておくことで、既存partialを残したまま表示を移行できる。
function extractAdEmbedHtml(adHtml) {
  if (!adHtml) return "";

  const normalized = String(adHtml).trim();
  if (!normalized) return "";

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

// ページ内の広告位置を属性で識別できるようセクション化して返す。
function renderAdSection(adHtml, positionLabel) {
  if (!adHtml) return "";
  const safePositionLabel = escapeHtml(positionLabel);
  const embedHtml = extractAdEmbedHtml(adHtml);

  if (!embedHtml) return "";

  return `    <section class="date-ad" data-ad-position="${safePositionLabel}">
      <div class="date-ad__embed" role="complementary" aria-label="スポンサーリンク">
${embedHtml}
      </div>
    </section>
`;
}

function renderPageFooter() {
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

// パンくずリストを共通で生成する。
// 最終要素は現在ページとして非リンクにし、スクリーンリーダー向けに aria-current を付与する。
function renderBreadcrumbs(items) {
  const listHtml = items.map((item, index) => {
    const safeLabel = escapeHtml(item.label);
    const isCurrent = index === items.length - 1;

    if (isCurrent || !item.href) {
      return `      <li class="breadcrumb__item" aria-current="page"><span>${safeLabel}</span></li>`;
    }

    return `      <li class="breadcrumb__item"><a href="${escapeHtml(item.href)}">${safeLabel}</a></li>`;
  }).join("\n");

  return `  <nav class="breadcrumb" aria-label="パンくずリスト">
    <ol class="breadcrumb__list">
${listHtml}
    </ol>
  </nav>
`;
}

function renderFacilityIndexPage(prefectureSummaries, adHtml) {
  const cardsHtml = prefectureSummaries
    .map((summary) => {
      return `          <li class="date-index__item facility-pref-item">
            <a href="./${escapeHtml(summary.slug)}/">${escapeHtml(summary.prefecture)}（${summary.spotCount}施設）</a>
            <ul class="date-index__summary">
              <li>登録施設数: ${summary.spotCount}件</li>
              <li>イベント件数（参考）: ${summary.eventCount}件</li>
              <li>${escapeHtml(summary.spotCount > 0 ? "県別の施設一覧へ進めます" : "現在は掲載準備中です")}</li>
            </ul>
          </li>`;
    })
    .join("\n");

  const breadcrumbHtml = renderBreadcrumbs([
    // トップURLを / に統一し、/index.html との重複導線を減らす。
    { label: "ホーム", href: "/" },
    { label: "🗺️エリアから探す" }
  ]);
  // パンくず直下に広告を置く要件に合わせ、preHeaderへ連結して配置を固定する。
  const preHeaderHtml = `${breadcrumbHtml}${renderAdSection(adHtml, "facility-index")}`;

  const structuredDataObjects = [
    buildBreadcrumbStructuredData([
      { name: "ホーム", path: "/" },
      { name: "エリアから探す", path: "/facility/" }
    ]),
    buildItemListStructuredData(
      prefectureSummaries.map((summary) => ({
        name: summary.prefecture,
        path: `/facility/${summary.slug}/`
      })),
      "四国4県の施設一覧"
    )
  ];

  return `${renderPageHeader({
    // SEOでは検索結果の安定表示を優先し、titleから絵文字を外す。
    title: `エリアから探す｜${SITE_NAME}`,
    heading: "🗺️エリアから探す",
    cssPath: "../css/style.css",
    // Step1方針: 施設一覧の説明文を「対象・操作・遷移先」で簡潔に統一する。
    // 検索結果でも用途が伝わるよう、県別比較→詳細遷移までを1文で明記する。
    description: "四国4県の公共施設を県別に比較しながら一覧で確認できるページです。登録施設数とイベント件数の目安を見て、目的の県ページや各施設詳細へスムーズに進めます。",
    canonicalPath: "/facility/",
    // ユーザビリティ向上のため、パンくずをヘッダーより前に配置する。
    preHeaderHtml,
    structuredDataObjects
  })}    <section class="spot-events" aria-labelledby="facility-pref-title">
      <div class="spot-events__header">
        <h2 id="facility-pref-title" class="spot-events__title">県別一覧</h2>
      </div>
      <div class="spot-events__body">
        <div class="spot-events__panel">
          <ul class="date-index__list">
${cardsHtml}
          </ul>
        </div>
      </div>
    </section>
${renderPageFooter()}`;
}

function renderPrefecturePage(prefecture, spots, eventCountMap, adHtml) {
  const sortedSpots = sortSpotsByKanaName(spots);
  // 施設が0件の県ページは薄いコンテンツ化しやすいため noindex を付与する。
  // follow を維持することで、県ページ経由の内部リンク評価は受け渡せる。
  const isNoindex = sortedSpots.length === 0;

  const listHtml =
    sortedSpots.length > 0
      ? sortedSpots
          .map((spot) => {
            const eventCount = eventCountMap.get(spot.spot_id) ?? 0;
            return `          <li class="date-index__item facility-spot-item">
            <a href="../../spot/${encodeURIComponent(spot.spot_id)}/">${escapeHtml(spot.name)}</a>
            <ul class="date-index__summary">
              <li>市町村: ${escapeHtml(spot.municipality ?? "未設定")}</li>
              <li>カテゴリ: ${escapeHtml(spot.category ?? "未設定")}</li>
              <li>イベント件数（参考）: ${eventCount}件</li>
            </ul>
          </li>`;
          })
          .join("\n")
      : `          <li class="date-index__item">
            <ul class="date-index__summary">
              <li>この県の施設情報は現在準備中です。</li>
            </ul>
          </li>`;

  const breadcrumbHtml = renderBreadcrumbs([
    // 県別ページでもルート相対URLを使い、URL正規化を徹底する。
    { label: "ホーム", href: "/" },
    { label: "🗺️エリアから探す", href: "/facility/" },
    { label: prefecture }
  ]);
  // 県別ページでもパンくずの直後に広告を配置して、導線の一貫性を保つ。
  const preHeaderHtml = `${breadcrumbHtml}${renderAdSection(adHtml, `facility-${toPrefSlug(prefecture)}`)}`;

  const structuredDataObjects = [
    buildBreadcrumbStructuredData([
      { name: "ホーム", path: "/" },
      { name: "エリアから探す", path: "/facility/" },
      { name: prefecture, path: `/facility/${toPrefSlug(prefecture)}/` }
    ]),
    buildItemListStructuredData(
      sortedSpots.map((spot) => ({
        name: spot.name,
        path: `/spot/${encodeURIComponent(spot.spot_id)}/`
      })),
      `${prefecture}の施設一覧`
    )
  ];

  const bodyHtml = `${renderPageHeader({
    title: `${prefecture}の施設一覧｜${SITE_NAME}`,
    heading: `${prefecture}の施設一覧`,
    cssPath: "../../css/style.css",
    // 県別ページでは「地域内の絞り込み意図」が伝わるよう、確認できる属性を具体化する。
    description: `${prefecture}の公共施設を地域内で比較しやすい一覧ページです。市町村・カテゴリ・イベント件数の目安を確認しながら、目的に合う施設詳細ページへ移動できます。`,
    canonicalPath: `/facility/${toPrefSlug(prefecture)}/`,
    isNoindex,
    // ユーザビリティ向上のため、パンくずをヘッダーより前に配置する。
    preHeaderHtml,
    structuredDataObjects
  })}    <nav class="spot-actions" aria-label="施設ナビゲーション">
      <a class="spot-action-btn" href="/facility/">施設一覧へ戻る</a>
      <a class="spot-action-btn" href="/">トップへ戻る</a>
    </nav>

    <section class="spot-events" aria-labelledby="facility-list-title">
      <div class="spot-events__header">
        <h2 id="facility-list-title" class="spot-events__title">${escapeHtml(prefecture)}（${sortedSpots.length}施設）</h2>
      </div>
      <div class="spot-events__body">
        <div class="spot-events__panel">
          <ul class="date-index__list">
${listHtml}
          </ul>
        </div>
      </div>
    </section>
${renderPageFooter()}`;

  return bodyHtml;
}

// 施設名50音順ページを生成し、県横断で施設を探しやすくする。
function renderFacilityNameIndexPage(spots, eventCountMap, adHtml) {
  const sortedSpots = sortSpotsByKanaName(spots);

  const listHtml =
    sortedSpots.length > 0
      ? sortedSpots
          .map((spot) => {
            const eventCount = eventCountMap.get(spot.spot_id) ?? 0;
            return `          <li class="date-index__item facility-spot-item">
            <a href="../spot/${encodeURIComponent(spot.spot_id)}/">${escapeHtml(spot.name)}</a>
            <ul class="date-index__summary">
              <li>都道府県: ${escapeHtml(spot.prefecture ?? "未設定")}</li>
              <li>市町村: ${escapeHtml(spot.municipality ?? "未設定")}</li>
              <li>カテゴリ: ${escapeHtml(spot.category ?? "未設定")}</li>
              <li>イベント件数（参考）: ${eventCount}件</li>
            </ul>
          </li>`;
          })
          .join("\n")
      : `          <li class="date-index__item">
            <ul class="date-index__summary">
              <li>施設情報は現在準備中です。</li>
            </ul>
          </li>`;

  const breadcrumbHtml = renderBreadcrumbs([
    // 施設名一覧でも /index.html ではなく / を正規リンクとして使う。
    { label: "ホーム", href: "/" },
    { label: "🔍施設名から探す" }
  ]);
  // 新規導線ページも他ページと同じレイアウトルール（パンくず→広告）で統一する。
  const preHeaderHtml = `${breadcrumbHtml}${renderAdSection(adHtml, "facility-name-index")}`;

  const structuredDataObjects = [
    buildBreadcrumbStructuredData([
      { name: "ホーム", path: "/" },
      { name: "施設名から探す", path: "/facility-name/" }
    ]),
    buildItemListStructuredData(
      sortedSpots.map((spot) => ({
        name: spot.name,
        path: `/spot/${encodeURIComponent(spot.spot_id)}/`
      })),
      "四国4県の施設名一覧（50音順）"
    )
  ];

  return `${renderPageHeader({
    // SEOでは検索結果の安定表示を優先し、titleから絵文字を外す。
    title: `施設名から探す｜${SITE_NAME}`,
    heading: "🔍施設名から探す",
    cssPath: "../css/style.css",
    // SEO向けに「地域・並び順・遷移先」の3点を短く明示する。
    // 初回訪問者が迷わないよう、50音順で横断検索できる価値を説明文へ含める。
    description: "四国4県の公共施設を施設名の50音順で横断的に一覧表示するページです。都道府県・市町村・カテゴリ・イベント件数を確認しながら、気になる施設詳細へ進めます。",
    canonicalPath: "/facility-name/",
    preHeaderHtml,
    structuredDataObjects
  })}    <!-- 施設名ページでは重複導線になるため、上部ナビゲーションボタンは表示しない -->

    <section class="spot-events" aria-labelledby="facility-name-list-title">
      <div class="spot-events__header">
        <h2 id="facility-name-list-title" class="spot-events__title">施設名一覧（50音順・${sortedSpots.length}施設）</h2>
      </div>
      <div class="spot-events__body">
        <div class="spot-events__panel">
          <ul class="date-index__list">
${listHtml}
          </ul>
        </div>
      </div>
    </section>
${renderPageFooter()}`;
}

function main() {
  if (!fs.existsSync(SPOTS_PATH)) {
    throw new Error(`spots.json が見つかりません: ${SPOTS_PATH}`);
  }

  const spots = JSON.parse(fs.readFileSync(SPOTS_PATH, "utf8"));
  const eventCountMap = buildEventCountMap();
  const adHtml = loadAdHtml();

  // 県ごとの配列を先に作っておくと、一覧ページと詳細ページ双方で使い回せる。
  const spotsByPref = new Map(PREFECTURES.map((prefecture) => [prefecture, []]));
  spots.forEach((spot) => {
    if (!spotsByPref.has(spot.prefecture)) {
      // 四国外のデータ混入時も落とさずに扱えるよう、others枠を用意する。
      if (!spotsByPref.has("others")) spotsByPref.set("others", []);
      spotsByPref.get("others").push(spot);
      return;
    }
    spotsByPref.get(spot.prefecture).push(spot);
  });

  fs.mkdirSync(FACILITY_ROOT_DIR, { recursive: true });
  fs.mkdirSync(FACILITY_NAME_ROOT_DIR, { recursive: true });

  const summaries = PREFECTURES.map((prefecture) => {
    const prefSpots = spotsByPref.get(prefecture) ?? [];
    const eventCount = prefSpots.reduce((sum, spot) => sum + (eventCountMap.get(spot.spot_id) ?? 0), 0);
    return {
      prefecture,
      slug: toPrefSlug(prefecture),
      spotCount: prefSpots.length,
      eventCount
    };
  });

  const indexHtml = renderFacilityIndexPage(summaries, adHtml);
  fs.writeFileSync(path.join(FACILITY_ROOT_DIR, "index.html"), indexHtml, "utf8");

  PREFECTURES.forEach((prefecture) => {
    const slug = toPrefSlug(prefecture);
    const prefDir = path.join(FACILITY_ROOT_DIR, slug);
    fs.mkdirSync(prefDir, { recursive: true });

    const prefHtml = renderPrefecturePage(prefecture, spotsByPref.get(prefecture) ?? [], eventCountMap, adHtml);
    fs.writeFileSync(path.join(prefDir, "index.html"), prefHtml, "utf8");
  });

  // 施設名導線ページは四国4県の全施設をまとめて掲載する。
  const facilityNameIndexHtml = renderFacilityNameIndexPage(spots, eventCountMap, adHtml);
  fs.writeFileSync(path.join(FACILITY_NAME_ROOT_DIR, "index.html"), facilityNameIndexHtml, "utf8");

  console.log("facility pages generated:", path.relative(process.cwd(), FACILITY_ROOT_DIR));
  console.log("facility-name page generated:", path.relative(process.cwd(), FACILITY_NAME_ROOT_DIR));
}

main();
