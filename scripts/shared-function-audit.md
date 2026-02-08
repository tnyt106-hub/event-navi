# scripts ディレクトリ共有化・不要処理監査メモ

作成日: 2026-02-08
最終更新日: 2026-02-08

## 0. このメモの目的

- `scripts/` 配下で、過去修正の影響で残った**不要処理（未使用関数）**と、各ファイルで重複実装されている**共通化候補**を整理する。
- 「一気に全面改修」ではなく、**壊しにくい順序**で段階的に進める優先順位を明確化する。

---

## 1. 現状分析サマリ（重複が多い処理）

関数定義を横断スキャンした結果、以下の重複が目立つ。

- `stripTags`: 9 ファイルで個別実装
- `formatDate`: 6 ファイルで個別実装
- `saveEventsFile`: 6 ファイルで個別実装
- `buildDate`: 5 ファイルで個別実装
- `dedupeEvents`: 4 ファイルで個別実装

一方で、すでに `scripts/lib/` 側には以下の共通関数が存在している。

- テキスト処理: `stripTags` / `normalizeWhitespace` / `stripTagsWithLineBreaks` (`scripts/lib/text.js`)
- JSON 保存: `writeJsonPretty` / `saveEventJson` (`scripts/lib/io.js`)
- 重複排除: `dedupeEventsBySourceUrl` (`scripts/lib/dedupe.js`)

つまり、**共通基盤はあるのに移行が途中で止まっている**状態。

---

## 2. 現状分析サマリ（過去修正で不要になった可能性が高い処理）

未使用関数を機械的に洗い出したところ、少なくとも以下が「定義のみで参照なし」。

- `scripts/fetch-takamatsu_city_museum_of_art.js`
  - `extractEventBlocks`
  - `extractTitle`
  - `extractSourceUrl`
- `scripts/fetch-kenbun.js`
  - `fetchAllListPages`
- `scripts/fetch-itemehime.js`
  - `extractDate`
  - `extractTimeByLabels`
  - `extractLabeledValue`

これらは、実装の途中で抽出方式を切り替えた際に残った「旧ルート」の可能性が高い。

> 注意: 未使用判定は静的スキャン結果。削除前に 1 ファイルずつ実行し、ログと出力件数で最終確認する。

---

## 3. 修正優先順位（推奨）

### P0（最優先）: 未使用関数の削除（安全性が高く効果が大きい）

### 対象
- `fetch-takamatsu_city_museum_of_art.js` の 3 関数
- `fetch-kenbun.js` の 1 関数
- `fetch-itemehime.js` の 3 関数

### 理由
- 参照されない処理は将来の誤読・誤修正の温床になる。
- 依存がないため、影響範囲が狭く、レビュー容易性が高い。

### 具体方針
1. 1 ファイルずつ未使用関数を削除。
2. 対象スクリプトを単体実行し、イベント件数・必須キーを確認。
3. 問題なければ次ファイルへ進む。

---

### P1（高）: 既存共通関数へ「同等挙動だけ」置換

### 対象
- `stripTags` 系を `scripts/lib/text.js` に寄せる。
- `saveEventsFile` 相当を `scripts/lib/io.js` の `saveEventJson` または `writeJsonPretty` に寄せる。
- `source_url` ベース重複排除を `scripts/lib/dedupe.js` に寄せる。

### 理由
- 既存の共通化基盤を活用でき、重複削減効果が高い。
- ただし細かな挙動差（空白扱い、0件時の保存スキップ方針）があるため段階導入が必要。

### 具体方針
1. まず `stripTags` だけを対象にし、差分が小さいファイルから移行。
2. 次に保存処理を移行し、JSON のキー構造・整形・`last_success_at` の扱いを比較。
3. 最後に重複排除処理を共通化し、件数差分を監視。

---

### P2（中）: 日付処理の再統合（効果大だが壊しやすい）

### 対象
- `formatDate` / `buildDate` / `toIsoDate` / 年跨ぎ補正ロジック

### 理由
- 変換仕様の差異が混在しており、統合時に挙動変化が起きやすい。
- ただし長期保守の観点では最も共通化メリットが大きい。

### 具体方針
1. `scripts/lib/date.js` の責務を「パース」「妥当性チェック」「年跨ぎ補正」に分割して明文化。
2. 既存関数名の薄いラッパーを各 fetch 側に一時的に残し、内部だけ共通関数呼び出しへ置換。
3. 全移行後にラッパー削除。

---

## 4. 実行順（壊しにくい順）

1. **未使用関数削除（P0）**
2. **テキスト処理共通化（P1 前半）**
3. **JSON 保存処理共通化（P1 後半）**
4. **重複排除共通化（P1 後半）**
5. **日付処理統合（P2）**

---

## 5. 各ステップの受け入れ条件（Done 条件）

- スクリプト単体実行で `events.length > 0`（通常想定のサイト）
- 出力 JSON の必須キー維持: `venue_id`, `venue_name`, `events`
- `date_from`, `date_to` が `YYYY-MM-DD`
- `source_url` が空文字になっていない
- 改修前後でイベント件数の差分が説明可能

---

## 6. 直近の着手提案（最初の 1 スプリント）

- Step 1: `fetch-takamatsu_city_museum_of_art.js` の未使用 3 関数削除
- Step 2: `fetch-itemehime.js` の未使用 3 関数削除
- Step 3: `fetch-kenbun.js` の未使用 1 関数削除
- Step 4: `stripTags` 重複ファイルから 2 ファイルだけを試験的に共通化

この順であれば、**まず不要処理を減らして可読性を上げた上で共通化に入れる**ため、レビュー負荷とリスクのバランスが良い。
