# 期間指定の共通化方針（スクレイピング）

このファイルは、各 fetch スクリプトで日付範囲ロジックを実装する際の最小方針をまとめたものです。

- 基準日は `today` を 1 箇所で作る。
- `PAST_DAYS_LIMIT` / `FUTURE_DAYS_LIMIT` を定数化し、マジックナンバーを避ける。
- 月別巡回を行う場合は、URL 正規化（末尾 `/`・月の 2 桁化）を行う。
- `MAX_LIST_PAGES` を設け、無限巡回を防ぐ。
- ログには最低限 `month_range` / `list_pages` / `list_links` / `events_built` を出す。
