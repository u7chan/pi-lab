# pi-lab

Pi ハーネス検証用リポジトリ

- 公式: https://pi.dev/

## インストール

リポジトリ直下の `package.json` が `u7chan-lab-*` の拡張を 1 つの Pi package として
配布します。

```sh
pi install git:github.com/u7chan/pi-lab@main
```

`@main` (rolling) なので、更新は次の 1 コマンドで `origin/main` の最新へ追従します。

```sh
pi update --extensions
```

- 常時ロードする範囲は `pi config` で拡張ごとに切り替えられます。

## PoC 一覧

「配布」は `package.json` の `pi.extensions` に登録され、`pi install` でユーザーに届くもの。
未登録のものは通常の Pi 起動では読み込まれず、`pi -e` で明示的に読み込んだときだけ動きます。

| ディレクトリ | 配布 | 内容 |
|---|---|---|
| `u7chan-lab-cache-ttl` | 登録済み | outgoing payload から推定した prompt-cache TTL を footer に表示 |
| `u7chan-lab-cache-savings` | 登録済み | cache hit で払わずに済んだ推定額を footer に表示 |
| `u7chan-lab-minimal-footer` | 登録済み | token/cost 統計ブロックを除いた footer に差し替え |
| `u7chan-lab-default-model` | 登録済み | `/dm` と `set_default_model` で起動時の既定モデルを変更 |
| `u7chan-lab-git-status` | 登録済み | origin のリポジトリと現在ブランチの PR を footer にリンク表示 |
| `u7chan-lab-skill-dispatch` | **未登録** | Jev で Skill を自動ルーティングする PoC（Issue #14 / PR #15） |

詳細は各ディレクトリの README を参照してください。
