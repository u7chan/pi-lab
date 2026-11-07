# Live phase sidecar PoC

エージェントが実行中に「何をしているか」を、セッションファイルの隣の小さな sidecar に書き出す PoC です。
hwc（Herdr Web Client）のような外部クライアントが、pi のプロセスにアタッチせず、TUI も読まずに
実行中の段階と thinking の末尾を表示できるようにするための契約を検証します。

> 状態: 検証中。`package.json` の `pi.extensions` に登録する想定で、移行状況は未移行です。
> 単体で試すときは `pi -e ./.pi/extensions/live-thinking.ts` で読み込みます。

## 背景

- pi は assistant メッセージを `message_end` でしかセッション JSONL に書かない。ストリーミング中の
  thinking はディスク上に存在せず、JSONL を正とする限り「Live」は原理的に出せない。
- TUI には thinking が出るが、`hideThinkingBlock` で意図的に隠している環境があり、画面を読むのは
  折り返し・再描画・色への依存になる。hwc は会話の正を JSONL に置き、画面解釈を採らない。
- 拡張ならトークン単位のイベントを直接受け取れる。書き出すのは一時的な状態だけで、会話の正は
  従来どおり JSONL に残す。

## 契約

### 置き場所

セッションファイルの隣に、同じ名前へ `.thinking.json` を足した 1 ファイルを置きます。

```text
<agent-dir>/sessions/<slug>/<timestamp>_<uuid>.jsonl
<agent-dir>/sessions/<slug>/<timestamp>_<uuid>.jsonl.thinking.json
```

読む側はセッション path だけで場所を導けるため、agent dir の解決もヘッダの読み取りも要りません。
`--session-dir` でセッションを移動しても同じ関係が保たれます。

### 形式（v1）

```json
{ "v": 1, "at": 1762000000000, "phase": "thinking", "text": "…" }
```

| フィールド | 型 | 内容 |
|---|---|---|
| `v` | number | 形式のバージョン。現在は `1` 固定 |
| `at` | number | 書き出した時刻（epoch ms）。状態が変わらない間は更新しない |
| `phase` | string | 下記の 7 段階 |
| `text` | string? | `thinking` のときだけ。現在の thinking ブロックの末尾（最大 1200 文字） |
| `tool` | string? | `tool` のときだけ。最後に開始した実行中ツール名 |
| `tools` | number? | `tool` のときだけ。並列実行中のツール数 |

上書きのみで追記しません。履歴は持ちません。読み側の `parseLiveThinking()` は、バージョン違い・
未知の phase・phase と合わないフィールド（例: `tool` なのに `text`）を捨てます。

### phase

| phase | 開始 | 意味 |
|---|---|---|
| `waiting` | `before_agent_start` / `agent_start` / `turn_start` / `agent_end` | リクエスト送信待ち。最初の差分まで |
| `thinking` | `thinking_start` / `thinking_delta` | thinking を生成中。`text` は末尾のみ |
| `writing` | `text_start` / `text_delta` | 回答本文を生成中 |
| `tool-call` | `toolcall_start` / `toolcall_delta` | ツール呼び出しの引数を生成中（短命） |
| `tool` | `tool_execution_start` から最後の `tool_execution_end` まで | ツールを実行中 |
| `compacting` | `session_before_compact` から `session_compact(_failed)` まで | 会話を圧縮中 |
| `waiting-user` | `ui_prompt_start` から `ui_prompt_end` まで | 拡張 UI の入力待ち |

優先順位は `compacting` > `tool` > 生成中の activity > `waiting-user` > `waiting` です。
`ui_prompt_start/end` は入れ子を 1 つのスパンにまとめます。

### 更新と削除

- thinking の差分は 500ms 間隔でまとめて書き、phase が変わったときはその場で書きます。
  読む側が約 1 秒間隔で取得する前提です。
- 書き込みは一時ファイル + rename で、読み手が半端な JSON を見ることはありません。
- `agent_settled` と `session_shutdown` で削除します。`agent_end` では消しません。自動リトライや
  queued message で実行が続く間は `waiting` を維持するためです。
- `session_start` で自セッションの sidecar を削除します。クラッシュで残った残骸を掃除するためです。
- `--no-session` のようにセッションファイルが無い場合は何もしません。
- 書き込みの失敗（ディスク、権限、ディレクトリ消失）は握りつぶします。この拡張は観測専用で、
  セッションを止めてはいけません。

### 分からないこと

- 自動リトライの backoff には拡張イベントが無いため、`waiting` として見えます。
- 並列ツールは 1 つの `tool` phase にまとめ、実行数と最後に開始した名前だけを出します。
- `tool-call` は引数の生成中で、短時間しか続きません。読む側の 1 秒間隔では取りこぼすことがあります。

## 読み側の想定（hwc）

- 会話スナップショット（`/api/panes/:id/chat` の ETag）には混ぜません。差分のたびに ETag が動くと
  304 の意味が壊れるため、`/api/panes/:id/thinking` のような使い捨ての取得口にします。
- `working` かつ画面表示中だけ約 1 秒間隔で取得し、phase のラベルと thinking の末尾 2 行を出す。
  ターン終了で消えるので、トランスクリプトには残りません。
- ファイルが無い・壊れている・古すぎる場合は「無し」として扱い、従来のタイピング表示に戻します。

## 使い方

```sh
cd u7chan-lab-live-thinking
pi -e ./.pi/extensions/live-thinking.ts
```

セッションを作らない起動（`--no-session`）では何も書きません。

## 実機確認

2026-11-07、WSL / Linux、Pi 1.5.0、Node.js 26.12.1、Bun 1.3.14 で確認しました。
`--session-dir` に一時ディレクトリを指定し、`opencode-go/deepseek-v4-pro` / thinking `high` で
（設定の `hideThinkingBlock: true` はそのまま）、次を実行しながら sidecar を 20ms 間隔で観測しました。

```sh
pi --session-dir "$TMP/sessions" --model opencode-go/deepseek-v4-pro --thinking high \
  -p "17*23 を計算し、検算も示してください。その前に bash ツールで sleep 1 を1回実行してください。" \
  -e ./.pi/extensions/live-thinking.ts
```

観測した遷移（`at` を除く）。

```text
waiting
thinking
thinking  text "The user wants me to: ..."
tool-call
tool      bash 1
waiting
thinking
thinking  text "Now calculate 17*23 = 391. Verification: ..."
writing
GONE      （agent_settled）
```

- phase の遷移はその場で書かれ、`tool-call` は約 20ms で `tool` へ移った。`tool` は `sleep 1` の
  実行中（約 1.0 秒）だけ続き、終了直後に `waiting` になった。
- 同じ phase が続く thinking は約 500ms 間隔で末尾だけ更新された（`thinking` の初回は text 無し、
  最初の差分の後に text が付く）。
- 最後は `agent_settled` でファイルが消えた（観測ログの `GONE`）。
- print mode で確認しており、TUI の描画には依存しない。`hideThinkingBlock` の設定にも影響されない。
- 同じ手順を `deepseek-v4.1-flash` で実行したところ、そのモデルは thinking を返さず、
  `waiting → tool-call → writing` だけだった。`thinking` phase はモデルが reasoning を出したときだけ現れる。

未確認は、対話 TUI（Herdr のペイン）での長時間ストリーミングと、hwc からの読み取りです。
