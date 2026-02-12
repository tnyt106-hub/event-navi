console.log("map.js loaded");

// =======================
// GA4 helper（最小）
// =======================
function gaPageView(pagePath, title) {
  if (typeof window.gtag !== "function") return; // GA未読込なら何もしない
  window.gtag("event", "page_view", {
    page_path: pagePath,
    page_title: title
  });
}
function gaEvent(name, params = {}) {
  if (typeof window.gtag !== "function") return;
  window.gtag("event", name, params);
}
// =======================
// 地図内ピン選択パネル
// =======================
function renderSpotPanel(spot) {
  const panel = document.getElementById("spot-panel");
  if (!panel) return; // HTML側が未設置なら何もしない
  const title = panel.querySelector(".spot-panel__title");
  const cat = document.getElementById("spot-panel-category");
  const area = document.getElementById("spot-panel-area");
  const google = document.getElementById("spot-panel-google");
  const detail = document.getElementById("spot-panel-detail");
  const official = document.getElementById("spot-panel-official");
  const toggleBtn = document.getElementById("spot-panel-toggle");
  panel.classList.remove("is-empty");
  // スポット選択時は詳細が見える状態で開き、視認性を高める
  panel.classList.add("is-expanded");
  if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "true");
  const name = spot.name ?? "名称不明";
  // パネル内の要素が存在しない場合は個別にスキップ（HTML変更時の保険）
  if (title) title.textContent = name;
  if (cat) cat.textContent = spot.category ? `#${spot.category}` : "";
  if (area) {
    area.textContent =
      (spot.prefecture || spot.municipality)
        ? `${spot.prefecture ?? ""}${spot.municipality ? " " + spot.municipality : ""}`
        : "";
  }
  // Google（ルート検索）
  if (google) {
    google.href = `https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lng}`;
  }
  // 詳細ページ（spot_idが無いなら非表示）
  if (detail) {
    if (spot.spot_id) {
      // 動的詳細ページ（b方式）へ遷移させる
      detail.href = `./spot/index.html?spot_id=${encodeURIComponent(spot.spot_id)}`;
      detail.style.display = "inline-block";
    } else {
      detail.style.display = "none";
    }
  }
  // 公式サイト（URLが無い場合は非表示にしてUIを崩さない）
  if (official) {
    if (spot.official_url) {
      official.href = spot.official_url;
      official.style.display = "inline-flex";
    } else {
      official.style.display = "none";
    }
  }
  // GA（任意：スポット表示）
  gaEvent("select_content", { content_type: "spot", item_id: spot.spot_id ?? name });
}
// =======================
// 地図内ピン選択パネルを閉じる
// =======================
function clearSpotPanel() {
  const panel = document.getElementById("spot-panel");
  if (!panel) return;
  // 選択を解除する時は、内部状態とピン見た目を必ず同時に初期化する
  pinnedEntry = null;
  syncSelectedMarkerVisual();
  panel.classList.add("is-empty");
  panel.classList.remove("is-expanded");
  const title = panel.querySelector(".spot-panel__title");
  if (title) title.textContent = "スポット未選択";
  const cat = document.getElementById("spot-panel-category");
  const area = document.getElementById("spot-panel-area");
  if (cat) cat.textContent = "";
  if (area) area.textContent = "";
  // 公式サイトボタンは未選択時に非表示にする
  const official = document.getElementById("spot-panel-official");
  if (official) official.style.display = "none";
  // 詳細ボタンも未選択時は非表示にして、誤遷移を防止する
  const detail = document.getElementById("spot-panel-detail");
  if (detail) detail.style.display = "none";
  // ルート検索ボタンは未選択時の遷移先がないため無効化する
  const google = document.getElementById("spot-panel-google");
  if (google) google.removeAttribute("href");
  // 「ピン未選択」になったことをURLにも反映し、共有時の状態ズレを防ぐ
  syncSelectedSpotToUrl("");
  // 一覧カード側の選択強調も解除して、双方向連動の状態を正しく保つ
  setTodayEventActiveSpot("");
  // 空状態に戻すときはトグルのARIAも初期化しておく
  const toggleBtn = document.getElementById("spot-panel-toggle");
  if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
  // 検索で絞り込み中でも、全件表示に戻す
  setVisibleEntries(markerEntries);
  // 地図を“ホーム表示”に戻す（見栄えが毎回安定）
  const isWide = window.matchMedia("(min-width: 1024px)").matches;
  map.setView(HOME_CENTER, isWide ? HOME_ZOOM_PC : HOME_ZOOM_MOBILE);
  // 開いているポップアップも閉じる（任意だけど気持ちいい
  map.closePopup();
}

