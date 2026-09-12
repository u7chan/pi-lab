# Minimal footer PoC

本体 footer から token/cost 統計ブロックだけを取り除く footer 差し替え PoC です。

## 背景

Pi 本体の footer は常時次のような統計行を表示します:

```text
↑5.7k ↓24 R4.6k CH89.1% $0.001 (sub) 2.0%/256k (auto)
```

- `↑` input / `↓` output / `R` cacheRead / `W` cacheWrite (セッション累計)
- `CH%` 直近レスポンスのキャッシュヒット率
- `$` セッション累計コスト (`(sub)` は subscription 計上の印)
- `2.0%/256k` context window 使用率、`(auto)` 自動コンパクト有効の印

cache-savings / cache-ttl の各 PoC を見ていると必要なのは context window と
statuses だけで、stats 部分は冗長です。設定で表示項目を選べる API はないため、
公式の `ctx.ui.setFooter()` パターン (docs/tui.md Pattern 6) で footer 全体を
引き受けます。

## 表示

本体と同じ 3 行構成から stats だけを除いたもの:

```text
~/workspace/lab/pi-lab (issue-3-cache-savings)        ← 1行目: cwd (branch) • session
2.0%/256k                    (zai) glm-5.3-flash • max ← 2行目: context window と model 情報
SAVED 6.8k tok ~$0.0010 CACHE hit                  ← 3行目: 拡張 statuses (本体と同じ)
```

- 消えるもの: `↑ ↓ R W CH% $ (sub)`
- 残るもの: context window 使用率 (>90% error / >70% warning 色も再現)、
  model 情報 (provider 接頭辞と thinking level を含む)、拡張 statuses
  (本体と同じく key のアルファベット順・whitespace 正規化)
- 本体の `(auto)` 印は extension から自動コンパクトの状態を取得できないため
  再現していません

## 使い方

TUI session では起動時に自動で有効化されます。`/minimal-footer` コマンドで
本体 footer に戻し、再度実行すると有効化されます。RPC / print / json モードでは
何もしません。

## インストール

リポジトリ直下の Pi package に含まれています。

```sh
pi install git:github.com/u7chan/pi-lab@main
```

package は `u7chan-lab-*` の 4 拡張をまとめて配布します。この拡張だけを使う場合は
`pi config` で他を OFF にしてください。更新は `pi update --extensions` です。

開発中に単体で試す場合は:

```sh
pi --extension /path/to/pi-lab/u7chan-lab-minimal-footer/.pi/extensions/minimal-footer.ts
```

拡張が `../../src/minimal-footer-core.ts` を相対 import するため、ファイル単体の
symlink では読み込めません。

## テスト

```sh
cd u7chan-lab-minimal-footer
bun test
```

`formatTokens` が本体と同じ丸めになること、context % の色分き替え
(90% / 70% しきい値)、statuses のソートと truncate、1 provider 時の
provider 接頭辞省略、session 名の表示、TUI 以外で footer を触らないこと、
toggle の往復をカバーしています。
