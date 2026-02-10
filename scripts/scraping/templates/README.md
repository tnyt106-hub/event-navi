# スクレイピング共通テンプレート

本ディレクトリには、**新規施設を安全・高速に追加するための共通テンプレート**を置いています。
既存施設の挙動や JSON 構造、run-all 運用は壊さない方針です。

## テンプレの使い分け

- **listing-only**: 一覧ページだけで `title / date / url` が完結する施設向け
  - 詳細ページへアクセスしない
- **listing-plus-detail**: 一覧 → 詳細ページの2段構成施設向け
  - 一覧で詳細 URL を集め、詳細を1回だけ取得

## 新規施設追加の完全手順（コピペ運用）

1. **テンプレをコピー**
   - 一覧だけの施設 → `fetch-template-listing-only.js`
   - 詳細が必要な施設 → `fetch-template-listing-plus-detail.js`
2. **置き換える項目を埋める**
   - `VENUE_ID`（例: `takamatsu_city_museum`）
   - `ENTRY_URL` / `LIST_URL`
   - `OUTPUT_PATH`
   - HTML から抽出するロジック（`extractListItems` / `extractDetailLinks` / `extractEventFromDetail`）
3. **単体で node 実行**
   ```bash
   node scripts/scraping/fetch-<venue_id>.js
   ```
4. **run-all.config.json に task を追加**
   - `outputs` は必須（run-all が差分判定に使うため、省略不可）
   ```json
   {
     "id": "<venue_id>",
     "script": "scripts/scraping/fetch-<venue_id>.js",
     "enabled": true,
     "outputs": ["docs/events/<venue_id>.json"]
   }
   ```
5. **run-all 実行**
   ```bash
   node scripts/common/run-all.js
   ```

## body の扱い（条件付き）

- **原則 body は入れない**
- 次の構造化項目がすべて空の場合のみ `body` を入れてよい
  - `open_time`
  - `start_time`
  - `end_time`
  - `price`
  - `contact`
- `body` は **最大 5000 文字**
  - 改行単位でトリムし、どうしても超える場合は末尾カット + `…`

## 0件時の扱い

- `events.length === 0` の場合は **`process.exit(1)`**
- その際、必ず以下をログ出力する
  - `found_links`（または `list_links`）
  - `excluded_invalid`
  - `events_built`
  - `output_path`

## listing-plus-detail で一覧が複数ページ/複数月に分かれる場合

- 月別一覧 URL（例: `/event/date/YYYY/MM/`）を抽出して巡回する
  - 月別 URL は **正規化して重複巡回を防ぐ**
    - 末尾 `/` を統一
    - 月は 2 桁（`MM`）に統一
    - http/https の揺れがある場合はどちらかに統一
  - `page/2/` のような URL が 500 になるサイトがあるため、**月別 URL は pathname の完全一致で判定する**
- 過去/未来の対象期間を日数で制限する（例: 過去 365 日 / 未来 365 日）
- 巡回ログとして以下を出力する
  - `list_pages`
  - `list_links`
  - `detail_links_unique`
- kenbun（愛媛県県民文化会館）でのログ例（抜粋）
  - `month_range: 2025-02 .. 2027-02`
  - `list_pages: 25`
  - `detail_links_unique: xxx`
  - `events_built: xxx`

## テンプレ共通の取得方針

- HTTP 取得は `fetchText` を利用
- `acceptEncoding: "identity"`
- `encoding: "utf-8"`（Shift_JIS だけ明示）
- JSON 保存は `writeJsonPretty`

## Troubleshooting

- **文字化けする** → `encoding` を確認（Shift_JIS なら明示）
- **圧縮崩れする** → `acceptEncoding: "identity"` を指定
- **古いイベントが消える** → `filter-old-events.js` の past filter を確認

## 期間指定の共通化方針

- 期間フィルタ（過去 N 日など）の共通化方針は `scripts/date-range-standardization.md` を参照。