// URLクエリ「?spot=...」へ選択中スポットを保存する
function syncSelectedSpotToUrl(spotId) {
  const url = new URL(window.location.href);
  if (spotId) {
    url.searchParams.set("spot", spotId);
  } else {
    url.searchParams.delete("spot");
  }
  // pushStateだと履歴が増え続けるため、replaceStateで現在履歴のみ更新する
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

// URLにスポット指定がある場合の復元用IDを取り出す
function getInitialSpotIdFromUrl() {
  const url = new URL(window.location.href);
  return url.searchParams.get("spot") || "";
}
// =======================
// 地図初期化
// =======================
// 1) 操作制限用（少し広めにして“窮屈さ”を減らす）
const shikokuBounds = L.latLngBounds(
  [32.65, 131.95],
  [34.70, 134.75]
);
// 2) 初期表示・戻る用（見栄えを固定）
const HOME_CENTER = [33.75, 133.65]; // 四国の中心付近
const HOME_ZOOM_PC = 8;              // PCは少し寄せる
const HOME_ZOOM_MOBILE = 8;          // 必要なら 8 に
const map = L.map("map", {
  zoomControl: false,
  maxBounds: shikokuBounds,
  maxBoundsViscosity: 0.7
});
// 要件: ピン選択時はこのズーム値まで寄せて、施設位置を把握しやすくする
const SPOT_FOCUS_ZOOM = 11;
// 本日イベントJSONの同時取得数。通信輻輳で地図描画が遅くならないよう上限を設ける
const EVENT_FETCH_CONCURRENCY = 4;
const isWide = window.matchMedia("(min-width: 1024px)").matches;
map.setView(HOME_CENTER, isWide ? HOME_ZOOM_PC : HOME_ZOOM_MOBILE);
gaPageView("/map", document.title);// GA4 helper（最小）
setTimeout(() => {
  map.invalidateSize();
}, 200);
//地図レイヤ切り替えロジック
const baseMaps = {
  "標準1": L.tileLayer("https://{s}.tile.openstreetmap.jp/{z}/{x}/{y}.png",
    {attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}),
  "標準2": L.tileLayer("https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
    {attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Tiles © HOT'}),
  "地理": L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png",
    {attribution: '© <a href="https://www.gsi.go.jp/">国土地理院</a>'}),
  "航空写真": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {attribution: 'Tiles © <a href="https://www.esri.com/">Esri</a>'})
};
baseMaps["標準1"].addTo(map);
L.control.layers(baseMaps).addTo(map);
// 仕様変更: クラスタリングは行わず、常に個別のピンを表示する
const markers = L.layerGroup();
// 仕様: 通常ピンはLeaflet標準、選択中のみ赤ピン画像へ差し替える
// 色変換フィルタを廃止して画像を切り替えることで、黄色化や赤い発光残りを根本的に防ぐ
const defaultMarkerIcon = new L.Icon.Default();
const selectedMarkerIcon = L.icon({
  iconUrl: "./assets/images/leaflet/marker-icon-red.svg",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  tooltipAnchor: [16, -28]
});
// =======================
// 検索ボックス用
// =======================
let allSpots = [];
let markerEntries = [];
let visibleEntries = [];
let pinnedEntry = null; // 直前に選択されたスポットを保持して、次のピン操作まで固定する
const TODAY_EVENTS_VISIBLE_LIMIT = 5; // 要件: PC初期表示は5件
let todayEventsAll = []; // 「本日開催中イベント」の全件（もっと見るで切替に使う）
let todayEventsExpanded = false; // もっと見るの開閉状態

// スマホ判定はmatchMediaで1箇所に集約し、条件の書き間違いを防ぐ
function isMobileViewport() {
  return window.matchMedia("(max-width: 767px)").matches;
}
const markerEntryBySpotId = new Map(); // 一覧カードから地図ピンへ移動するための逆引き
// 施設イベントJSONをセッション内で再利用し、同じ通信を繰り返さない
const eventListCacheBySpotId = new Map();
const INITIAL_SPOT_ID = getInitialSpotIdFromUrl(); // URL共有で復元する初期選択ID
let isTodayEventsRenderScheduled = false; // 逐次読み込み中の再描画を1フレームにまとめるためのフラグ

// 一覧カード側で選択中の施設をハイライトし、地図と双方向に連動させる
function setTodayEventActiveSpot(spotId) {
  const buttons = document.querySelectorAll(".today-events__button");
  buttons.forEach((button) => {
    const isActive = spotId && button.dataset.spotId === spotId;
    button.classList.toggle("is-active", Boolean(isActive));
    // スクリーンリーダーでも「選択中」を伝えるためにARIA属性を同期する
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

// 日付文字列(YYYY-MM-DD)をローカル日付として扱えるDateに変換する
function parseDateStringAsLocalDay(dateText) {
  if (!dateText) return null;
  const value = String(dateText).trim();
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

// 本日判定用に現在日付を00:00へ丸める
function getCurrentLocalDay() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// トップ見出し用に「YYYY年MM月DD日」の固定フォーマット文字列を作る
// Dateオブジェクトを YYYY-MM-DD 形式へ変換する（ローカル日付ベース）
function formatDateKey(dateObj) {
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, "0");
  const day = String(dateObj.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatCurrentDateForTodayTitle(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}年${month}月${day}日`;
}

// 仕様変更: 見出しを「本日(YYYY年MM月DD日)のイベント (件数)」形式に更新する
function updateTodayEventsTitleWithCurrentDate(eventCount = null) {
  const title = document.getElementById("today-events-title");
  if (!title) return;
  const todayLabel = formatCurrentDateForTodayTitle();

  // 日付部分のみ青色にするため、見出し要素を都度組み立てる
  title.textContent = "";

  const prefix = document.createTextNode("本日(");
  const date = document.createElement("span");
  date.className = "today-events__accent";
  date.textContent = todayLabel;
  const suffix = document.createTextNode(")のイベント");

  title.append(prefix, date, suffix);

  // 件数が算出できたタイミングのみ、見出し右側へ「(18件)」形式で追記する
  if (typeof eventCount === "number" && eventCount >= 0) {
    const countWrap = document.createElement("span");
    countWrap.className = "today-events__count";

    const countOpen = document.createTextNode(" (");
    const countValue = document.createElement("span");
    countValue.className = "today-events__accent";
    countValue.textContent = String(eventCount);
    const countClose = document.createTextNode("件)");

    countWrap.append(countOpen, countValue, countClose);
    title.append(countWrap);
  }
}

// 要件: 「現在時刻の日が開催日と一致」するイベントのみ抽出する
function isEventHeldToday(eventItem, today) {
  const startDay = parseDateStringAsLocalDay(eventItem?.date_from);
  const endDay = parseDateStringAsLocalDay(eventItem?.date_to) || startDay;
  if (!startDay || !endDay) return false;
  return startDay <= today && today <= endDay;
}

// 一覧表示件数を返す（スマホは横スクロール運用のため常に全件表示）
function getVisibleTodayEvents() {
  if (isMobileViewport()) return todayEventsAll;
  if (todayEventsExpanded) return todayEventsAll;
  return todayEventsAll.slice(0, TODAY_EVENTS_VISIBLE_LIMIT);
}

// 「もっと見る」ボタンの表示/文言を同期する（スマホは非表示）
function updateTodayEventsMoreButton() {
  const moreButton = document.getElementById("today-events-more");
  if (!moreButton) return;
  if (isMobileViewport()) {
    moreButton.hidden = true;
    return;
  }
  const hasMore = todayEventsAll.length > TODAY_EVENTS_VISIBLE_LIMIT;
  moreButton.hidden = !hasMore;
  moreButton.textContent = todayEventsExpanded ? "表示を閉じる" : "もっと見る";
}

// 地図側のスポットを強調表示する（一覧カードタップ時）
function focusSpotFromTodayEvent(spotId) {
  if (!spotId) return;
  const targetEntry = markerEntryBySpotId.get(spotId);
  if (!targetEntry) return;
  // 「本日開催中」カード経由でも、地図ピン選択と同じ処理を使って挙動を統一する
  onSpotSelect(targetEntry);
}

// 「本日開催中イベント」リストを描画する
function renderTodayEvents() {
  const list = document.getElementById("today-events-list");
  const status = document.getElementById("today-events-status");
  if (!list || !status) return;

  list.innerHTML = "";

  if (todayEventsAll.length === 0) {
    // 0件時も見出し右側の件数表示を最新化する
    updateTodayEventsTitleWithCurrentDate(0);
    status.textContent = "本日開催中のイベントは見つかりませんでした。";
    updateTodayEventsMoreButton();
    return;
  }

  // 要件変更: 件数は見出しに表示し、ステータス行の固定文言は削除する
  updateTodayEventsTitleWithCurrentDate(todayEventsAll.length);
  status.textContent = "";

  getVisibleTodayEvents().forEach((item) => {
    const li = document.createElement("li");
    li.className = "today-events__item";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "today-events__button";
    button.dataset.spotId = item.spotId || "";
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", `${item.title}（${item.venueName}）の地図ピンを表示`);
    button.addEventListener("click", () => {
      focusSpotFromTodayEvent(item.spotId);
    });

    const title = document.createElement("p");
    title.className = "today-events__name";
    title.textContent = item.title;

    // 表記を短くしてカード縦幅を抑えるため、「開催場所」→「場所」に統一する
    const meta = document.createElement("p");
    meta.className = "today-events__meta";
    meta.textContent = `場所: ${item.venueName}`;

    // 開催場所テキストの右に詳細ボタンを横並び配置するためのコンテナ
    const actions = document.createElement("div");
    actions.className = "today-events__actions";

    const detailLink = document.createElement("a");
    detailLink.className = "today-events__detail";
    detailLink.textContent = "詳細";
    detailLink.href = `./date/${encodeURIComponent(item.dateKey)}/?event=${encodeURIComponent(item.eventQuery)}&venue=${encodeURIComponent(item.venueName)}`;
    detailLink.setAttribute("aria-label", `${item.title}の詳細を日付ページで表示`);

    button.appendChild(title);
    actions.append(meta, detailLink);
    li.append(button, actions);
    list.appendChild(li);
  });

  updateTodayEventsMoreButton();
  syncTodayEventsCarouselControls();
  // 一覧描画後に現在の選択状態を再適用し、再描画時の強調消失を防ぐ
  setTodayEventActiveSpot(pinnedEntry?.spot?.spot_id || "");
}

// 各施設のイベントJSONを読み込み、「本日開催中イベント」を組み立てる
async function loadTodayEvents(spots) {
  const status = document.getElementById("today-events-status");
  const today = getCurrentLocalDay();
  const fetchTargets = spots.filter((spot) => spot?.spot_id);

  // 進捗が見えるようにして、ユーザーが「固まった」と感じるのを防ぐ
  if (status) {
    status.textContent = `本日開催中イベントを読み込み中…（0/${fetchTargets.length}施設）`;
  }

  const eventsBuffer = [];
  let loadedCount = 0;

  // 部分完了を1フレームにまとめて一覧反映し、連続DOM更新のコストを抑える
  const scheduleTodayEventsRender = () => {
    if (isTodayEventsRenderScheduled) return;
    isTodayEventsRenderScheduled = true;
    requestAnimationFrame(() => {
      isTodayEventsRenderScheduled = false;
      todayEventsAll = eventsBuffer
        .slice()
        // 要件: イベント名50音順（日本語ロケールで比較）
        .sort((a, b) => a.title.localeCompare(b.title, "ja"));
      renderTodayEvents();
    });
  };

  await runWithConcurrency(fetchTargets, EVENT_FETCH_CONCURRENCY, async (spot) => {
    const events = await fetchSpotEventsForToday(spot, today);
    eventsBuffer.push(...events);
    loadedCount += 1;

    // 取得進捗を更新し、読み込み中でも状態が分かるようにする
    if (status) {
      status.textContent = `本日開催中イベントを読み込み中…（${loadedCount}/${fetchTargets.length}施設）`;
    }

    // 施設ごとの読み込み完了時に段階表示する
    scheduleTodayEventsRender();
  });

  // 最終結果で確定描画（最後のrequestAnimationFrame待ちが残るケースを防ぐ）
  todayEventsAll = eventsBuffer
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, "ja"));

  todayEventsExpanded = false;
  renderTodayEvents();

  if (status && todayEventsAll.length > 0) {
    status.setAttribute("data-loaded", "true");
  }
}

// 施設イベントJSONを取得し、本日開催分へ整形する（キャッシュ付き）
async function fetchSpotEventsForToday(spot, today) {
  if (!spot?.spot_id) return [];

  // 既に取得済みならそのPromiseを再利用して二重通信を防ぐ
  if (eventListCacheBySpotId.has(spot.spot_id)) {
    return eventListCacheBySpotId.get(spot.spot_id);
  }

  const fetchPromise = (async () => {
    try {
      const response = await fetch(`./events/${encodeURIComponent(spot.spot_id)}.json`);
      if (!response.ok) return [];
      const json = await response.json();
      const events = Array.isArray(json?.events) ? json.events : [];
      return events
        .filter((eventItem) => isEventHeldToday(eventItem, today))
        .map((eventItem) => ({
          title: eventItem?.title ? String(eventItem.title).trim() : "名称不明イベント",
          venueName: spot.name ? String(spot.name).trim() : "会場名不明",
          spotId: spot.spot_id,
          // 本日開催中一覧の「詳細」は、開始日ではなく「今日」の日付ページへ遷移させる。
          // こうすることで、長期開催イベントでもユーザーが見ている日付文脈と遷移先が一致する。
          dateKey: formatDateKey(today),
          eventQuery: eventItem?.title ? String(eventItem.title).trim() : "",
        }));
    } catch (error) {
      // 1施設分の読み込み失敗で全体が止まらないようにし、他施設の表示を優先する
      console.error(`イベントJSONの読み込みに失敗: ${spot.spot_id}`, error);
      return [];
    }
  })();

  eventListCacheBySpotId.set(spot.spot_id, fetchPromise);
  return fetchPromise;
}

// 配列を上限付き並列で処理し、通信同時実行数をコントロールする
async function runWithConcurrency(items, concurrency, worker) {
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  let currentIndex = 0;

  const runWorker = async () => {
    while (currentIndex < items.length) {
      const targetIndex = currentIndex;
      currentIndex += 1;
      await worker(items[targetIndex], targetIndex);
    }
  };

  const runners = Array.from({ length: safeConcurrency }, () => runWorker());
  await Promise.all(runners);
}

// 横スクロール一覧の左右矢印を同期する
function syncTodayEventsCarouselControls() {
  const list = document.getElementById("today-events-list");
  const prevButton = document.getElementById("today-events-prev");
  const nextButton = document.getElementById("today-events-next");
  if (!list || !prevButton || !nextButton) return;

  const maxScrollLeft = Math.max(0, list.scrollWidth - list.clientWidth);
  prevButton.disabled = list.scrollLeft <= 2;
  nextButton.disabled = list.scrollLeft >= maxScrollLeft - 2;
}

// 左右矢印を押した時はカード1枚分だけスクロールする
function setupTodayEventsCarouselControls() {
  const list = document.getElementById("today-events-list");
  const prevButton = document.getElementById("today-events-prev");
  const nextButton = document.getElementById("today-events-next");
  if (!list || !prevButton || !nextButton) return;

  const scrollByOneCard = (direction) => {
    const card = list.querySelector(".today-events__item");
    const gapText = window.getComputedStyle(list).columnGap || "0";
    const gap = Number.parseFloat(gapText) || 0;
    const cardWidth = card ? card.getBoundingClientRect().width + gap : list.clientWidth * 0.84;
    list.scrollBy({ left: direction * cardWidth, behavior: "smooth" });
  };

  prevButton.addEventListener("click", () => scrollByOneCard(-1));
  nextButton.addEventListener("click", () => scrollByOneCard(1));

  list.addEventListener("scroll", syncTodayEventsCarouselControls, { passive: true });
  window.addEventListener("resize", syncTodayEventsCarouselControls);
  syncTodayEventsCarouselControls();
}

// 「もっと見る」ボタンを初期化する
function setupTodayEventsMoreButton() {
  const moreButton = document.getElementById("today-events-more");
  if (!moreButton) return;
  moreButton.addEventListener("click", () => {
    todayEventsExpanded = !todayEventsExpanded;
    renderTodayEvents();
  });
}
function setVisibleEntries(entries) {
  // 検索やリセットのたびに「いま表示しているマーカー群」を同期する
  visibleEntries = entries;
  markers.clearLayers();
  visibleEntries.forEach(e => markers.addLayer(e.marker));
  // Leafletは再描画時にDOMを作り直すため、表示更新後に選択中スタイルを再適用する
  syncSelectedMarkerVisual();
}

// 選択中ピンだけを強調して、ユーザーが現在位置を見失わないようにする
function syncSelectedMarkerVisual() {
  markerEntries.forEach((entry) => {
    const isSelected = pinnedEntry === entry;

    // 選択状態ごとにアイコン画像を切り替え、色変換フィルタによる色ズレを防ぐ
    entry.marker.setIcon(isSelected ? selectedMarkerIcon : defaultMarkerIcon);

    // setIcon後はDOMが再生成されるため、クラス操作は必ず再取得した要素へ適用する
    const markerElement = entry.marker.getElement();
    if (!markerElement) return;
    markerElement.classList.toggle("spot-marker--selected", isSelected);
    markerElement.classList.toggle("spot-marker--default", !isSelected);
  });
}

function onSpotSelect(entry) {
  // ピン/ラベルのどちらからでも同一の選択処理にする（挙動の統一）
  if (!entry) return;
  pinnedEntry = entry;
  // 要件: ピン選択時に選択地点まで寄せる。既に拡大済みの場合はズームアウトしない
  const markerLatLng = entry.marker.getLatLng();
  const nextZoom = Math.max(map.getZoom(), SPOT_FOCUS_ZOOM);
  map.flyTo(markerLatLng, nextZoom, { duration: 0.45 });

  // 地図移動とDOM更新を分離し、操作入力直後の体感遅延を減らす
  requestAnimationFrame(() => {
    // 選択中のピンを視覚的に目立たせる
    syncSelectedMarkerVisual();
    // 要件対応: ピン直上のLeafletポップアップは表示しない（下部パネルのみを使う）
    entry.marker.closePopup();
    renderSpotPanel(entry.spot);
    // 仕様: 一覧側にも選択状態を反映して、双方向連動を成立させる
    setTodayEventActiveSpot(entry.spot?.spot_id || "");
    // 仕様: 共有URLで同じ施設を再表示できるよう、spot_idをクエリへ保存する
    syncSelectedSpotToUrl(entry.spot?.spot_id || "");
  });
}
function createPopupContent(spot) {
  const container = document.createElement("div");
  container.className = "popup-content";
  const title = document.createElement("strong");
  title.textContent = spot.name ?? "名称不明";
  container.appendChild(title);
  // ポップアップは「要約のみ」にして、下部カードへ視線を誘導する
  const summaryText = (() => {
    const areaText = [spot.prefecture, spot.municipality].filter(Boolean).join(" ");
    const categoryText = spot.category ?? "";
    if (categoryText || areaText) {
      return [categoryText, areaText].filter(Boolean).join(" / ");
    }
    // 説明文がある場合は先頭の短いフレーズを表示して情報量を抑える
    if (spot.description) {
      const shortDescription = spot.description.slice(0, 30);
      // 30文字を超える場合は省略記号で「続きがある」ことを示す
      return spot.description.length > 30 ? `${shortDescription}…` : shortDescription;
    }
    return "詳細は下部カードをご覧ください";
  })();
  const summary = document.createElement("span");
  summary.className = "popup-summary";
  summary.textContent = summaryText;
  container.appendChild(document.createElement("br"));
  container.appendChild(summary);
  if (spot.spot_id) {
    const detailLink = document.createElement("a");
    // 内部詳細ページへ誘導（下部カードとの導線を統一）
    detailLink.href = `./spot/index.html?spot_id=${encodeURIComponent(spot.spot_id)}`;
    detailLink.className = "popup-link-btn popup-link-btn--compact";
    detailLink.textContent = "詳細を見る ▶";
    container.appendChild(document.createElement("br"));
    container.appendChild(detailLink);
  }
  return container;
}
// 要件変更: ピン以外（地図の余白）をクリックしても状態は変えない
// 以前は clearSpotPanel() で初期表示へ戻していたが、ユーザー操作の意図とズレるため廃止
// トップ見出しはロード直後に現在日付へ更新し、表示と実データの日付認識を一致させる
updateTodayEventsTitleWithCurrentDate();
setupTodayEventsMoreButton();
setupTodayEventsCarouselControls();
// =======================
// スポット読み込み
// =======================
fetch("./data/spots.json")
  .then(res => {
    if (!res.ok) throw new Error("spots.json not found");
    return res.json();
  })
  .then(spots => {
    allSpots = spots;   // 検索ボックス用
    console.log("spots:", spots.length);

    spots.forEach(s => {
      if (!s.lat || !s.lng) return;
      // 要件対応: 地図ピン上の吹き出し（スポット名ラベル）は表示しない
      // 施設情報は下部のスポットパネルに一本化する
      const marker = L.marker([s.lat, s.lng]);
      const entry = { marker, name: s.name ?? "", spot: s };
      marker.on("click", () => onSpotSelect(entry)); // 地図下表示用
      markers.addLayer(marker);

     markerEntries.push(entry);//検索ボックス用
      if (s.spot_id) markerEntryBySpotId.set(s.spot_id, entry); // 一覧カードから地図ピンを参照するために保持
    });
        map.addLayer(markers);
        setVisibleEntries(markerEntries);
        // 地図ピンの準備ができた後に「本日開催中イベント」を読み込む
        loadTodayEvents(spots);
        // URL共有で指定されたスポットがあれば初期表示時に復元する
        if (INITIAL_SPOT_ID) {
          const initialEntry = markerEntryBySpotId.get(INITIAL_SPOT_ID);
          if (initialEntry) {
            map.setView(initialEntry.marker.getLatLng(), Math.max(map.getZoom(), 12));
            onSpotSelect(initialEntry);
          }
        }
    // ×閉じるボタン（ここで有効化：markerEntriesが埋まった後）
    const closeBtn = document.getElementById("spot-panel-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        clearSpotPanel();
      });
    }
    const toggleBtn = document.getElementById("spot-panel-toggle");
    const panel = document.getElementById("spot-panel");
    if (toggleBtn && panel) {
      toggleBtn.addEventListener("click", () => {
        // 未選択状態では展開処理を行わない（案内文のみ）
        if (panel.classList.contains("is-empty")) return;
        const isExpanded = panel.classList.toggle("is-expanded");
        // ARIA属性を更新して、状態を支援技術へ伝える
        toggleBtn.setAttribute("aria-expanded", String(isExpanded));
      });
    }
  })
  .catch(err => {
    console.error(err);
    alert("spots.json の読み込みに失敗しました");
  });

// =======================
// 現在地取得ロジック
// =======================
let currentMarker = null;
const locateBtn = document.getElementById("locate-btn");
if (locateBtn) {
  const locateLabel = locateBtn.querySelector(".label");
  // 既存ラベルを控えておき、取得中の文言変更後に戻せるようにする
  const defaultLocateLabel = locateLabel?.textContent ?? "現在地";
  // 現在地取得中はボタンを無効化して連打を防ぐ
  const setLocateButtonState = (isLoading) => {
    locateBtn.disabled = isLoading;
    locateBtn.setAttribute("aria-busy", String(isLoading));
    // 既存のアイコン構造を壊さないため、ラベルのみ差し替える
    if (locateLabel) {
      locateLabel.textContent = isLoading ? "現在地取得中..." : defaultLocateLabel;
      return;
    }
    locateBtn.textContent = isLoading ? "現在地取得中..." : defaultLocateLabel;
  };
  locateBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      alert("このブラウザは位置情報に対応していません");
      return;
    }
    // 初回取得に時間がかかる端末を想定し、タイムアウトを長めに設定する
    const buildOptions = (timeoutMs) => ({
      enableHighAccuracy: true,
      timeout: timeoutMs,
      maximumAge: 0
    });
    const handleSuccess = (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      map.flyTo([lat, lng], 14, { duration: 0.7 });
      if (currentMarker) map.removeLayer(currentMarker);
      currentMarker = L.marker([lat, lng])
        .addTo(map)
        .bindPopup("📍 現在地")
        .openPopup();
      setLocateButtonState(false);
    };
    const handleError = (err, didRetry) => {
      // 許可拒否は再試行しても改善しないため即案内する
      if (err.code === err.PERMISSION_DENIED) {
        alert(
          "位置情報の使用が許可されていない可能性があります。\n" +
          "ブラウザの設定から許可してください。"
        );
        setLocateButtonState(false);
        return;
      }
      // タイムアウトや一時的な取得失敗は1回だけ再試行する
      if (!didRetry && (err.code === err.TIMEOUT || err.code === err.POSITION_UNAVAILABLE)) {
        navigator.geolocation.getCurrentPosition(
          handleSuccess,
          (retryErr) => handleError(retryErr, true),
          buildOptions(30000)
        );
        return;
      }
      alert(
        "位置情報を取得できませんでした。\n" +
        "端末の設定を確認後、再実行してください。"
      );
      setLocateButtonState(false);
    };
    setLocateButtonState(true);
    navigator.geolocation.getCurrentPosition(
      handleSuccess,
      (err) => handleError(err, false),
      buildOptions(20000)
    );
  });

} else {
  console.warn("locate-btn が見つかりません");
}
// =======================
// 検索ボックス処理
// =======================
const searchInput = document.getElementById("search-input");
const suggestions = document.getElementById("search-suggestions");
const clearBtn = document.getElementById("search-clear");
function updateClearButton() {
  if (!clearBtn) return;
  // 検索入力欄が存在しない場合は何もしない（HTML変更時の保険）
  if (!searchInput) return;
  clearBtn.style.display = searchInput.value.trim() ? "block" : "none";
}
if (clearBtn) {
  clearBtn.addEventListener("click", () => {
    // 検索入力欄が存在しない場合は何もしない（HTML変更時の保険）
    if (!searchInput) return;
    searchInput.value = "";
    clearSuggestions();
    updateClearButton();
    // 全件に戻す（既存の×と同じ効果）
    clearSpotPanel();  
    searchInput.focus();
  });
}
function clearSuggestions() {
  // サジェスト欄が存在しない場合は何もしない（HTML変更時の保険）
  if (!suggestions) return;
  suggestions.innerHTML = "";
}
function focusMarker(entry) {
  // サジェスト経由でも、表示中のマーカー群と選択状態を一貫させる
  setVisibleEntries([entry]);
  map.flyTo(entry.marker.getLatLng(), 15);
  onSpotSelect(entry);
}
function showSuggestions(keyword) {
  clearSuggestions();
  if (!keyword) return;
  const hits = markerEntries
    .filter(e => e.name.includes(keyword))
    .slice(0, 5);
  hits.forEach(e => {
    const li = document.createElement("li");
    li.textContent = e.name;
    li.addEventListener("click", () => {
      focusMarker(e); // ←spotも渡す(地図下表示用)
      clearSuggestions();
    });
    // サジェスト欄が存在しない場合は追加しない（HTML変更時の保険）
    if (!suggestions) return;
    suggestions.appendChild(li);
  });
}
if (searchInput) {
  searchInput.addEventListener("input", () => {
    updateClearButton();
    showSuggestions(searchInput.value.trim());
  });
}
function executeSearch() {
  // 検索入力欄が存在しない場合は何もしない（HTML変更時の保険）
  if (!searchInput) return;
  const keyword = searchInput.value.trim();
  clearSuggestions();

  const matchedEntries = [];
  let firstHit = null;

  markerEntries.forEach(e => {
    if (e.name.includes(keyword)) {
      matchedEntries.push(e);
      if (!firstHit) {
        firstHit = e;
      }
    }
  });
  setVisibleEntries(matchedEntries);
  if (firstHit) {
    map.flyTo(firstHit.marker.getLatLng(), 15);
    onSpotSelect(firstHit);
  }
  updateClearButton();
}
if (searchInput) {
  searchInput.addEventListener("keydown", e => {
    if (e.key === "Enter") executeSearch();
  });
}
updateClearButton();
