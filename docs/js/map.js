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
// スポット名ラベルは「拡大時のみ表示」にするため、閾値を定数化しておく
const SPOT_LABEL_MIN_ZOOM = 12;
// 要件: ピン選択時はこのズーム値まで寄せて、施設位置を把握しやすくする
const SPOT_FOCUS_ZOOM = 14;
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
// デフォルトのtooltipAnchorは右上寄りなので、ピンの真上にラベルが来るよう補正する
const centeredTooltipIcon = new L.Icon.Default({
  tooltipAnchor: [0, -28]
});
// =======================
// 検索ボックス用
// =======================
let allSpots = [];
let markerEntries = [];
let visibleEntries = [];
let pinnedEntry = null; // 直前に選択されたスポットを保持して、次のピン操作まで固定する
const TODAY_EVENTS_VISIBLE_LIMIT = 5; // 要件: 初期表示は5件
let todayEventsAll = []; // 「本日開催中イベント」の全件（もっと見るで切替に使う）
let todayEventsExpanded = false; // もっと見るの開閉状態
const markerEntryBySpotId = new Map(); // 一覧カードから地図ピンへ移動するための逆引き
const INITIAL_SPOT_ID = getInitialSpotIdFromUrl(); // URL共有で復元する初期選択ID

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

// 要件: 「現在時刻の日が開催日と一致」するイベントのみ抽出する
function isEventHeldToday(eventItem, today) {
  const startDay = parseDateStringAsLocalDay(eventItem?.date_from);
  const endDay = parseDateStringAsLocalDay(eventItem?.date_to) || startDay;
  if (!startDay || !endDay) return false;
  return startDay <= today && today <= endDay;
}

// 一覧表示件数(5件 or 全件)に応じて表示対象を返す
function getVisibleTodayEvents() {
  if (todayEventsExpanded) return todayEventsAll;
  return todayEventsAll.slice(0, TODAY_EVENTS_VISIBLE_LIMIT);
}

// 「もっと見る」ボタンの表示/文言を同期する
function updateTodayEventsMoreButton() {
  const moreButton = document.getElementById("today-events-more");
  if (!moreButton) return;
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
    status.textContent = "本日開催中のイベントは見つかりませんでした。";
    updateTodayEventsMoreButton();
    return;
  }

  status.textContent = `本日開催中 ${todayEventsAll.length}件（イベント名50音順）`;

  getVisibleTodayEvents().forEach((item) => {
    const li = document.createElement("li");
    li.className = "today-events__item";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "today-events__button";
    button.dataset.spotId = item.spotId || "";
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", `${item.title}（${item.prefecture || "県情報なし"} / ${item.venueName}）の地図ピンを表示`);
    button.addEventListener("click", () => {
      focusSpotFromTodayEvent(item.spotId);
    });

    const title = document.createElement("p");
    title.className = "today-events__name";
    title.textContent = item.title;

    const meta = document.createElement("p");
    meta.className = "today-events__meta";
    meta.textContent = `${item.prefecture || "県情報なし"} / ${item.venueName}`;

    button.appendChild(title);
    button.appendChild(meta);
    li.appendChild(button);
    list.appendChild(li);
  });

  updateTodayEventsMoreButton();
  // 一覧描画後に現在の選択状態を再適用し、再描画時の強調消失を防ぐ
  setTodayEventActiveSpot(pinnedEntry?.spot?.spot_id || "");
}

