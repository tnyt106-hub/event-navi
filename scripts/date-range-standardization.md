# 期間指定の共通処理化 方針メモ（scripts 配下）

## 背景

現在の `scripts` には、**同じ意図の期間フィルタ**（例: 「過去 365 日より古いイベントを除外」）が複数スクリプトに分散しています。
この状態だと、ルール変更時に修正漏れが起きやすく、保守コストが高くなります。

具体例:

- `scripts/filter-old-events.js` は `CUTOFF_DAYS = 365` で一括削除を実施。
- `scripts/fetch-mimoca.js` は `PAST_DAYS_LIMIT = 365` を独自実装で判定。
- `scripts/fetch-ehime_prefectural_museum_of_art.js` も `PAST_DAYS_LIMIT = 365` で独自判定。

## 目的

- 期間指定ロジックを共通化し、**設定値の一元管理**を実現する。
- JST 基準日の算出や ISO 日付比較を共通関数化し、**判定ゆれ**をなくす。
- 段階移行で既存挙動を壊さず、運用中スクリプトの安全性を保つ。

## 共通化の設計案

### 1) 設定値を共通化（例: `scripts/lib/date_window.js`）

以下のように「期間ポリシー」を 1 箇所に置きます。

- `DEFAULT_PAST_DAYS = 365`
- `DEFAULT_FUTURE_DAYS = 365`（将来必要なら使用）
- `TIMEZONE = "Asia/Tokyo"`（内部は既存実装に合わせ JST 0:00 の UTC Date で扱う）

> ポイント: まずは既存値（365 日）をそのまま使い、**挙動変更を起こさない**。

### 2) 日付境界計算を共通関数化

共通関数の候補:

- `getJstTodayUtcDate()`
  - JST の「今日 00:00」を UTC Date で返す。
- `buildPastCutoffDate({ pastDays })`
  - `today - pastDays` を返す。
- `isEventExpired(event, cutoffDate)`
  - `date_to`（なければ `date_from`）で削除判定。

### 3) 既存スクリプトの責務整理

- 収集系 (`fetch-*.js`) は「取得と正規化」に集中。
- 期間フィルタは、
  - A案: 各取得スクリプトが共通関数を呼ぶ
  - B案: 取得時は残し、最終的に `filter-old-events.js` へ集約

まずは差分が小さい **A案（既存位置のまま共通関数化）** が安全。
運用が安定したら B案へ寄せる。

## 移行ステップ（推奨）

1. **共通モジュール追加**
   - `scripts/lib/date_window.js` を追加し、既存ロジック相当の関数を実装。
2. **1 本だけ移行して検証**
   - 例: `fetch-mimoca.js` の閾値計算を置換。
3. **2 本目を移行**
   - `fetch-ehime_prefectural_museum_of_art.js` を置換。
4. **保守スクリプトを移行**
   - `filter-old-events.js` を同モジュール利用に変更。
5. **最終確認**
   - 出力件数・除外件数ログを比較し、差異が意図通りか確認。

## 受け入れ基準（Definition of Done）

- 期間の閾値日数は 1 箇所の設定変更だけで反映できる。
- 3 スクリプト以上で重複していた日付境界計算が削減される。
- 既存と比較して、イベント件数に意図しない大幅差分がない。
- 0 件時エラーなど既存の安全装置は維持される。

## リスクと対策

- リスク: JST/UTC の取り扱い差で 1 日ずれる。
  - 対策: `getJstTodayUtcDate()` を単体テスト化し、境界時刻（JST 00:00 前後）を検証。
- リスク: `date_to` 欠損イベントの扱い変更。
  - 対策: 既存仕様（`date_to` なければ `date_from`）を共通関数に明記して固定。
- リスク: スクリプトごとの例外ルール消失。
  - 対策: 共通関数は「デフォルト挙動」を提供し、例外はオプションで残す。

## 実装時の最小インターフェース（叩き台）

```js
// scripts/lib/date_window.js
module.exports = {
  DEFAULT_PAST_DAYS,
  getJstTodayUtcDate,
  buildPastCutoffDate,
  isEventExpired,
};
```

この構成なら、現在の個別実装を段階的に差し替えていけます。
