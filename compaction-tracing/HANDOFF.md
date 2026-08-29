# HANDOFF: コンパクション数によるタスク分解トレーシング

> このファイルを読めば新規セッションでも調査を継続できることを目指す。
> 目的・方針は [PURPOSE.md](./PURPOSE.md)、作業規約は [AGENTS.md](./AGENTS.md) を参照。

## 現状

調査スタート地点。**まだスキル・PR・Issueには何も手を入れていない**。以下は前セッションで確認済みの事実と合意事項。

## 確認済みの事実（一次情報）

piドキュメント（`~/.local/share/mise/installs/node/24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/`）より:

- **Hook（拡張イベント）**: `session_before_compact` / `session_compact` / `session_compact_failed` があり、
  `event.reason` で `"manual"` | `"threshold"` | `"overflow"` が取れる（threshold/overflow＝自動）
- **RPC**: `compaction_start` / `compaction_end` も同様に `reason` 付きで流れる（外部監視用）
- **セッションファイル**: `~/.pi/agent/sessions/<cwdを--で置換したディレクトリ>/<タイムスタンプ>_<id>.jsonl`
  に `{"type":"compaction","timestamp":...,"tokensBefore":N,...}` エントリが追記される
  - **`reason`（manual/threshold/overflowの区別）はセッションファイルに記録されない**
    → ファイル集計では自動/手動の区別不可。ただし本ワークフローでは手動 `/compact` を誰も実行しないため実害なし
  - `tokensBefore` あり。`details` にデフォルト実装では `readFiles` / `modifiedFiles` が入る
- **手動 `/compact` もファイルには同一形式で記録される**（ソース確認済み）: `appendCompaction()` は手動・自動どちらの経路も同じ引数で呼ばれ、`CompactionEntry` に `reason` フィールドは存在しない。`reason` が付くのは RPC の `compaction_start`/`compaction_end` と extension hook のみ → ファイル集計では手動も1回として数えられるが「手動かどうか」の判別は不可
- **`pi --list-models` に `context` 列がある**（例: deepseek-v4-flash=1M, gpt-5.4=272K, kimi-k2.6=262.1K）→ 正規化に使う窓は機械取得可能
- **herdr はパネル→セッションファイル対応を公開している**: `herdr agent list` / `herdr agent get <pane-id>` の JSON に `agent_session.value` としてセッションファイルのパスが含まれる
  → 「cwd基準のディレクトリ構成から直接決まらない」という前提は崩れた（論点4を再考）
- 各エージェントのbashツールには `$PI_SESSION_FILE`（自セッションのJSONLパス）が環境変数として注入される
  （`createBashTool()` の `exposeSessionEnvironment` による）

## 実地検証（このマシンで実施済み）

- `~/.pi/agent/sessions/` 配下 281 ファイル中 40 ファイルに compaction エントリを確認（前回 39 から 1 増）
- 全セッションファイルに `"/compact"` の痕跡ゼロ → このマシンの過去データはすべて自動コンパクション（手動の実データなし）
- 稼働中ワークフローの実データ: issue-131-impl セッション（モデル gpt-5.6-luna / 窓272K）で 2回 / tokensBefore合計 526,272
- 現セッションで `$PI_SESSION_FILE` の注入と `count_compactions.py`（0件→正常終了）を再確認
- 例: 2回 / tokensBefore合計 752,290 などの実データあり
- パースは「1行=1JSONオブジェクト」の行レベル `json.loads` で成功（埋め込み文字列との誤マッチなし）
- `jq` も `python3` も利用可能

## 前セッションで合意した設計方針

1. **検知方式は「セッションファイルの集計」**。ライブのフック/RPC監視は使わない
   （ランタイム変更不要・確実・パネルごとに設定不要）
2. **カウントはin-band報告**（各エージェントが成果報告に含める）を基本とする
   理由: オーケストレーターが子パネルのセッションファイルを特定するのは脆弱
   （パネル→セッションファイルの対応がcwd基準のディレクトリ構成から直接決まらない）
3. **PR作成時（開発フェーズ）**:
   `impl` がPR作成直前に自セッションを集計し、本文に `Process metrics` 風の小さなフッターとして含める
   （オーケストレーターが後から本文PATCHするのは不自然・リポジトリ指示の本文フォーマットと衝突しうる）
4. **レビューループ終了時**:
   `review` と `pr-fix`(impl) の成果報告に累積コンパクション数を含め、
   オーケストレーターが最終LGTM後にサマリーコメントを投稿する
5. **スキル変更は最小限に**。委譲契約への追記は「`count_compactions.py "$PI_SESSION_FILE"` を実行して数値を報告に含める」程度に留め、
   ロジックはすべてスクリプト側に寄せる
6. **指標は回数＋`tokensBefore`合計**。コンテキスト窓の異なるモデル間比較のため正規化が必要（未解決）

## 実装済み

- `count_compactions.py` — プロトタイプの集計スクリプト（後述の使い方）
- `model_sessions.py` — コンパクションを当時のモデル（`model_change` 追跡）と照合し、`pi --list-models` の窓で正規化比を計算する解析スクリプト
- 実データでの動作確認済み

## 未解決・壁打ちしたい論点

1. **正規化の設計**: 窓の取得は解決済み（`pi --list-models` の context 列、TSVパース）。
   実データ試算の結果、「tokensBefore/窓」比は272K窓で 0.94〜1.49 / 1M窓で 0.05〜0.29 とモデル依存が確認されたが、
   その差の主因は「threshold で説明できない小さいtokensBeforeのコンパクション」であり、**先にそちらの原因特定が必要**。
   実効窓（窓−reserveTokens 16384）で割ると 272K窓では比が ~1.0 に張り付き回数とほぼ等価
