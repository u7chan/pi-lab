# Skill dispatch PoC

Issue #14 の PoC です。ユーザー入力の前段に Jev（TypeSafe の System One model）を置き、
`skill-stash` の Skill から適切なものを選んで `/skill:<name>` へ変換する経路を実装しています。

設計の中心は**送信ゲート**です。この拡張は全ユーザー入力を外部 API に送り得るため、
既定では何も送らず、明示的に許可した 1 プロジェクト・1 セッションの中だけで動きます。

## 動作

```text
user input
  ↓
gate 1-5（config / session mode / source / slash / projectAllowlist / budget）
  ↓
roster scan（skillRoots 配下の SKILL.md から name + description）
  ↓
gate 6（roster が空でない / API key が解決できる）
  ↓
Jev: Choice(skill 名 + other) + Noul 2本（実行を求めるか / 具体的な作業か）
  ↓
dispatch 判定（confidence / gate 平均 / other）
  ├─ dispatch → /skill:<name> <original prompt>  → Pi の Skill 展開 → LLM
  └─ abstain / error / timeout → 元の入力のまま Pi へ
```

`dry-run` は同じ経路を通り、同じ request を組み立てて**送信せずに**ログへ記録します。

## ローカルでの実行

```sh
cd u7chan-lab-skill-dispatch
pi -e ./.pi/extensions/skill-dispatch.ts
```

リポジトリ直下の Pi package には登録していません（登録するまでは他プロジェクトで読み込まれません）。

## セットアップ

```text
/skill-dispatch init              # PoC ディレクトリと空の key file
/skill-dispatch roster            # skillRoots を走査して件数・トークン量を確認
```

`key.env` にキーを入れ（シェル履歴に残さない）:

```sh
read -rsp 'TypeSafe API key: ' KEY
printf 'TYPESAFE_API_KEY=%s\n' "$KEY" > ~/.pi/agent/skill-dispatch-poc/key.env
unset KEY && chmod 600 ~/.pi/agent/skill-dispatch-poc/key.env
```

`config.json` にスコープと Skill 置き場を設定:

```jsonc
{
  "enabled": true,
  "skillRoots": ["~/workspace/skill-stash"],
  "projectAllowlist": ["/home/u7dev/workspace/lab/pi-lab"],
  "threshold": 0.7,          // Choice confidence の下限
  "noulThreshold": 0.5,      // 実行を求めるゲート 2 本の平均の下限
  "maxDispatchesPerSession": 0,  // 0 = 無制限
  "logPrompts": false,       // true でログに prompt 本文を残す（既定は hash のみ）
  "typesafe": {
    "apiKeySource": "file:~/.pi/agent/skill-dispatch-poc/key.env",
    "model": "jev-latest",
    "timeoutMs": 2000
  }
}
```

```text
/skill-dispatch probe             # 実 API を 1 回だけ叩いて疎通と latency を確認
/skill-dispatch on --save         # enabled=true（allowlist が空なら現在の cwd を追加）
/skill-dispatch live              # このセッションだけ実送信。dry で戻せる
```

`on/off` は `--save` を付けたときだけ永続化します。`live` は**常にセッション限り**です。

## コマンド

| コマンド | 内容 |
|---|---|
| `/skill-dispatch status` | enabled / session mode / scope / allowlist / roster / key / 直近の判定 |
| `/skill-dispatch init` | PoC ディレクトリと空の key file を作成 |
| `/skill-dispatch roster` | skillRoots を再走査して件数・トークン見積りを表示 |
| `/skill-dispatch probe` | 実 API を 1 回呼び、latency・model・tokens を表示 |
| `/skill-dispatch on [--save]` | 有効化。allowlist が空なら現在の cwd を追加 |
| `/skill-dispatch off [--save]` | 無効化 |
| `/skill-dispatch dry` | セッションを dry-run に（request はログのみ） |
| `/skill-dispatch live` | セッションを live に（実送信・transform） |
| `/skill-dispatch purge` | PoC ディレクトリを削除（marker 一致時のみ） |

フッターに `skill: off / dry (29) / live 3 / blocked (reason)` を常時表示します。

## 送信ゲート（deny-by-default）

| # | ゲート | 既定 | 効果 |
|---|---|---|---|
| 1 | `enabled`（永続 config） | false | ロードされていても不発 |
| 2 | session mode | `off`（enabled なら `dry-run`） | `live` にしない限り送信しない |
| 3 | `event.source === "interactive"` | - | 拡張からの注入・RPC 入力を除外 |
| 4 | `/` 始まりを除外 | - | 明示 `/skill:`・template・コマンドを尊重 |
| 5 | `projectAllowlist` の cwd 一致 | 空 = 全拒否 | 指定プロジェクト以外では送信しない |
| 6 | session budget | 0 = 無制限 | 事故時の上限 |
| 7 | roster 非空 / API key 解決 | - | 失敗時は送信しない（fail-open） |

