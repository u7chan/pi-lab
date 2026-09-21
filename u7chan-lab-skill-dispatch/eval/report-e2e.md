# 実機 E2E 検証レポート

Issue: [u7chan/pi-lab#14](https://github.com/u7chan/pi-lab/issues/14)
実施日: 2026-09-21 (UTC) / model: `jev-1.13.0` / 対象 roster: `skill-stash` 29 skills

完了条件 1「Pi の user input → Jev → Skill expansion の一連の経路が実動する」は、
Extension の単体テストでは確認できない。Pi 本体の skill expansion が動くかどうかは、
本物の Pi セッションを起動しないと分からないため、実キーで対話セッションを回して確認した。

計測値そのものは [`report.md`](report.md) を参照。このレポートは経路の検証記録である。

## 方法

- 本物の対話 TTY セッション（tmux）で起動:
  `pi -e /home/u7dev/workspace/lab/pi-lab/u7chan-lab-skill-dispatch/.pi/extensions/skill-dispatch.ts`
- 実キー（`~/.pi/agent/skill-dispatch-poc/key.env`）を使用
- 作業ディレクトリは検証専用の `/tmp/sd-e2e/scope`。repo を汚さないため、`projectAllowlist` もこの 1 ディレクトリだけにした
- 入力は計測と同じ `eval/prompts.jsonl` の `api-2`（期待 Skill は `api-design`）:
  「既存APIのバージョニング方針を決めたい。廃止までの期間と後方互換の扱いをRFCベースで整理して」
- 判定は footer と `decisions.jsonl`、実際に LLM へ渡った内容は Pi のセッション JSONL で確認した

## 結果 1: 正常系（起動時に `enabled: true`）

| 手順 | 観測 |
|---|---|
| 起動 | `[Skills]` 一覧に skill-stash の 29 件が並ぶ（`resources_discover` が公開した） |
| `/skill-dispatch status` | `scope: in scope` / `roster: 29 skills` / `pi skills: published` |
| `/skill-dispatch live` | 送信解禁（セッション限り） |
| プロンプト送信 | footer: `skill: live 0 dispatch api-design (100%, action 0.72/task 0.92) 558ms` |

`decisions.jsonl` の該当行:

```json
{"mode":"live","kind":"dispatch","reason":"confident","skill":"api-design",
 "confidence":1,"otherProbability":0,
 "gates":{"wantsAction":0.72,"specificTask":0.92,"mean":0.82},
 "model":"jev-1.13.0","latencyMs":558,"inputTokens":4041}
```

セッション JSONL では、ユーザーメッセージが Pi 標準の skill expansion で置き換わっている:

```text
<skill name="api-design" location="/home/u7dev/workspace/skill-stash/api-design/SKILL.md">
References are relative to /home/u7dev/workspace/skill-stash/api-design.

# API Design
...
```

- 展開後 3,862 字（SKILL.md 本体は 3,799 字）
- SKILL.md の見出しはすべて含まれ、frontmatter は除去されている

つまり `/skill:<name>` への変換だけでなく、**本文のロードまで Pi 標準の経路で動いている**。

### latency の注意

同一プロンプトで 3 回観測し、502ms / 589ms / 558ms だった（3 件のみ）。
`report.md` の p50 218ms は 39 件を連続実行したときの値である。**対話セッションのように
リクエスト間隔が空く使い方では 0.5s 前後**になり、体感値としてはこちらを見たほうがよい。
Jev の応答時間そのものではなく、接続を張り直すコストが乗ると考えられる。

## 結果 2: 起動後に有効化した場合（バグを検出・修正）

検証中に、**通常の Pi の挙動を壊す経路**が見つかった。

1. `enabled: false` で Pi を起動する
2. `/skill-dispatch on`（セッション限り）で有効化する
3. `/skill-dispatch live` に入る
4. プロンプトを送る

このとき dispatcher は `/skill:api-design <prompt>` へ変換したが、Pi はこのセッションで
skill-stash をまだ知らないため解決できず、LLM が「`api-design` という skill は
見つかりませんでした」と回答した。変換だけが起きて展開が失敗する状態で、fail-open の
要件に反する。

原因は Pi の仕様にある。skill の探索は `resources_discover` で行われ、これは
**起動時と `/new` のときだけ**呼ばれる（`docs/extensions.md` のイベント順）。
起動後に `enabled` を切り替えても、Pi は skillRoots を学習しない。

### 修正

- `resources_discover` で roots を公開した事実をセッションに記録する
- その記録がないセッションでは **`live` を拒否**する（`/skill-dispatch on --save` → `/new` を案内）
- ゲートにも同じ条件を入れ、コマンド以外の経路からも変換できないようにする
- `/skill-dispatch status` に `pi skills: published` / `not published (...)` を表示する

### 修正後の再検証

| 手順 | 観測 |
|---|---|
| `/skill-dispatch status`（起動直後） | `pi skills: not published (enabled at startup and /new are required)` |
| `/skill-dispatch on` | `session mode: dry-run (session only)` |
| `/skill-dispatch live` | `cannot go live: Pi has not published the skill roots for this session` |
| プロンプト送信 | 生のまま LLM へ渡る（セッション JSONL で `/skill:` が付かないことを確認） |

`decisions.jsonl` には `"kind":"dry-run"` の行だけが残り、外部への送信は発生していない。

## 判定

- 完了条件 1 は満たす。ただし**起動時に `enabled: true` であることが条件**
- 有効化・無効化の変更は、`--save` で永続化したうえで `/new` か再起動を挟む
- `p50 218ms` は連続実行時の値。対話での期待値は 0.5s 前後

## 再現手順

```sh
mkdir -p /tmp/sd-e2e/scope
# ~/.pi/agent/skill-dispatch-poc/config.json:
#   enabled: true
#   skillRoots: ["/home/u7dev/workspace/skill-stash"]
#   projectAllowlist: ["/tmp/sd-e2e/scope"]

cd /tmp/sd-e2e/scope
pi -e /home/u7dev/workspace/lab/pi-lab/u7chan-lab-skill-dispatch/.pi/extensions/skill-dispatch.ts

/skill-dispatch status     # pi skills: published を確認
/skill-dispatch live
# 「既存APIのバージョニング方針を決めたい。…」を送信
# footer の dispatch api-design と、セッション JSONL の <skill name="api-design"> を確認
```

検証に使った生ログは repo に含めていない。判定は `~/.pi/agent/skill-dispatch-poc/decisions.jsonl`、
展開結果は `~/.pi/agent/sessions/--tmp-sd-e2e-scope--/*.jsonl` に残る。
