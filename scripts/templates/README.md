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
   node scripts/fetch-<venue_id>.js
   ```
4. **run-all.config.json に task を追加**
   - `outputs` は必須（run-all が差分判定に使うため、省略不可）
   ```json
   {
     "id": "<venue_id>",
     "script": "scripts/fetch-<venue_id>.js",
     "enabled": true,
     "outputs": ["docs/events/<venue_id>.json"]
   }
   ```
5. **run-all 実行**
   ```bash
   node scripts/run-all.js
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

## テンプレ共通の取得方針

- HTTP 取得は `fetchText` を利用
- `acceptEncoding: "identity"`
- `encoding: "utf-8"`（Shift_JIS だけ明示）
- JSON 保存は `writeJsonPretty`

## Troubleshooting

- **文字化けする** → `encoding` を確認（Shift_JIS なら明示）
- **圧縮崩れする** → `acceptEncoding: "identity"` を指定
- **古いイベントが消える** → `filter-old-events.js` の past filter を確認
