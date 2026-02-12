// 日付ページで `?event=イベント名&venue=会場名` が渡された場合、
// 対象カードまで自動スクロールして利用者が迷わないようにする。
(function highlightEventCardFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const eventName = (params.get("event") || "").trim();
  const venueName = (params.get("venue") || "").trim();
  if (!eventName) return;

  const cards = Array.from(document.querySelectorAll(".spot-event-card"));

  // クエリの値とカード本文を正規化し、余計な空白差異で一致失敗しないようにする。
  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const normalizedEventName = normalizeText(eventName);
  const normalizedVenueName = normalizeText(venueName);

  const matchedCard = cards.find((card) => {
    // 生成時に埋め込んだ data 属性を優先して比較し、表示文言変更の影響を受けにくくする。
    const dataTitle = normalizeText(card.getAttribute("data-event-name") || "");
    const dataVenue = normalizeText(card.getAttribute("data-event-venue") || "");

    if (dataTitle) {
      if (dataTitle !== normalizedEventName) return false;
      if (!normalizedVenueName) return true;
      return dataVenue === normalizedVenueName;
    }

    // 旧HTMLとの互換のため、data 属性がない場合だけテキスト一致にフォールバックする。
    const title = card.querySelector(".spot-event-card__title")?.textContent || "";
    const venueText = card.querySelector(".spot-event-card__venue")?.textContent || "";
    const normalizedTitle = normalizeText(title);
    const normalizedVenue = normalizeText(venueText.replace(/^会場:\s*/, ""));

    if (normalizedTitle !== normalizedEventName) return false;
    if (!normalizedVenueName) return true;
    return normalizedVenue === normalizedVenueName;
  });

  if (!matchedCard) return;

  // 視覚的にも見つけやすいよう、対象カードに一時ハイライトを付与する。
  matchedCard.classList.add("spot-event-card--focus");
  matchedCard.setAttribute("tabindex", "-1");
  matchedCard.focus({ preventScroll: true });
  matchedCard.scrollIntoView({ behavior: "smooth", block: "center" });
})();
