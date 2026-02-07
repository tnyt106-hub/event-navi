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
// 地図下スポット表示欄
// =======================
function renderSpotPanel(spot) {
  const panel = document.getElementById("spot-panel");
  if (!panel) return; // HTML側が未設置なら何もしない
  const title = panel.querySelector(".spot-panel__title");
  const cat = document.getElementById("spot-panel-category");
  const area = document.getElementById("spot-panel-area");
  const desc = document.getElementById("spot-panel-desc");
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
  if (desc) desc.textContent = spot.description ?? "";
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
// 地図下スポット閉じる
// =======================
function clearSpotPanel() {
  const panel = document.getElementById("spot-panel");
  if (!panel) return;
  panel.classList.add("is-empty");
  panel.classList.remove("is-expanded");
  const title = panel.querySelector(".spot-panel__title");
  if (title) title.textContent = "スポット未選択";
  const cat = document.getElementById("spot-panel-category");
  const area = document.getElementById("spot-panel-area");
  const desc = document.getElementById("spot-panel-desc");
  if (cat) cat.textContent = "";
  if (area) area.textContent = "";
  if (desc) desc.textContent = "";
  // 公式サイトボタンは未選択時に非表示にする
  const official = document.getElementById("spot-panel-official");
  if (official) official.style.display = "none";
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
function setVisibleEntries(entries) {
  // 検索やリセットのたびに「いま表示しているマーカー群」を同期する
  visibleEntries = entries;
  markers.clearLayers();
  visibleEntries.forEach(e => markers.addLayer(e.marker));
}
function onSpotSelect(entry) {
  // ピン/ラベルのどちらからでも同一の選択処理にする（挙動の統一）
  if (!entry) return;
  pinnedEntry = entry;
  entry.marker.openPopup();
  renderSpotPanel(entry.spot);
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
      const popupContent = createPopupContent(s);
      // ラベル位置をピン中央に合わせるため、tooltipAnchor調整済みアイコンを使う
      const marker = L.marker([s.lat, s.lng], { icon: centeredTooltipIcon }).bindPopup(popupContent);
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
    });
        map.addLayer(markers);
        setVisibleEntries(markerEntries);
        // 初回描画時にもズーム値に応じたラベル表示へ合わせる
        updateSpotLabelVisibility();
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
