# Prompt-cache savings footer PoC

Issue #3 の PoC です。リポジトリ直下からこのディレクトリへ移動します。

```sh
cd u7chan-lab-cache-savings
```

## インストール

リポジトリ直下の Pi package に含まれています。

```sh
pi install git:github.com/u7chan/pi-lab@main
```

package は `u7chan-lab-*` の 4 拡張をまとめて配布します。この拡張だけを使う場合は
`pi config` で他を OFF にしてください。更新は `pi update --extensions` です。

開発中に単体で試す場合は、このディレクトリから `pi` を起動すると project 拡張として
自動読み込みされます (ディレクトリが trust 済みの場合)。任意のディレクトリからは:

```sh
pi --extension /path/to/pi-lab/u7chan-lab-cache-savings/.pi/extensions/cache-savings.ts
```

拡張が `../../src/cache-savings-core.ts` を相対 import するため、**ファイル単体の
symlink (`~/.pi/agent/extensions/u7chan-lab-cache-savings.ts`) は読み込みに失敗します**
(`Cannot find module '../../src/cache-savings-core.ts'`)。リポジトリをチェックアウトし、
package か project 拡張として読み込んでください。

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

## 本体 footer の usage 行との違い

Pi 本体の footer にも token 統計とコストの行が組み込みで表示されます
(`↑178 ↓141 R13k CH99.0% $0.000 0.7%/1.0M (auto)`)。本体は「支払った(推定)」だけを
表示し、キャッシュで「払わずに済んだ金額」はどこにも出ません。それを埋めるのが
この PoC の役割です。計算基盤 (catalogue 単価と tier 選択規則) は本体と同じです。

| 項目 | 本体の usage 行 | この PoC (`SAVED …`) |
|---|---|---|
| 測定対象 | 実際に支払った (推定) コスト | キャッシュがあったことで払わずに済んだ (推定) 金額 |
| 集計範囲 | セッション累計 (`↑` input / `↓` output / `R` cacheRead / `W` cacheWrite) | 直近の assistant レスポンス 1 件 |
| キャッシュ指標 | `CH%` = 直近レスポンスの cacheRead ÷ (input + cacheRead + cacheWrite) | cached tokens と推定節約額 (率は出さない) |
| 単価のソース | model catalogue (`cost`) | 同じ catalogue (同一ソース) |
| tier 選択 | pi-ai `calculateCost` の規則 | 同一規則を再現 (結果は `calculateCost` と一致することを確認済み) |
| service-tier multiplier | pi-ai が `usage.cost` に織り込み済み | `usage.cost.cacheRead` との比から復元 (cost が無い場合は 1) |
| 金額の丸め | 3 桁固定 (`$0.000` と表示され得る) | 正の値は `$0.00` にならない。サブセントは 4 桁に切り上げ |
| subscription | `(sub)` 印。従量課金でないため金額は実請求と無関係 | catalogue 単価ベースの推定を表示 (実請求ではなく仕様上の限界) |
| 表示の消滅 | 常時表示 | cache hit のないレスポンス / model 切り替え / session 切り替え / shutdown |
| footer への渡し方 | 本体が直接描画 | 拡張から `setStatus("cache-savings", …)` |

内部整合性の検証: 推定式 `(inputRate − cacheReadRate) / 1e6 × cacheReadTokens ×
multiplier` は、pi-ai `calculateCost` の出力を用いた「キャッシュなしで入力した場合の
コスト − 実際の (input + cacheRead) コスト」と数値が厳密に一致します。つまり本体の
コスト表示を信頼するなら `SAVED` も同じだけ信頼できます (両者とも請求書そのものではなく
catalogue による推定で、DeepSeek のオフピーク割引のような時間帯単価にはどちらも追従できません)。

## 実装

- `src/cache-savings-core.ts`: 推定・フォーマット・controller の純粋実装。
  Pi ランタイムに依存しないため、テストや他 harness からも使えます。
- `.pi/extensions/cache-savings.ts`: `session_start` / `message_end` /
  `model_select` / `session_shutdown` を controller に橋渡しするだけの adapter。
  `message_end` では `ctx.model` の pricing を渡します。

テスト:

```sh
cd u7chan-lab-cache-savings
bun test
```

pricing が利用可能なケース、利用できないケース、tier 適用のケース、
service-tier multiplier、課金と catalogue の矛盾、controller の lifecycle を
カバーしています。
