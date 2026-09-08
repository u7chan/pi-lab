# Prompt-cache savings footer PoC

Issue #3 の PoC です。リポジトリ直下からこのディレクトリへ移動します。

```sh
cd cache-savings
```

明示的に拡張を読み込んで起動する場合:

```sh
pi --extension ./.pi/extensions/cache-savings.ts
```

`cache-ttl` PoC と同時に読み込んでも競合しません(footer の status key が異なり、
PR #2 の cache status 分類には一切触れません)。

## 表示

assistant レスポンスの `usage.cacheRead` が正のとき、footer に次の segment を追加します。

```text
SAVED 200k tok ~$0.03
SAVED 1.5k tok
```

`SAVED` ラベルが accent 色、残りが dim 色です。表示は常に「最新のレスポンス」の値で、
cache hit のないレスポンスが完了すると segment は消えます。session 切り替え、
model 切り替え、shutdown でも消えます(数値は特定の 1 レスポンスと model の
単価に紐づくためです)。

## 推定式

provider がキャッシュした prefix は input 単価ではなく cache-read 単価で課金されます。
そこで節約額は次のように推定します。

```text
savings = (inputRate - cacheReadRate) / 1e6 * cacheReadTokens * serviceTierMultiplier
```

- 単価は model catalogue の `cost` ($/M tokens) を使います。
- リクエスト全体の input 使用量 (`input + cacheRead + cacheWrite`) が
  tier 適用しきい値を超えるときは、pi-ai の `calculateCost` と同じ選択規則で
  tier の単価へ置き換えます (tier はリクエスト全体に適用されます)。
- `serviceTierMultiplier` は Pi が `usage.cost` に既に織り込んだ multiplier を、
  catalogue の期待値との比から復元します (flex 0.5x / priority 2x / 2.5x など)。

## 金額を表示しない条件

金額は推定値 (`~`) としてのみ表示し、次の場合は token 数だけを表示します。
誤解を招く `$0.00` は決して表示しません。

- model / `cost` が取得できない、単価が欠落・非数・負。
- input 単価が 0 (無料モデル)。
- 実際の課金と catalogue が矛盾 (例: catalogue は `cacheRead: 0` なのに
  provider が課金していた、逆に catalogue は有料なのに `usage.cost.cacheRead`
  が 0 だった)。この場合 cache-read 単価の実態が不明なため推定の基礎がない。
- 節約額が 0 以下 (input 単価 == cache-read 単価など)。

既知の限界:

- DeepSeek のオフピーク割引のように、時間帯で実単価が変わる provider 固有の
  料金には追従しません。catalogue 単価に基づく推定です。
- catalogue 単価が実態より古い場合、multiplier の復元がその差を吸収します
  (正の範囲では概算として妥当ですが、正確な請求額の主張ではありません)。
- cache-read が無料 (`cacheRead: 0`) の model では、cost breakdown から
  service tier の multiplier を復元できないため、標準 tier として概算します。

## 実装

- `src/cache-savings-core.ts`: 推定・フォーマット・controller の純粋実装。
  Pi ランタイムに依存しないため、テストや他 harness からも使えます。
- `.pi/extensions/cache-savings.ts`: `session_start` / `message_end` /
  `model_select` / `session_shutdown` を controller に橋渡しするだけの adapter。
  `message_end` では `ctx.model` の pricing を渡します。

テスト:

```sh
cd cache-savings
bun test
```

pricing が利用可能なケース、利用できないケース、tier 適用のケース、
service-tier multiplier、課金と catalogue の矛盾、controller の lifecycle を
カバーしています。
