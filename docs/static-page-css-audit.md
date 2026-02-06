# 静的ページのCSSトーン統一チェック（フォント・色）

作成日: 2026-02-06

## 結論（要約）
- 公開用の静的ページ（`docs/index.html` / `docs/spot/index.html` / `docs/facility/**/index.html` / `docs/date/**/index.html`）は、共通スタイルシート `docs/css/style.css` を参照しており、**フォントと配色のトーンは概ね統一されています**。
- トーン統一の基準値は CSS カスタムプロパティ（`--font`, `--bg-gradient`, `--text`, `--accent` など）として `:root` に集約されており、再利用される設計です。

## 確認したポイント

### 1) フォント統一
- `docs/css/style.css` で `--font` にフォントスタックを定義。
- `body` に `font-family: var(--font);` を指定しており、ページ全体のフォントトーンを統一。

### 2) 色トーン統一
- `:root` に以下の主要色を定義し、各コンポーネントで変数参照。
  - 背景: `--bg`, `--bg-gradient`, `--surface`
  - 文字色: `--text`, `--text-sub`, `--text-note`, `--text_white`
  - アクセント: `--accent`, `--accent-soft`
  - 枠線/影: `--border`, `--shadow-*`
- ボタン、カード、フッター、パンくず、詳細パネル等で上記変数が利用されており、見た目の一貫性を担保。

### 3) 静的ページの共通CSS参照
- ほぼすべての公開HTMLで `style.css` を読み込み。
- 例:
  - ルート: `docs/index.html` -> `css/style.css`
  - 1階層下: `docs/spot/index.html`, `docs/facility/index.html` -> `../css/style.css`
  - 2階層下: `docs/facility/<pref>/index.html`, `docs/date/<yyyy-mm-dd>/index.html` -> `../../css/style.css`

## 補足（軽微な注意点）
- `docs/index.html` のみ `h2` に `style="display:none;"` のインラインスタイルが1箇所あります（色・フォント指定ではないため、トーンへの影響はほぼなし）。
- `docs/partials/date-ad.html` は「ページ部品」なので単体では `style.css` を参照しません（埋め込み先ページ側で統一されます）。
- 一部にハードコード色（例: `#fff`, `#333`, `#f4f4f4`）がありますが、地図UIの局所要素で、全体トーンを大きく崩すほどではありません。

## 総評
- 現状は、デザイン変数中心の実装になっており、静的ページ間のフォント・色トーンは統一運用できています。
- 今後さらに厳密に統一するなら、局所的なハードコード色を順次 `:root` 変数へ寄せる運用を推奨します。
