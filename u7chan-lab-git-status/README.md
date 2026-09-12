# Git remote / PR footer links PoC

footer の status 行に、リモートリポジトリと現在ブランチの PR をリンク表示する PoC です。

## 背景

Pi 本体の footer 1 行目は cwd とブランチを表示しますが、その checkout がどのリモートを
指しているかは分かりません。ブランチに PR があっても、番号を確認して URL を組み立てる
まで開けません。そこで status 行 (cache-savings / cache-ttl と同じ行) に 1 セグメントを
足します。footer 自体は置き換えないので、minimal-footer や cache 系の拡張と共存します。

## 表示

```text
~/workspace/lab/pi-lab (issue-3-...)          ← 本体footer 1行目 (ブランチはここ)
2.0%/256k                       ...
SAVED 36.7k tok ~$0.01 CACHE auto u7chan/pi-lab PR #12
                                  └─ OSC 8 link ─┘ └ link ┘
```

- `u7chan/pi-lab` … origin (なければ upstream、なければ最初の remote) から作った
  リポジトリルートへのリンク。`git@github.com:...`、`ssh://`、`git://`、`http(s)://` を
  受け付け、web URL へ正規化します。ローカルパスや `file://`、host に `.` がない remote は
  リンクできないため表示しません
- `PR #12` … `gh pr view --json number,url` が現在ブランチから解決した PR へのリンク。
  gh が無い・未認証・PR が無い場合は PR セグメントだけを落とし、リポジトリリンクは残します
- どちらも OSC 8 hyperlink です。regular TUI では端末の Cmd/Ctrl+click、fullscreen では
  Pi の primary click でブラウザが開きます。`terminal.hyperlinks` が無効な端末では
  リンクなしのテキスト (`u7chan/pi-lab PR #12`) を表示します
- リポジトリは dim、PR 番号は accent 色です (cache 系のラベルと同じ配色規則)

status の並び順は key のアルファベット順 (`cache-savings` → `cache-ttl` → `git`) なので、
このセグメントは cache 系の右側に付きます。

## 検出と更新

| タイミング | 動作 |
|---|---|
| session start | `git rev-parse --abbrev-ref HEAD` と `git remote -v` を実行し、リポジトリリンクを即表示。`gh` は待たずに非同期で引き、返ってきたら PR リンクを追加 |
| `bash` / `powershell` tool 終了後 | 300ms debounce で再検出 (`git checkout` や `gh pr create` を拾う) |
| `agent_settled` | 同上。`!` コマンドは実行前に `user_bash` が飛ぶため、実行後のこのタイミングで拾う |
| session shutdown | status をクリア |

`gh pr view` の結果は `repo#branch` 単位でキャッシュし、同じブランチでは再問い合わせしません。
PR がまだ無い場合は 10 秒ごとに再試行するので、セッション途中で `gh pr create` しても
次の tool 実行後には番号が出ます。git の検出は 3 秒、`gh` は 5 秒でタイムアウトします。

## 制約

- PR の検出は `gh` CLI 依存です。無い場合はリポジトリリンクだけになります
- リモートの変更やブランチ切り替えを他端末で行った場合、本体 footer 1 行目 (`.git/HEAD`
  監視) は即時、このセグメントは次の tool / turn まで遅れます
- クリック以外の導線 (`/repo` コマンドやキーボードショートカット) はまだありません

## インストール

リポジトリ直下の Pi package に含まれています。

```sh
pi install git:github.com/u7chan/pi-lab@main
```

package は `u7chan-lab-*` の 5 拡張をまとめて配布します。この拡張だけを使う場合は
`pi config` で他を OFF にしてください。更新は `pi update --extensions` です。

開発中に単体で試す場合は:

```sh
pi --extension /path/to/pi-lab/u7chan-lab-git-status/.pi/extensions/git-status.ts
```

拡張が `../../src/git-status-core.ts` を相対 import するため、ファイル単体の symlink では
読み込めません。

## テスト

```sh
cd u7chan-lab-git-status
bun test
```

remote URL の正規化 (scp-like / ssh / http / GitLab のネストしたグループ / 拒否ケース)、
remote 選択の優先順位、`gh` JSON のパース、OSC 8 と theme の整形、リポジトリ→PR の順で
描画されること、git リポジトリ外・remote なしでのクリア、`gh` 失敗時のリポジトリ維持、
ブランチ別キャッシュ、10 秒の再試行間隔、debounce、dispose 後の描画停止、
session start / shutdown の配線をカバーしています。
