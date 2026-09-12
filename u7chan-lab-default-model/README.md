# Default model switcher

`/dm` で Pi の既定モデル (起動時に使う `defaultProvider` / `defaultModel` /
`defaultThinkingLevel`) を切り替える拡張です。

## 背景

既定モデルの保存は本体 UI では `/model` → Ctrl+S、既定 thinking level は
`/thinking` → Ctrl+S と別操作で、モデルごとに使える level も違います
(例: `opencode-go/deepseek-v4.1-flash` は `minimal`/`low`/`medium` が `null` で
`off`/`high`/`xhigh`/`max` のみ)。拡張から既定値を書く API は公開されていない
ため、`settings.json` を読み書きする小さな拡張にしました。

## 使い方

```text
/dm                                        # 選択 UI (文字入力で絞り込み)
/dm kimi                                   # あいまい一致。曖昧なら選択 UI
/dm minimax                                # 複数一致 → 選択 UI で候補から選ぶ
/dm opencode-go/deepseek-v4.1-flash        # 完全指定
/dm opencode-go/deepseek-v4.1-flash:max    # thinking level も同時に既定へ保存
/dm show                                   # 現在の既定を表示
```

- 保存先は `~/.pi/agent/settings.json` (global)。選んだモデルは現在の
  セッションにもそのまま適用されます。
- RPC モードでは `ctx.ui.select` のダイアログ、TUI ではフィルタ可能な
  `SelectList` を使います。
- エージェントからも `set_default_model` ツールで変更できます
  (`applyToSession` を付けると現セッションも切り替え)。

## 挙動

- 書き込みは一時ファイル + rename。他のキー (`packages` / `theme` など) は保持します。
- level を指定しないときは既存の `defaultThinkingLevel` に触りません。
- 未対応の level を指定した場合はエラーにし、`settings.json` もセッションも変更しません。
- 既存の `defaultThinkingLevel` が新しいモデルで未対応なら警告を出します
  (次回起動まで気付けない事故を防ぐため)。
- provider の認証が無い場合も既定は保存し、セッション適用だけが失敗したことを
  warning で伝えます。
- モデル解決の優先順位: 完全な `provider/id` > `id` 完全一致 > `id` 前方/部分一致 >
  キー部分一致 > 名前一致 > 空白/記号を除いた一致 > 部分列一致
  (`dv41f` → `opencode-go/deepseek-v4.1-flash`)。
- 認証済み (`getAvailable()`) のモデルを優先し、1 つも無ければ catalogue 全体を使います。

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
pi --extension /path/to/pi-lab/u7chan-lab-default-model/.pi/extensions/default-model.ts
```

拡張が `../../src/default-model-core.ts` を相対 import するため、**ファイル単体の
symlink (`~/.pi/agent/extensions/u7chan-lab-default-model.ts`) は読み込みに失敗します**。
リポジトリをチェックアウトし、package か project 拡張として読み込んでください。

## 実装

- `src/default-model-core.ts`: マッチング・スキーマ合成・settings.json の
  read-modify-write の純粋実装。Pi ランタイムに依存しない
  (`ModelLike` 構造的型のみ) ため、テストや他 harness からも使えます。
- `.pi/extensions/default-model.ts`: `/dm` コマンドと `set_default_model` ツールの
  adapter。Pi ランタイムの import は型のみで、実処理
  (`getAgentDir` / `withFileMutationQueue` / TUI 部品) は注入または遅延 import します。
  これにより node_modules 無しの `bun test` でも adapter をそのまま読み込めます。
- ツールのパラメータは TypeBox ではなく素の JSON Schema で宣言しています
  (Pi は non-TypeBox schema を JSON Schema として coerce するため)。

## テスト

```sh
cd u7chan-lab-default-model
bun test
```

クエリの分解 (`:level` の切り出しと保持)、level 対応表、スコアリングと
曖昧判定、settings.json のマージ保存 (一時ファイルが残らないこと)、
未対応 level の拒否、認証無し provider の警告、コマンドとツールの登録・実行を
カバーしています。
