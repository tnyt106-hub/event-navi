(function () {
  "use strict";

  // サイト全体で使うGA4測定IDはここだけで管理する。
  // 測定IDを変更する場合は、この定数のみ差し替えれば全ページへ反映できる。
  var MEASUREMENT_ID = "G-RS12737WLG";
  // 多重初期化を防ぐための状態フラグ。
  var initialized = false;

  // gtag.js を動的に読み込み、計測用のグローバル関数を準備する。
  function ensureGa4Initialized() {
    if (initialized) {
      return;
    }

    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function gtag() {
      window.dataLayer.push(arguments);
    };

    // scriptタグを二重挿入しないよう、srcで既存タグを確認する。
    var existingScript = document.querySelector(
      'script[src="https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID + '"]'
    );
    if (!existingScript) {
      var gtagScript = document.createElement("script");
      gtagScript.async = true;
      gtagScript.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(MEASUREMENT_ID);
      document.head.appendChild(gtagScript);
    }

    window.gtag("js", new Date());
    // page_view はページごとに明示送信する設計のため自動送信を無効化する。
    window.gtag("config", MEASUREMENT_ID, { send_page_view: false });
    initialized = true;
  }

  // ページ表示イベントを送信する共通関数。
  function trackPageView(pagePath, pageTitle) {
    if (!pagePath || !pageTitle) {
      return;
    }

    ensureGa4Initialized();
    window.gtag("event", "page_view", {
      page_path: String(pagePath),
      page_title: String(pageTitle)
    });
  }

  // 各HTMLから呼び出せるようにグローバル公開する。
  window.EventNaviAnalytics = {
    trackPageView: trackPageView
  };
})();
