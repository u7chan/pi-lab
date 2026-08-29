# AGENTS.md

## このリポジトリの目的

Piの自動コンパクション数を指標に、pi-issue-pr-workflowのタスク分解品質を事後トレーシングする研究。
目的・仮説・スコープは [PURPOSE.md](./PURPOSE.md)。

## 基本ルール

- **新規セッションでは最初に [HANDOFF.md](./HANDOFF.md) を読む**
- このフォルダは研究用。スキル本体・実PR・実Issueには**まだ一切変更を加えない**（変更は提案に留める）
- メトリクスは実データ（セッションファイル）からのみ算出する。捏造・推定値の混入禁止
- 会話・壁打ちは日本語でOK。コード・コメント・コミットメッセージは英語
- **検証で得た知見は、指示がなくてもドキュメントに反映し、記述完了後は自動コミットまで行う**

## 公開リポジトリのコミット前チェック（必須）

このリポジトリはリモートに **Public** 公開している。コミット前に以下を必ず確認する。

- **絶対に含めない**: APIキー・トークン・パスワード・秘密鍵などのクレデンシャル
- **含めない**: 実セッションファイルの中身（会話テキスト・`details.readFiles` の実パス一覧などの生データ）
- **要マスク**: 実セッションファイルのパス（`/home/<user>/...`、`~/.pi/agent/sessions/...`、UUID入りのタイムスタンプ名）、実リポジトリ名・実Issue/PR番号・ユーザー名
  → 必要ならプレースホルダ（例: `<session-path>`）に置換してからコミット
- ドキュメントに書いてよいのは**集計値のみ**（コンパクション数・tokensBefore合計・モデル名・窓サイズ）。rawデータのコピペ禁止

コミット前に以下を実行し、ヒット行を目視確認してからコミットする:

```bash
# 1) ステージ済み差分に機密パターンがないか
#    （ヒット＝即NGではない。「集計値」か「実データの生値」かを確認し、生値ならマスクor除外）
git diff --cached | grep -nEi "api[_-]?key|secret|passwd|BEGIN (RSA|OPENSSH|EC) |sk-[A-Za-z0-9]{16,}|/home/[a-z0-9_]+|\.pi/agent/sessions|issue-[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

# 2) セッションJSONLやバイトコードが誤ってステージされていないか
git status --short | grep -E "\\.jsonl|\\.pyc" || true
```

末尾にこのチェックが実行されたことをコミットメッセージやコメントで申告する必要はない（標準運用として全コミットで実施）。

### push 前チェック（全履歴対象・公開前の最終確認）

コミット前チェックは「差分」しか見ないため、**過去コミットに紛れた秘密情報やバイナリは検出できない**。push 前には全履歴を対象に再確認する:

```bash
# 1) 全履歴のテキストに機密パターンがないか
git grep -n -I -E "sk-[A-Za-z0-9]{16,}|ghp_|AKIA[0-9A-Z]{16}|-----BEGIN|api[_-]?key|/home/[a-z0-9_]+|\.pi/agent/sessions|issue-[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" -- $(git rev-list --all) || true

# 2) 履歴に入ってしまった JSONL / バイトコードの有無
git log --all --pretty=format: --name-only | grep -E "\\.jsonl|\\.pyc" | sort -u || true
```

**履歴に紛れた場合の復旧**（push 前なら安全。push 済みなら force push が必要になるため手順を確認してから行う）:

```bash
# 全履歴から対象ファイルを除去
git filter-branch --index-filter 'git rm --cached --ignore-unmatch <path>' --prune-empty -- --all

# filter-branch のバックアップ ref をパージ（残すと git log --all で旧履歴が見える）
git for-each-ref --format='%(refname)' refs/original/ | while read r; do git update-ref -d "$r"; done
git reflog expire --expire=now --all && git gc --prune=now
```

バイナリ（.pycなど）は直接 grep できないため、履歴から消えたかの確認は `git log --all --oneline -- <path>` の出力が空になることをもって確認する。

## 構成

- `PURPOSE.md` — 目的・リサーチクエスチョン・スコープ
- `HANDOFF.md` — 引き継ぎ（確認済み事実・未解決論点・次の一手）
- `count_compactions.py` — セッションファイルからコンパクションを集計するプロトタイプ
- `model_sessions.py` — コンパクションを当時のモデル（`model_change` 追跡）と照合し、`pi --list-models` の窓で正規化比を計算
- `collect_panel_compactions.py` — herdr 全パネルのコンパクションを後追い集計（`herdr agent list` の `agent_session.value` を使用、cwdフォールバック＋重複検出付き）
- `scan_over_272k.py` — gpt-5.6 系の 272K 超過リクエストを全セッションから検出（料金対策の効果測定用）

## 作業の流れ

1. 論点を壁打ちして決める（HANDOFF.md の「未解決・壁打ちしたい論点」）
2. プロトタイプを改善し、検証する
3. スキルへの最小差分の設計案をまとめる（実装は承認後）