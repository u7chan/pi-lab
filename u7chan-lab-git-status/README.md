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
- どちらも OSC 8 hyperlink です。regular TUI では端末側の操作 (Windows Terminal は
  Ctrl+click、Ghostty は Cmd+click など)、fullscreen では Pi の primary click で
  ブラウザが開きます。ハイパーリンク非対応と判定された端末では、リンクなしの
  テキスト (`u7chan/pi-lab PR #12`) を表示します
- リポジトリは dim、PR 番号は accent 色です (cache 系のラベルと同じ配色規則)

status の並び順は key のアルファベット順 (`cache-savings` → `cache-ttl` → `git`) なので、
このセグメントは cache 系の右側に付きます。

## 端末検出

リンクを出すかどうかは `getCapabilities().hyperlinks` (Pi の OSC 8 対応判定) を基本に
します。ただし pi-tui は Windows Terminal を `WT_SESSION` でのみ判定するため、Herdr の
ようなランチャー経由で起動した WSL ペインでは `WT_PROFILE_ID` だけが残り、対応端末なのに
判定が false になることがあります。この拡張はその場合も `WT_PROFILE_ID` を Windows
Terminal の証拠として扱います (`WT_SESSION` / `WT_PROFILE_ID` のどちらかで有効)。
`PI_HYPERLINKS=0` が明示されているときだけはリンクを出しません。

Pi 本体のリンク (ログインダイアログなど) も同じ判定を使うため、環境全体で直すなら
`~/.pi/agent/settings.json` に `"terminal": { "hyperlinks": true }` を足すのが確実です。

## 検出と更新

| タイミング | 動作 |
|---|---|
| session start | `git rev-parse --abbrev-ref HEAD` と `git remote -v` を実行し、リポジトリリンクを即表示。`gh` は待たずに非同期で引き、返ってきたら PR リンクを追加 |
| `bash` / `powershell` tool 終了後 | 300ms debounce で再検出 (`git checkout` や `gh pr create` を拾う) |
| `agent_settled` | エージェント実行の終了時にも再検出。`!` コマンドは実行前に `user_bash` が飛ぶだけで `agent_settled` は発火しないため、`!git checkout` 単体の反映は次の shell tool / エージェント実行まで遅れる |
| session shutdown | status をクリア |

`gh pr view` の結果は `host/repo#branch` 単位でキャッシュし、同じブランチでは再問い合わせしません。
PR が無い場合も結果をキャッシュし、失敗から 10 秒以上過ぎた次の再検出でだけ再試行します。
タイマーによる自動再試行はなく、session start / shell tool 終了 / エージェント実行終了の
いずれかが次の再検出の起点です。git の検出は 3 秒、`gh` は 5 秒でタイムアウトします。

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
remote 選択の優先順位、`gh` JSON のパース、OSC 8 と theme の整形、Windows Terminal 判定
(`WT_SESSION` / `WT_PROFILE_ID` / `PI_HYPERLINKS=0`)、リポジトリ→PR の順で
描画されること、git リポジトリ外・remote なしでのクリア、`gh` 失敗時のリポジトリ維持、
ブランチ別キャッシュ、10 秒の再試行間隔、debounce、dispose 後の描画停止、
session start / shutdown の配線をカバーしています。
