# events/template.json について

このディレクトリには、イベント情報の標準 JSON テンプレート `template.json` を置いています。
JSON 形式はコメントを書けないため、各項目の意味や使い方はこの README にまとめています。

## テンプレートの考え方

- `template.json` は **1 件分のイベントを配列に入れた例**です。
- 実際の運用では、`events` 配列に複数のイベントを並べてください。
- 必須・任意の区別は、`marugame_ilex.json` に合わせています。

## フィールド説明（トップレベル）

- `venue_id`
  - 会場の識別子です。
  - 例: `marugame_ilex`
- `last_success_at`
  - 最終更新日（YYYY-MM-DD 形式）です。
  - 例: `2026-02-04`
- `events`
  - イベント一覧の配列です。

## フィールド説明（events 配列の要素）

- `title`
  - イベント名です。
- `date_from`
  - 開催開始日（YYYY-MM-DD 形式）です。
- `date_to`
  - 開催終了日（YYYY-MM-DD 形式）です。
- `venue_name`
  - 会場名です。
- `description`
  - 短い概要です。不明な場合は `null` にします。
- `body`
  - 詳細本文です。不明な場合は `null` にします。
- `source_url`
  - 情報の取得元(イベント詳細ページ)の URL です。
- `open_time`
  - 開場時刻です。時間が不明な場合は `null` にします。
- `start_time`
  - 開演時刻です。時間が不明な場合は `null` にします。
- `end_time`
  - 終演時刻です。時間が不明な場合は `null` にします。
- `price`
  - 料金情報です。不要な場合は `null` にします。
- `contact`
  - 問い合わせ先です。不要な場合は `null` にします。
- `tags`
  - 分類用の情報です。
  - `type`: イベント種別（例: `performance` / `festival` / `other`）
  - `genres`: ジャンルの配列（例: `["music"]`）
  - `flags`: 補足フラグの配列（例: `["free"]`）
