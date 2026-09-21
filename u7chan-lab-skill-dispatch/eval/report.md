# Skill dispatch 計測レポート

Issue: [u7chan/pi-lab#14](https://github.com/u7chan/pi-lab/issues/14)
計測日: 2026-09-21 / 対象: `skill-stash` 29 skills / model: `jev-1.13.0`（`jev-latest` の解決結果）

このレポートは #14 の閾値設計の根拠であり、skill-stash#36（Retriever 比較）と
#25（Retriever 実装）が同じ prompt セットと生データを使えるようにするための記録です。

## 方法

- prompt セット: [`eval/prompts.jsonl`](prompts.jsonl) 39 件
  - **covered 24 件**: roster のいずれかの Skill が適合する（各 Skill の description から作成）
  - **negative 15 件**: 適合する Skill が無い。うち 5 件は紛らわしい lookalike
    （Python スクリプト / AWS コスト最適化 / React の描画性能 / 命名相談 / Kubernetes）
- 1 prompt = 1 request。拡張が組み立てるのと同じ request（`buildDispatchRequest`）を送信
- 生の回答を `eval/results/latest.jsonl` に保存し、`sweep` はそこから閾値だけを振り直す
  （API の再呼び出し無し）
- 再現: `bun run eval/measure.ts run --roots ~/workspace/skill-stash` → `bun run eval/measure.ts sweep`

## 実測値

| 項目 | 値 |
|---|---|
| latency | **p50 218ms / p95 538ms / max 549ms**（avg 261ms） |
| input tokens | avg **4,031 / request**（roster 29 件込み） |
| cost | 4,031 × $0.042/MTok ≈ **$0.00017 / turn**（1,000 turn で約 $0.17） |
| roster 単体 | 29 skills / 4,417 字 / 約 3,092 tokens |

単発 `probe` で観測した 520ms / 468ms / 427ms は初回接続を含む値で、定常状態では
p50 218ms・p95 538ms でした。**コストは判断に影響せず、律速は latency の +0.2〜0.5s** です。

## 結果 1: Choice は 24/24 正解

covered 24 件で、**top choice が期待 Skill と全一致**しました。negative 15 件でも
`other` が 12 件で 1 位、残り 3 件は他 Skill を選びましたが confidence 0.28〜0.56 で、
いずれも閾値で止まります。jev-1.13 は日本語 description でも実用精度で動いています。

## 結果 2: abstain ゲートは `other` 確率が優位

判定方式を 2 通りで比較しました（`hit/wrong/FP/miss`）。

### gate: `P(other) <= X`（採用）

```text
conf\other  0.05      0.10      0.15      0.20      0.30      0.50
0.30        24/0/0/0  24/0/0/0  24/0/0/0  24/0/0/0  24/0/1/0  24/0/2/0
0.50        24/0/0/0  24/0/0/0  24/0/0/0  24/0/0/0  24/0/1/0  24/0/1/0
0.60        24/0/0/0  24/0/0/0  24/0/0/0  24/0/0/0  24/0/0/0  24/0/0/0
0.65        24/0/0/0  24/0/0/0  24/0/0/0  24/0/0/0  24/0/0/0  24/0/0/0
0.70        23/0/0/1  23/0/0/1  23/0/0/1  23/0/0/1  23/0/0/1  23/0/0/1
```

### gate: `mean(action nouls) >= X`（不採用）

```text
conf\noul   0.20      0.30      0.40      0.50      0.60      0.70
0.30        23/0/1/1  21/0/1/3  20/0/1/4  19/0/1/5  19/0/1/5  19/0/0/5
0.50        23/0/1/1  21/0/1/3  20/0/1/4  19/0/1/5  19/0/1/5  19/0/0/5
0.60        23/0/0/1  21/0/0/3  20/0/0/4  19/0/0/5  19/0/0/5  19/0/0/5
0.70        22/0/0/2  20/0/0/4  19/0/0/5  18/0/0/6  18/0/0/6  18/0/0/6
```

**noul ゲートは真陽性だけを削り、FP を削れていません。** 失敗した 5 件はすべて
「Skill 選択は正解、noul が低い」ケースです。

| prompt | 内容 | 正解 Skill | 選択 | want / task |
|---|---|---|---|---|
| go-teacher-1 | slice の挙動をメンタルモデルから**説明して** | go-teacher | 一致 | 0.06 / 0.19 |
| go-teacher-2 | goroutine と channel を**教えてほしい** | go-teacher | 一致 | 0.08 / 0.46 |
| streaming-2 | SSE/WebSocket の**判断基準がほしい** | agent-ui-streaming | 一致 | 0.14 / 0.26 |
| rag-1 | RAG が必要か**壁打ちしたい** | rag-system-design | 一致 | 0.24 / 0.43 |
| react-2 | 依存配列の設計を**どう直すべきか** | react-effect-discipline | 一致 | 0.32 / 0.60 |

原因は明確です。`wants_action` は「作業の実行を求めているか（説明だけではないか）」を問うため、
**学習・執筆・設計相談・可視化のように「説明や判断材料を求める」Skill が構造的に落ちます**。
公式 cookbook の noul ゲートは「ファイル編集や投稿など、何かをする roster」を前提にしており、
`skill-stash` の roster（teaching / writing / design）にはそのまま移せません。

一方 `P(other)` は「roster の中に適合するものがあるか」を直接表すため、この roster に合います。

## 判定: 採用する運用点

```jsonc
{
  "gate": "other",
  "otherThreshold": 0.15,   // 負例の最小 P(other)=0.21 に対して -0.06 の余裕
  "threshold": 0.65         // 負例の最大 confidence=0.56 に対して +0.09 の余裕
}
```

- 正例 24 件: `P(other)` は**すべて 0.00**、confidence は 0.68〜1.00
- 負例 15 件: `P(other)` は **0.21〜1.00**、他 Skill を選んだ場合の confidence は 0.28〜0.56
- 上の設定で **hit 24 / wrong 0 / FP 0 / miss 0**

2 つのゲートは独立に効きます。`P(other)` は「roster に無い依頼」を、
confidence は「近い Skill に引っ張られた誤選択」を止めます。
`threshold 0.7`（実装当初の既定）だと `orchestration-2`（confidence 0.68）が落ちるため、
**0.65 を推奨**します。ただし本番では `0.7` の保守側から始めても実害は 1 件の見逃しです。

## 誤り分析

| prompt | 期待 | 選択 | conf | P(other) | 実際の挙動 |
|---|---|---|---|---|---|
| orchestration-2 | orchestration-design | 一致 | 0.68 | 0.00 | conf 0.7 で miss → 0.65 で解消 |
| none-typeerror | (none) | language-teacher-template | 0.39 | 0.37 | 両ゲートで停止 |
| none-react-perf | (none) | react-effect-discipline | 0.56 | 0.21 | `other` ゲートで停止（最も際どい負例） |
| none-monad | (none) | visualize | 0.28 | 0.29 | 両ゲートで停止 |
| none-git | (none) | other | 0.44 | 0.47 | confidence 不足で停止 |

`none-typeerror` と `none-react-perf` は「roster に近い Skill がある」lookalike で、
**FP は confidence より `P(other)` が先に捕まえる**という設計判断を裏付けています。

## 制約（過大評価しないための注意）

- prompt は各 Skill の description から作成したため、実ユーザーの依頼より**易しい**可能性が高い
- 39 件・単一 model version（`jev-1.13.0`）・単一話者・日本語のみ。統計的な有意性は主張しない
- 1 ターン独立の評価で、会話文脈やマルチターンの影響は未検証
- 複数 Skill が必要な依頼、Session 中に既に Skill をロード済みのケースは未評価
- `otherThreshold 0.15` と `confidence 0.65` の余裕（0.06 / 0.09）は薄い。運用ログで再調整が必要

## skill-stash#36 / #25 との比較

このセットは Retriever 方式にもそのまま使えます。

- 同じ `eval/prompts.jsonl` を入力にする
- `eval/results/latest.jsonl` に Jev 側の生出力（top / confidence / probabilities / latency / tokens）
- 比較表に必要な列はすでに `decide` の入力として揃っている
  （`skill-stash#36` の「誤発動 / 見逃し / abstain / latency」と対応）

Retriever 側を同じ harness で走らせる場合、`run` の transport だけ差し替えれば
`sweep` をそのまま再利用できます。

## 次の実測

1. 実運用プロンプト（`logPrompts: true`）で p50/p95 と誤発動を再計測
2. `confidence 0.65` / `other 0.15` を実データで再調整
3. 2 パス目（shortlist 再ランク）を入れるかの判断 — 現状の誤りは閾値で説明できており、
   追加の 1 リクエスト（+0.2〜0.5s）に見合う FP 削減は観測できていない
