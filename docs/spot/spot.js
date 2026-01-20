// spot.js はスポット詳細ページの描画を担当する
// 依存を最小限にして、GitHub Pages でも動作するようにしている

// URL から spot_id を取得する
const params = new URLSearchParams(window.location.search);
const spotId = params.get("spot_id");

// 描画に使うDOMをまとめて取得する
const errorSection = document.getElementById("spot-error");
const contentSection = document.getElementById("spot-content");
const titleElement = document.getElementById("spot-title");
const introElement = document.getElementById("spot-intro");
const categoryElement = document.getElementById("spot-category");
const areaElement = document.getElementById("spot-area");
const googleLinkElement = document.getElementById("spot-google-link");

// meta description を更新するための取得（存在しない場合は null になる）
const metaDescription = document.querySelector('meta[name="description"]');

// 要素の表示/非表示を一貫させるためのヘルパー
function toggleElement(element, isVisible) {
  if (!element) return;
  element.hidden = !isVisible;
}

// テキストをセットしつつ、空なら非表示にする
function setTextOrHide(element, value) {
  if (!element) return;
  if (value) {
    element.textContent = value;
    element.hidden = false;
  } else {
    element.textContent = "";
    element.hidden = true;
  }
}

// 改行や空白を整えて、表示に使える文字列へ整形する
function normalizeText(value) {
  if (!value) return "";
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 紹介文を汎用テンプレートで作成する（系統別分岐はしない）
function buildIntroText(spot) {
  // 必須ではない項目は、存在するものだけ使う
  const name = spot.name ? spot.name : "名称不明";
  const municipality = spot.municipality ? spot.municipality : "";
  const categoryLabel = spot.category ? spot.category : "スポット";

  // 1段目（短文：2文以内）
  const firstSentence = municipality
    ? `${name}は、${municipality}にある${categoryLabel}スポットです。`
    : `${name}は、${categoryLabel}スポットです。`;
  const secondSentence = "周辺での立ち寄り先として利用しやすい場所です。";

  // 2段目（補足：2〜4文）
  const supplementSentences = [
    municipality
      ? `${municipality}周辺での外出や用事の合間に訪れやすく、食事や休憩など幅広い目的で利用できます。`
      : "外出や用事の合間に訪れやすく、食事や休憩など幅広い目的で利用できます。",
    "営業時間や混雑状況は日によって変わるため、訪問前に地図サービスで最新情報を確認するのがおすすめです。",
    "写真や口コミを参考にすると、現地の雰囲気をつかみやすくなります。",
  ];

  // 2段構成で文章を組み立てる（改行は CSS で表示）
  const shortParagraph = [firstSentence, secondSentence].join("");
  const supplementParagraph = supplementSentences.join("");
  let introText = `${shortParagraph}\n${supplementParagraph}`;

  // 文字数が長い場合は補足文を短縮して目安に収める
  const maxLength = 300;
  const minLength = 150;
  if (introText.length > maxLength) {
    for (let i = supplementSentences.length - 1; i >= 1; i -= 1) {
      const reducedSupplement = supplementSentences.slice(0, i).join("");
      const candidate = `${shortParagraph}\n${reducedSupplement}`;
      if (candidate.length <= maxLength) {
        introText = candidate;
        break;
      }
    }
  }

  // 150字未満の場合でも分岐はせず、そのまま返す
  if (introText.length < minLength) {
    return introText;
  }

  return introText;
}

// エラー表示に切り替える（spot_id 不正やデータ取得失敗時）
function showError(message) {
  if (errorSection) {
    const messageElement = errorSection.querySelector(".spot-error__text");
    if (messageElement && message) {
      messageElement.textContent = message;
    }
  }
  toggleElement(errorSection, true);
  toggleElement(contentSection, false);
}

// spot_id が無い場合は早めにエラーを出す
if (!spotId) {
  showError("スポットIDが指定されていません。トップページから再度お試しください。");
} else {
  // データを取得して、該当するスポットを描画する
  fetch("../data/spots.json")
    .then((response) => {
      if (!response.ok) {
        throw new Error("spots.json not found");
      }
      return response.json();
    })
    .then((spots) => {
      if (!Array.isArray(spots)) {
        throw new Error("spots data is invalid");
      }

      // spot_id が一致するデータを探す
      const spot = spots.find((item) => String(item.spot_id) === String(spotId));
      if (!spot) {
        showError("該当するスポットが見つかりませんでした。");
        return;
      }

      // 表示をメインコンテンツに切り替える
      toggleElement(errorSection, false);
      toggleElement(contentSection, true);

      const spotName = spot.name ?? "名称不明";
      setTextOrHide(titleElement, spotName);

      // カテゴリは # を付けて表示する
      setTextOrHide(categoryElement, spot.category ? `#${spot.category}` : "");

      // 自治体の表示は pref/municipality を連結する
      const areaText =
        spot.prefecture || spot.municipality
          ? `${spot.prefecture ?? ""}${spot.municipality ? ` ${spot.municipality}` : ""}`.trim()
          : "";
      setTextOrHide(areaElement, areaText);

      // 紹介文は description を優先し、無い場合は自動生成する
      const normalizedDescription = normalizeText(spot.description);
      const introText = normalizedDescription || buildIntroText(spot);
      setTextOrHide(introElement, introText);

      // Google マップへのリンクを生成する
      if (googleLinkElement) {
        let googleUrl = "";
        if (spot.google_url) {
          googleUrl = spot.google_url;
        } else if (spot.lat && spot.lng) {
          googleUrl = `https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lng}`;
        }
        if (googleUrl) {
          googleLinkElement.href = googleUrl;
          googleLinkElement.hidden = false;
        } else {
          googleLinkElement.hidden = true;
        }
      }

      // タイトルと meta description をスポットに合わせて更新する
      document.title = `${spotName}｜四国おすすめスポットマップ`;
      if (metaDescription) {
        const descriptionText = introText
          ? introText.replace(/\n/g, " ")
          : `${spotName}の詳細ページです。`;
        metaDescription.setAttribute("content", descriptionText);
      }
    })
    .catch((error) => {
      console.error(error);
      showError("スポット情報の取得に失敗しました。時間をおいて再度お試しください。");
    });
}
