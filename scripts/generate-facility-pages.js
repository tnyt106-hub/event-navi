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

// HTMLに差し込む値は最低限エスケープして、表示崩れや意図しない解釈を防ぐ。
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function renderPageHeader({ title, heading, cssPath }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${escapeHtml(cssPath)}" />
</head>
<body>
  <header>
    <h1>${escapeHtml(heading)}</h1>
  </header>
  <main>
`;
}

function renderPageFooter() {
  return `  </main>
  <footer class="trial-footer">
    © 2026 ${SITE_NAME} - 公共施設イベント情報を正確に届けるアーカイブサイト
  </footer>
</body>
</html>
`;
}

function renderFacilityIndexPage(prefectureSummaries) {
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

  return `${renderPageHeader({
    title: `施設から探す｜${SITE_NAME}`,
    heading: "施設から探す",
    cssPath: "../css/style.css"
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

function renderPrefecturePage(prefecture, spots, eventCountMap) {
  const sortedSpots = sortSpotsByKanaName(spots);

  const listHtml =
    sortedSpots.length > 0
      ? sortedSpots
          .map((spot) => {
            const eventCount = eventCountMap.get(spot.spot_id) ?? 0;
            return `          <li class="date-index__item facility-spot-item">
            <a href="../../spot/index.html?spot_id=${encodeURIComponent(spot.spot_id)}">${escapeHtml(spot.name)}</a>
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

  const bodyHtml = `${renderPageHeader({
    title: `${prefecture}の施設一覧｜${SITE_NAME}`,
    heading: `${prefecture}の施設一覧`,
    cssPath: "../../css/style.css"
  })}    <nav class="spot-actions" aria-label="施設ナビゲーション">
      <a class="spot-action-btn" href="../">施設一覧へ戻る</a>
      <a class="spot-action-btn" href="../../index.html">トップへ戻る</a>
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

function main() {
  if (!fs.existsSync(SPOTS_PATH)) {
    throw new Error(`spots.json が見つかりません: ${SPOTS_PATH}`);
  }

  const spots = JSON.parse(fs.readFileSync(SPOTS_PATH, "utf8"));
  const eventCountMap = buildEventCountMap();

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

  const indexHtml = renderFacilityIndexPage(summaries);
  fs.writeFileSync(path.join(FACILITY_ROOT_DIR, "index.html"), indexHtml, "utf8");

  PREFECTURES.forEach((prefecture) => {
    const slug = toPrefSlug(prefecture);
    const prefDir = path.join(FACILITY_ROOT_DIR, slug);
    fs.mkdirSync(prefDir, { recursive: true });

    const prefHtml = renderPrefecturePage(prefecture, spotsByPref.get(prefecture) ?? [], eventCountMap);
    fs.writeFileSync(path.join(prefDir, "index.html"), prefHtml, "utf8");
  });

  console.log("facility pages generated:", path.relative(process.cwd(), FACILITY_ROOT_DIR));
}

main();
