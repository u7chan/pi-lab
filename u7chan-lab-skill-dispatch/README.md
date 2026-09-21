# Skill dispatch PoC

Issue #14 の PoC です。ユーザー入力の前段に Jev（TypeSafe の System One model）を置き、
`/skill:<name>` へ変換すべきかどうかを判定する構想のうち、**キー連携・config・PoC 用ファイル配置・
TypeSafe への疎通確認**までを実装した段階です。

`input` hook によるルーティング本体は未実装です（この README の末尾に残作業を記載）。

## 現在できること

```text
/skill-dispatch status   設定・キーの解決結果・fingerprint を表示
/skill-dispatch init     PoC 用ディレクトリと空のキーファイルを作成
/skill-dispatch probe    実際に System One を 1 回呼び、latency と使用トークンを表示
/skill-dispatch on|off   ルーティングの有効/無効を切り替え
/skill-dispatch purge    PoC 用ディレクトリを削除（marker で安全確認）
```

## ローカルでの実行

```sh
cd u7chan-lab-skill-dispatch
pi -e ./.pi/extensions/skill-dispatch.ts
```

リポジトリ直下の Pi package には**まだ登録していません**（ルーティング実装後に
`package.json` の `pi.extensions` へ追加します）。

## キーの置き場所

PoC が所有するものは 1 ディレクトリにまとめます。消すときはこのディレクトリだけを消せば済み、
既存のキー置き場（`~/.config/envs/` など）には触れません。

```text
~/.pi/agent/skill-dispatch-poc/     # PI_CODING_AGENT_DIR を尊重
├── poc.json                        # marker。purge はこれが一致するときだけ削除する
├── config.json                     # 非秘密の設定 (0600)
├── key.env                         # TYPESAFE_API_KEY=... (0600)
└── decisions.jsonl                 # 観測ログ（ルーティング実装後）
```

### キーの投入

`/skill-dispatch init` のあと、生成された `key.env` にキーを書きます。シェル履歴に残さない場合:

```sh
read -rsp 'TypeSafe API key: ' KEY
printf 'TYPESAFE_API_KEY=%s\n' "$KEY" > ~/.pi/agent/skill-dispatch-poc/key.env
unset KEY && chmod 600 ~/.pi/agent/skill-dispatch-poc/key.env
```

### 参照方法は 3 形式のみ

`config.json` の `typesafe.apiKeySource` で指定します。literal key は**サポートしません**
（config にキーを書く経路が存在しないようにしてあります）。

| 形式 | 例 | 用途 |
|---|---|---|
| `file:` | `file:~/.pi/agent/skill-dispatch-poc/key.env` | 既定。dotenv 形式（`export` / クォート / `JEV_API_KEY` alias 可） |
| `env:` | `env:TYPESAFE_API_KEY` | 一時検証用。既定にはしない |
| `command:` | `command:gpg -d ~/.pi/agent/skill-dispatch-poc/key.env.gpg` | 平文を置きたくない場合 |

```jsonc
// ~/.pi/agent/skill-dispatch-poc/config.json
{
  "enabled": false,
  "skillRoots": ["~/workspace/skill-stash"],
  "threshold": 0.7,
  "typesafe": {
    "apiKeySource": "file:~/.pi/agent/skill-dispatch-poc/key.env",
    "model": "jev-latest",
    "timeoutMs": 2000
  }
}
```

不正な値は既定へ戻したうえで warning を出します。`enabled` は既定 `false`（外部 API に
プロンプトを送るため、opt-in）。

## 設計上の制約

- **env を既定にしない**。`bash` ツールは Pi プロセスの env を継承するため、`TYPESAFE_API_KEY` を
  export すると `env` 経由で transcript と session JSONL に残り得ます。
- 表示・ログ・エラーにはキーを出さず、`sha256(key)` の先頭 12 文字と参照元だけを出します。
  `command:` は参照元も `command:(hidden)` とします。
- キーをチャット入力やコマンド引数から受け取りません（session に残るため）。
- `timeoutMs` の既定は 2000ms、retry は 0 回。1 ターンの前処理に載せる前提の fail-open 設計で、
  遅い・失敗する依存に対しては Pi の通常処理へ戻すだけにします。
- 同じユーザー権限で動く以上、`key.env` は悪意ある入力から `cat` され得ます。この設計が防ぐのは
  **env dump による context/セッション汚染**、**子プロセスへの継承**、**repo への誤コミット**です。
  悪意ある入力からの防御が必要になった段階では、キーを別プロセス（ローカル proxy）へ分離します。
  これは Issue の Out of Scope と整合します。

## 構成

```text
u7chan-lab-skill-dispatch/
├── .pi/extensions/skill-dispatch.ts   # コマンド面（薄い adapter）
├── src/
│   ├── key-source.ts                  # キー解決 (file:/env:/command:)、redact、fingerprint
│   ├── poc-store.ts                   # config の parse/serialize、marker、key file template
│   └── typesafe-client.ts             # System One transport（timeout / retry なし / fail-open）
└── tests/                             # bun test（ネットワーク不要、依存注入）
```

```sh
bun test u7chan-lab-skill-dispatch
```

## 残作業

- `input` hook によるルーティング（`src/dispatcher.ts` / `src/decision.ts`）
- `skillRoots` 配下の `*/SKILL.md` から `name` / `description` を集める（`src/skill-source.ts`）
- `resources_discover` へ同じ root を `skillPaths` として公開
- 観測ログ（`decisions.jsonl`）と誤発動・見逃しの記録
- 日本語プロンプトでの精度・latency の実測