2. **分解品質は複合シグナルで判断すべきか**: コンパクション数＋Blocker数＋修正ラウンド数＋検証失敗数のどれを主指標にするか
3. **記録フォーマット**: PR本文フッターの具体形（例: `Process metrics: compactions=2 tokensBeforeSum=752290`）。
   マージ後も残るノイズを許容するか、`details.readFiles` から「どのファイルが捨てられたか」まで出すか
4. **in-band報告 vs オーケストレーター後追い**: `herdr agent get <pane-id>` の `agent_session.value` で
   パネル→セッションファイル対応が取れることを確認済み→ 後追い集計の障壁は低くなった。
   in-band報告とどちらが確実か再評価する（要: パネル未検出時のフォールバック設計）
5. **スキル変更の最小形**: pi-issue-pr-workflow のどのセクションに何行足すか（変更はまだしない）
6. **overflow コンパクションの扱い**: ファイルでは threshold/overflow の区別は不可（ソース確認済み）。
   実データで「threshold では説明できない小さい tokensBefore」が11件見つかったが、その後の調査で
   すべて「当時の実効窓」で説明可能と判明（overflow の実証ゼロ。243,797のerrorも中断で非overflow）。
   → フック/RPC方式の必要性は現状「低い」。ただし当時窓の推定は間接的であり、
   正規化を正確にしたい場合はフックで reason を記録する選択肢が残る

## 次にやること（新規セッションでの推奨開始点）

1. `AGENTS.md` と本ファイルを読む
2. 未解決論点を壁打ちして決める（特に 1. 正規化 と 4. 報告経路）
3. 決まったらプロトタイプを改善し、スキルへの最小差分を設計する（実装はしない・提案に留める）

## 環境メモ

- 検証に使った実データ例: `~/.pi/agent/sessions/--home-u7dev-workspace-agent-harness--/2026-08-22T12-17-01-826Z_01a02967-2982-7b62-b515-0e93b4a5aea6.jsonl`（2回 / 752,290、detailsに `readFiles`/`modifiedFiles` あり）
- herdr 0.8.2 が `agent_session` 対応（`herdr agent list` / `get` でJSON出力）
- ツール: `jq` / `python3` あり。pi本体は mise 経由の node 24.18.0 に同梱

## 検証ログ（2026-08-29 その3）: 「小さいtokensBeforeの謎」の解明

- コンパクション発火経路をソースで全列挙（4系統）:
  1) ユーザープロンプト処理開始時 `_checkCompaction(lastAssistant, !1)`（aborted でもスキップしない）
  2) エージェントラン終了時 `_handlePostAgentRun`
  3) 次のアシスタント応答前 `_compactBeforeNextAssistantResponse`
  4) overflow パス（`stopReason=error` のエラーパターン判定、または `stop && input+cacheRead > 窓`）
- `tokensBefore` の正体: `usage.totalTokens`（または推定値）= 当時の実効プロンプトサイズ。
  異常11件すべてで totalTokens と完全一致（例: input1,413+cache96,768+output370=98,551）
- **結論: 異常11件は「当時の実効窓」で threshold 説明可能**。現在カタログ（1M/272K）との乖離が「異常」に見えただけ:
  - 243,797（deepseek-v4-flash 8/19）→ 当時窓 ~256K なら発火圏内
  - 45,143/53,517（zai/glm-5.3-flash 8/29）→ 当時窓 ~60-70K なら発火圏内
  - 36,622（モデル切替直後）→ 切替先の小さい窓で発火圏内
  - 98,551（gpt-5.6-sol 8/22）→ 当時窓 <260K なら発火圏内（同日の255K発火とは別モデル設定の可能性）
- **overflow の実証ゼロ**: 唯一 error を含んだ 243,797 のケースも errorMessage="This operation was aborted"
  （ユーザー中断）で NON_OVERFLOW パターン。確認した範囲では overflow コンパクション実例なし
- 「窓が当時小さい」ことはカタログ履歴が失われていて直接検証不可（間接証拠のみ）

**正規化への含意**: 過去データの `tokensBefore/現在窓` 比は不正確（当時窓不明）。
将来の計測では「モデルID＋計測時点の窓」を一緒に記録する。（候補2の後追い集計で取り込む）

## 検証ログ（2026-08-29 その2）: 正規化の実データ試算

- 40セッション・49コンパクションを `model_change` 追跡でモデル照合し、`tokensBeforeSum / 窓` を試算（`model_sessions.py`）
- **272K窓モデル（gpt-5.6-luna/sol）**: tokensBefore は 255K〜284K に集中。しきい値 窓−16K(256K) に一致 → threshold コンパクションの動作を裏付け。比は 0.94〜1.49 で、実効窓で割ると ~1.0 に張り付く（≈回数と等価）
- **1M窓モデル（deepseek系/glm-5.3-flash 等）**: しきい値~984K なのに 32K〜244K で発生 → **threshold で説明できないコンパクションが10件存在**。モデル切替直後は1件のみ、設定はデフォルト、手動痕跡なし（原因未特定・overflow とも断定できず）
- 比は 272K窓 0.94〜1.49 / 1M窓 0.05〜0.29 → 生の回数はモデル比較に不向きという仮説は実証。ただし差の主因は上記の「小さいtokensBefore」現象であり、原因特定が先
- `pi --list-models` はTSV（`--json` なし）。context 列は 272K/1M 形式でパース可能

## 検証ログ（2026-08-29）

- `PI_SESSION_FILE` 注入・`count_compactions.py` 動作・実データ集計（40/281ファイル）を再確認
- 手動/自動の同一エントリ記録をソース（bundle内 `appendCompaction` 呼び出し3箇所）で確認
- `pi --list-models` の context 列、`herdr agent get` の `agent_session.value` を確認