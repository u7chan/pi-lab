# Elapsed-time working/footer PoC

> 状態: 検証中。`package.json` の `pi.extensions` に未登録のため、通常の Pi 起動では読み込まれません。
> `pi -e ./.pi/extensions/elapsed.ts` で明示的に読み込んだときだけ動作します。

エージェントに指示を出してから完了するまでの経過時間を、Claude Code と同じ `12m 3s` 形式で
TUI に表示する PoC です。

## 背景

Pi の working 行は `Working` としか表示せず、指示を出してからどれくらい待っているのか
分かりません。Claude Code は working 行に経過時間をライブ表示し、完了後も所要時間を残します。
この拡張は `before_agent_start` → `agent_settled` の 1 スパン（1 指示の全体）を計測し、

- 実行中: working 行を `Working (12m 3s)` として 1 秒ごとに更新
- 完了後: footer の status 行に `ELAPSED 12m 3s` を残す（次の指示でクリア）

の 2 箇所に表示します。

## 表示

```text
✳ Working (8s)                                    ← 実行中。tool 実行中も進む
...
SAVED 7.4k tok ~$0.0011 CACHE hit ELAPSED 9s     ← 完了後 (footer status 行)
```

ラベルは accent、値は dim で、cache 系の status と同じ配色規則です。status の並び順は key の
アルファベット順なので、`ELAPSED` は `CACHE` / `SAVED` の右側に付きます。

working 行は `ctx.ui.setWorkingMessage()` を差し替えます。この API は Loader の
`updateDisplay()` を通して `requestRender()` を呼ぶため、拡張側の 1 秒タイマーだけで
再描画されます（Pi 本体の `RetryStatusIndicator` のカウントダウンと同じ経路）。

## 計測範囲

| タイミング | 動作 |
|---|---|
| `before_agent_start`（プロンプト送信直後） | 計測開始。working 行を `Working (0s)` にし、前回の `ELAPSED` をクリア |
| 1 秒ごと | working 行を `Working (n)` に更新 |
| `agent_settled`（run が完全に settle） | working 行を既定の `Working` に戻し、footer に確定値を表示 |
| `session_shutdown` | タイマー停止と `ELAPSED` のクリア |

1 指示のスパンなので、複数 turn・tool 実行・自動 retry とその backoff・compaction・queued
continuation はすべて同じ計測に含まれます。

確定に `agent_end` ではなく `agent_settled` を使うのは、自動 retry が `agent_end` の後に
`before_agent_start` を再発火せずに走るためです。`agent_end` で確定すると、retry 前の試行分しか
計測されません（Pi 1.0.0 の `agent-session.js` では `agent_settled` が `_runAgentPrompt()` の
`finally` から発火し、retry ループの完了後にだけ来ます）。

## 実機確認

2026-10-03、Herdr のペインで本物の対話 TUI を起動して確認しました
（`opencode-go/deepseek-v4.1-flash`、`--no-session`）。

- `bash` tool で `sleep 6` を実行させる指示: 実行中に `Working (1s)` → `Working (8s)` と進み、
  完了後に footer が `SAVED 7.4k tok ~$0.0011 CACHE hit ELAPSED 9s` になった
- 続けて即答の指示を送信: 送信直後に前回の `ELAPSED` が消え、`Working (1s)` から再計測。
  完了後は `ELAPSED 1s`
- `/quit` で終了時に `session_shutdown` が走り、タイマーが残らないことを確認

自動 retry の包含は Pi SDK + ローカル mock provider（1 回目の応答を 1.1s 後に error、1.1s の
backoff 後に 2.2s で成功）でも確認しました。修正前は retry 前の `agent_end` で確定して
`ELAPSED 1s` のままだったのに対し、修正後は 4,426ms のプロンプトに対して 4,461ms の時点で
`ELAPSED 4s` が確定します。

## ローカルでの実行

```sh
cd u7chan-lab-elapsed
pi -e ./.pi/extensions/elapsed.ts
```

リポジトリ直下の Pi package には未登録です。拡張が `../../src/elapsed-core.ts` を相対 import
するため、ファイル単体の symlink では読み込めません。

## 既知の制約

- 表示は working 行と footer のみです。Claude Code の完了行（`Cooked for 23m 3s`）に相当する
  トランスクリプトへの記録は未実装です
- working 行の文言は丸ごと置き換えます。他の拡張が独自の working message を設定していても、
  この拡張の完了時に既定の `Working` へ戻すため、その文言は消えます
- abort（中断）でも `agent_settled` は `_runAgentPrompt()` の `finally` から来るため、途中で
  止めた所要時間も `ELAPSED` として残ります
- RPC モードでは `setWorkingMessage` は no-op、`setStatus` は fire-and-forget です
- Pi 本体や他拡張が別の時間表示を持つ場合があります（検証環境では
  `@howaboua/pi-codex-conversion` の `Took 6.0s` が併存しました）

## テスト

```sh
cd u7chan-lab-elapsed
bun test
```

`formatElapsed` の境界（秒 / 分 / 時、負値・非有限値）、working 行と footer status の整形、
1 秒 tick、retry 区間を跨いで `agent_settled` で確定すること、タイマー停止、次の指示での
クリアと再計測、UI なし・`session_shutdown`・`dispose` の挙動、`before_agent_start` /
`agent_settled` / `session_shutdown` の配線（`agent_end` に handler を持たないことの
リグレッションガードを含む）をカバーしています。
