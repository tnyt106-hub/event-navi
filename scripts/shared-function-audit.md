# scripts ディレクトリ共有化・ハードコード監査メモ

作成日: 2026-02-08
最終更新日: 2026-02-08

## 1) 共有関数化できる処理（安全性を加味した優先度順）

### 優先度 P0（最優先: 挙動変更を最小化しつつ不具合リスクを下げる）

#### P0-1. `generate-date-pages.js` の同名関数二重定義を解消
- `formatDateWithWeekday` が同一ファイル内で二重定義されており、後勝ちで上書きされる状態。
- この状態は「意図しない関数差し替え」が起きうるため、機能追加より先に解消すべき。
- **安全策**: まず重複定義を1つに統一し、入力/出力（`YYYY-MM-DD（曜）`）が変わらないことを確認する。

#### P0-2. 既存の共通関数がある箇所だけを置換（局所置換）
- `stripTags` / `normalizeWhitespace` / `stripTagsWithLineBreaks` は `scripts/lib/text.js` ですでに共通化済み。
- ローカル実装を一気に統合せず、**挙動が同等の箇所のみ**段階的に置換する。
- **安全策**: 1スクリプト単位で置換→実行確認→次へ進む。

### 優先度 P1（高: 影響範囲が広いが、段階適用で安全に進められる）

#### P1-1. 日付処理の共通化
- `toIsoDate` / `formatDate` / `buildDate` / 年跨ぎ補正ロジックが複数スクリプトに分散。
- `scripts/lib/date.js` と `scripts/lib/date_window.js` を中核に寄せる。
- **安全策**:
  - 既存の入力フォーマット（`YYYY年M月D日`、`M/D`、範囲表記）を先に棚卸し。
  - 互換レイヤー（旧関数名で共通関数を呼ぶ薄いラッパー）を先に導入。

#### P1-2. JSON保存処理の共通化
- `saveEventsFile` が各 fetch で重複。
- `scripts/lib/io.js` の `writeJsonPretty` / `saveEventJson` をベースに、共通ペイロード生成を追加する余地あり。
- **安全策**: 出力キー順・`last_success_at` 形式・改行有無が変わらないよう snapshot 比較する。

### 優先度 P2（中: 効果は大きいが、差分が広がりやすい）

#### P2-1. `source_url` 重複排除の完全統一
- `scripts/lib/dedupe.js` 利用済み/未利用が混在。
- `fetch-kenbun.js` 等のローカル `dedupeEvents` を段階置換可能。
- **安全策**: 重複判定キーを `source_url` に固定し、件数差分をログ比較する。

#### P2-2. SEOヘッダ/フッタのテンプレート共通化
- `generate-date-pages.js` と `generate-facility-pages.js` でヘッダ/フッタ実装が類似。
- 共通化の価値は高いが、HTML出力差分が大きくなりやすい。
- **安全策**: 先に `escapeHtml` など小粒関数のみ共通化し、HTML全体テンプレ共通化は後段で実施。

---

## 2) 「本体で変数化すべき」ハードコード候補（安全優先順）

### 優先度 A（先に対応）
- `generate-date-pages.js`
  - `buildOtherBodyText` の `maxLength = 300`。
  - `normalizeDateRange` の `31日` 制限。
  - `formatDateWithWeekday` 二重定義（ハードコードというより構造不整合）。
- 理由: 閾値や関数構造が分散していると、修正時に差し替え漏れが起きやすい。

### 優先度 B（次に対応）
- `generate-date-pages.js` / `generate-facility-pages.js` の `© 2026` 固定。
- 理由: 年更新漏れリスクは高いが、即時の処理破壊リスクはAより低い。

### 優先度 C（計画対応）
- `fetch-kenbun.js` の `normalizeMonthUrl` 内で URL を直接組み立て。
- 理由: ドメイン変更時の保守性に影響するが、現行稼働への即時影響は限定的。

---

## 3) 安全に進める実装順（壊さないための実行計画）

1. **P0対応**: `generate-date-pages.js` の二重定義解消（最小差分）。
2. **P0/P1対応**: `text.js` の既存共通関数へ局所置換（1ファイルずつ）。
3. **P1対応**: 日付共通化（互換ラッパー方式で段階移行）。
4. **P1対応**: JSON保存共通化（出力差分比較を必須化）。
5. **P2対応**: dedupe/SEOテンプレの広域共通化。
6. 各段階で `run-all` ではなく、対象スクリプト単体実行で影響を局所確認してから次へ進む。

---

## 4) チェックリスト（各変更で必ず実施）

- [ ] 対象スクリプトのイベント件数が想定範囲内か。
- [ ] `date_from` / `date_to` 形式が `YYYY-MM-DD` を維持しているか。
- [ ] `source_url` の重複排除結果が悪化していないか。
- [ ] 出力JSONの必須キー（`venue_id`, `last_success_at`, `events`）が保持されているか。
- [ ] HTML生成スクリプトは title/description/canonical が欠落していないか（SEO観点）。

---

## 5) 補足（今回見つかった不整合）

- `generate-date-pages.js` で `formatDateWithWeekday` が二重定義されているため、後勝ちで上書きされる。
  - 意図しない動作差の温床になりうるため、**最優先（P0）**で1つに統一推奨。
