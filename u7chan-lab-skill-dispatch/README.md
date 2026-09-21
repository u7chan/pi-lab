# Skill dispatch PoC

> 状態: 検証中。`package.json` の `pi.extensions` に未登録のため、通常の Pi 起動では読み込まれません。
> `pi -e ./.pi/extensions/skill-dispatch.ts` で明示的に読み込んだときだけ動作し、さらに config の
> `enabled`（既定 false）と `projectAllowlist` を通らない限り外部 API へ何も送信しません。

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
Jev: Choice(skill 名 + other) + Noul 2本（記録用）
  ↓
dispatch 判定（P(other) / confidence）
  ├─ dispatch → /skill:<name> <original prompt>  → Pi の Skill 展開 → LLM
  └─ abstain / error / timeout → 元の入力のまま Pi へ
```

`dry-run` は同じ経路を通り、同じ request を組み立てて**送信せずに**ログへ記録します。

## ローカルでの実行

```sh
cd u7chan-lab-skill-dispatch
pi -e ./.pi/extensions/skill-dispatch.ts
```

リポジトリ直下の Pi package には未登録です（状態は冒頭を参照）。

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
  "enabled": true,          // 起動時に true であること（後述）
  "skillRoots": ["~/workspace/skill-stash"],
  "projectAllowlist": ["/home/u7dev/workspace/lab/pi-lab"],
  "threshold": 0.65,       // Choice confidence の下限（計測で 0.65 を推奨）
  "gate": "other",         // abstain ゲート: "other" 確率（推奨）または "noul"
  "otherThreshold": 0.15,  // P(other) の上限（gate=other のとき）
  "noulThreshold": 0.5,    // noul 平均の下限（gate=noul のとき）
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

### 有効化は起動前に行う

Pi が skill を探すのは **起動時と `/new` のときだけ**で、セッションの途中で
`enabled` を切り替えても Pi は skillRoots を学習しない。その状態で transform すると、
Pi が展開できない `/skill:<name>` をユーザーに渡してしまうため、この拡張は
**roots を公開していないセッションでは `live` を拒否**する。

```text
/skill-dispatch on --save   # 永続化（allowlist が空なら現在の cwd を追加）
/new                        # ここで Pi が skillRoots を学習する
/skill-dispatch live        # 送信開始（セッション限り）
```

`/skill-dispatch status` の `pi skills:` がその状態を示す。`not published` のときは
`live` にできない。

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
| 8 | 起動時に roots を公開済み | - | 未公開なら `live` を拒否（変換しても展開できないため） |

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

詳細と閾値の根拠は [`eval/report.md`](eval/report.md)（prompt セット 39 件、`jev-1.13.0`）:

| 項目 | 値 |
|---|---|
| 判定精度 | covered 24 件で top choice 24/24 一致、負例 15 件で FP 0（推奨閾値） |
| latency | **p50 218ms / p95 538ms**（avg 261ms、連続実行時） |
| latency（対話） | **0.5s 前後**（間隔を空けた単発 3 件で 502 / 589 / 558ms） |
| input tokens | avg **4,031 / request**（roster 29 件込み） |
| cost | **$0.00017 / turn**（1,000 turn で約 $0.17） |
| roster 単体 | 29 skills, 4,417 字, 約 3,092 tokens |
| `probe` の model | `jev-1.13.0`（`jev-latest` の解決結果） |

コストは無視でき、**律速は 1 ターンあたり +0.2〜0.5s の latency** です。
`noul` ゲートは学習・執筆・設計相談系の Skill を構造的に落とすため採用せず、
`P(other)` + confidence の 2 段で判定しています（根拠はレポート参照）。

実機の対話セッションで「入力 → Jev → `/skill:<name>` → Pi の skill expansion」まで
通した記録は [`eval/report-e2e.md`](eval/report-e2e.md) にあります。

再計測:

```sh
bun run eval/measure.ts run --roots ~/workspace/skill-stash
bun run eval/measure.ts sweep          # API 再呼び出し無しで閾値だけ振り直す
```

## 既知の制約

- abstain は `P(other)` と confidence の 2 段です。`noul` 2 本は記録用に送っていますが判定には
  使っていません（学習・執筆・設計相談系の依頼を落とすため。詳細は `eval/report.md`）
- jev-1.13 は**字義通り**に読むモデルなので、指示文の言い回しが精度に直結します。
  変更時は `INSTRUCTION_VERSION` を上げてください
- 計測は 39 件の合成 prompt なので、実運用での再調整が必要です
- 有効化・無効化は起動時と `/new` にしか反映されません（Pi が skill を探すタイミングに合わせる）
- 同じユーザー権限で動く以上、`key.env` は悪意ある入力から `cat` され得ます。この設計が防ぐのは
  **env dump による context/セッション汚染**、**子プロセスへの継承**、**repo への誤コミット**です

## 構成

```text
u7chan-lab-skill-dispatch/
├── .pi/extensions/skill-dispatch.ts   # ゲート・コマンド・input hook（薄い adapter）
├── eval/
│   ├── prompts.jsonl                  # ラベル付き prompt セット（39 件）
│   ├── measure.ts                     # run / sweep
│   ├── report.md                      # 計測結果と閾値の根拠
│   ├── report-e2e.md                  # 実機 E2E の検証記録
│   └── results/latest.jsonl           # 直近実行の生出力
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

- 実運用プロンプト（`logPrompts: true`）で p50/p95 と誤発動を再計測
- Retriever 方式（skill-stash#25 / #36）と同じ harness での比較
- `package.json` の `pi.extensions` への登録（既定 off なので安全だが、明示的に判断する）