`skillRoots` は同じ root を Pi の `resources_discover` にも渡しますが、**enabled かつ in scope の
セッションだけ**です。スコープ外のプロジェクトは Skill 一覧すら受け取りません。

## ファイル配置

PoC が所有するものは 1 ディレクトリだけです。既存のキー置き場（`~/.config/envs/` など）には触れません。

```text
~/.pi/agent/skill-dispatch-poc/     # PI_CODING_AGENT_DIR を尊重
├── poc.json                        # marker。purge はこれが一致するときだけ削除
├── config.json                     # 非秘密の設定 (0600)
├── key.env                         # キー (0600)
└── decisions.jsonl                 # 1 ターン 1 行の判定ログ (0600)
```

## キーの扱い

参照方法は 3 形式のみで、literal key を config に書く経路はありません。

| 形式 | 例 | 用途 |
|---|---|---|
| `file:` | `file:~/.pi/agent/skill-dispatch-poc/key.env` | 既定。dotenv 形式（`export` / クォート / `JEV_API_KEY` alias 可） |
| `env:` | `env:TYPESAFE_API_KEY` | 一時検証用。既定にはしない |
| `command:` | `command:gpg -d ~/.pi/agent/skill-dispatch-poc/key.env.gpg` | 平文を置きたくない場合 |

**env を既定にしない理由**: Pi の `bash` ツールは pi プロセスの env を継承するため、
export したキーは `env` 経由で transcript と session JSONL に残り得ます。

## 観測ログ

`decisions.jsonl` に 1 ターン 1 行を追記します。

```jsonc
{"at":"...","mode":"dry-run","kind":"dry-run","reason":"dry-run",
 "cwd":"/home/u7dev/workspace/lab/pi-lab","rosterSize":29,
 "promptChars":17,"promptHash":"6fb8cc501d0d","truncated":false,
 "instructionVersion":"ja-1","model":"jev-latest","inputTokens":3477}
```

`kind` は `dry-run` / `dispatch` / `abstain` / `error`。`abstain` の `reason` は
`choice-other` / `noul-gate` / `low-confidence` / `unusable-*-answer` で、誤発動と見逃しを
後から分類できます。プロンプト本文は `logPrompts: true` のときだけ記録します。

## 実測値

`skill-stash` 29 Skill を対象にした実測（2026-09-21）:

| 項目 | 値 |
|---|---|
| roster | 29 skills, 4,417 chars, **約 3,092 tokens**（推定） |
| request 全体（dry-run 推定） | 約 3,477 tokens |
| 1 リクエストのコスト | 3,500 tokens × $0.042/MTok ≈ **$0.00015**（1,000 ターンで約 $0.15） |
| `probe` の latency | 520ms / 468ms / 427ms（ダミーキー含む） |
| `probe` の model | `jev-1.13.0`（`jev-latest` の解決結果） |
| `noul` の挙動 | 「こんにちは。今日はいい天気ですね。」→ 0.880 |

コストは無視できる一方、**latency は 1 ターンあたり +0.5s** です。これが採用判断の主な論点です。

## 既知の制約

- `noul` に `confidence` は無い（Choice / Score のみ）。そのため abstain は
  「Choice の `other`」と「noul 2 本の平均」の 2 系統で判定しています。公式は
  「Noul で調整した閾値を Choice に流用するな」としており、閾値は別々に実測調整が必要です
- jev-1.13 は**字義通り**に読むモデルなので、指示文の言い回しが精度に直結します。
  変更時は `INSTRUCTION_VERSION` を上げてください
- 同じユーザー権限で動く以上、`key.env` は悪意ある入力から `cat` され得ます。この設計が防ぐのは
  **env dump による context/セッション汚染**、**子プロセスへの継承**、**repo への誤コミット**です

## 構成

```text
u7chan-lab-skill-dispatch/
├── .pi/extensions/skill-dispatch.ts   # ゲート・コマンド・input hook（薄い adapter）
├── src/
│   ├── gate.ts                        # 送信ゲート（純関数）
│   ├── skill-source.ts                # SKILL.md 走査と frontmatter 解析
│   ├── dispatcher.ts                  # Jev request の組み立てと判定
│   ├── typesafe-client.ts             # System One transport（retry なし / fail-open）
│   ├── key-source.ts                  # キー解決 (file:/env:/command:)、redact、hash
│   └── poc-store.ts                   # config の parse/serialize、marker、template
└── tests/                             # bun test（ネットワーク不要、依存注入）
```

```sh
bun test u7chan-lab-skill-dispatch
```

## 残作業

- 日本語の代表プロンプト集で「誤発動 / 見逃し / abstain / latency p50・p95」を記録
  （skill-stash#36 の Retriever と比較可能な形にする）
- `threshold` / `noulThreshold` の実測調整
- shortlist 再ランク（公式 cookbook の 2 パス目）を入れるかの判断
- `package.json` の `pi.extensions` への登録（既定 off なので安全だが、明示的に判断する）