// 各施設のイベントJSONを読み込み、「本日開催中イベント」を組み立てる
async function loadTodayEvents(spots) {
  const status = document.getElementById("today-events-status");
  const today = getCurrentLocalDay();
  const fetchTargets = spots.filter((spot) => spot?.spot_id);

  const eventLists = await Promise.all(fetchTargets.map(async (spot) => {
    try {
      const response = await fetch(`./events/${encodeURIComponent(spot.spot_id)}.json`);
      if (!response.ok) return [];
      const json = await response.json();
      const events = Array.isArray(json?.events) ? json.events : [];
      return events
        .filter((eventItem) => isEventHeldToday(eventItem, today))
        .map((eventItem) => ({
          title: eventItem?.title ? String(eventItem.title).trim() : "名称不明イベント",
          prefecture: spot.prefecture ? String(spot.prefecture).trim() : "",
          venueName: spot.name ? String(spot.name).trim() : "会場名不明",
          spotId: spot.spot_id,
        }));
    } catch (error) {
      // 1施設分の読み込み失敗で全体が止まらないようにし、他施設の表示を優先する
      console.error(`イベントJSONの読み込みに失敗: ${spot.spot_id}`, error);
      return [];
    }
  }));

  todayEventsAll = eventLists
    .flat()
    // 要件: イベント名50音順（日本語ロケールで比較）
    .sort((a, b) => a.title.localeCompare(b.title, "ja"));

  todayEventsExpanded = false;
  renderTodayEvents();

  if (status && todayEventsAll.length > 0) {
    status.setAttribute("data-loaded", "true");
  }
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
    const markerElement = entry.marker.getElement();
    if (!markerElement) return;
    const isSelected = pinnedEntry === entry;
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
  // 選択中のピンを視覚的に目立たせる
  syncSelectedMarkerVisual();
  // 要件対応: ピン直上のLeafletポップアップは表示しない（下部パネルのみを使う）
  entry.marker.closePopup();
  renderSpotPanel(entry.spot);
  // 仕様: 一覧側にも選択状態を反映して、双方向連動を成立させる
  setTodayEventActiveSpot(entry.spot?.spot_id || "");
  // 仕様: 共有URLで同じ施設を再表示できるよう、spot_idをクエリへ保存する
  syncSelectedSpotToUrl(entry.spot?.spot_id || "");
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
function createMarkerLabelText(spot) {
  // ラベル用の表示名は「不明」になる時も一貫して出す（初心者向けに分かりやすく）
  return spot.name ?? "名称不明";
}
function updateSpotLabelVisibility() {
  // 地図のズーム値に応じてラベルの表示/非表示を切り替える
  // zoom < 12 のときはラベルを非表示にして、縮小表示時の可読性を確保する
  const shouldShowLabel = map.getZoom() >= SPOT_LABEL_MIN_ZOOM;
  const mapElement = map.getContainer();
  if (!mapElement) return;
  mapElement.classList.toggle("hide-spot-labels", !shouldShowLabel);
}
// ズーム操作のたびにラベル表示状態を同期する
map.on("zoomend", updateSpotLabelVisibility);
// 要件変更: ピン以外（地図の余白）をクリックしても状態は変えない
// 以前は clearSpotPanel() で初期表示へ戻していたが、ユーザー操作の意図とズレるため廃止
setupTodayEventsMoreButton();
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
      // ラベル位置をピン中央に合わせるため、tooltipAnchor調整済みアイコンを使う
      // 要件対応: ピン選択時の情報表示は下部パネルに一本化するため、ポップアップ自体は生成しない
      const marker = L.marker([s.lat, s.lng], { icon: centeredTooltipIcon });
      // マーカー上にスポット名を常時表示（絞り込み後も表示中のマーカーのみ出る）
      marker.bindTooltip(createMarkerLabelText(s), {
        permanent: true,
        direction: "top",
        className: "spot-label",
        offset: [0, 0],
        opacity: 0.9,
        interactive: true
      });
      const entry = { marker, name: s.name ?? "", spot: s };
      marker.on("click", () => onSpotSelect(entry)); // 地図下表示用
      marker.on("tooltipopen", (event) => {
        // ラベルDOMが生成されたタイミングでクリック操作を紐付ける
        const tooltipElement = event.tooltip?.getElement();
        if (!tooltipElement) return;
        if (tooltipElement.dataset.clickBound === "true") return;
        tooltipElement.dataset.clickBound = "true";
        tooltipElement.addEventListener("click", () => {
          onSpotSelect(entry);
        });
      });
      markers.addLayer(marker);

     markerEntries.push(entry);//検索ボックス用
      if (s.spot_id) markerEntryBySpotId.set(s.spot_id, entry); // 一覧カードから地図ピンを参照するために保持
    });
        map.addLayer(markers);
        setVisibleEntries(markerEntries);
        // 初回描画時にもズーム値に応じたラベル表示へ合わせる
        updateSpotLabelVisibility();
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
