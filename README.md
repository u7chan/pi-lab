# pi-lab

Pi ハーネス検証用リポジトリ

- 公式: https://pi.dev/
- 本番 OSS の確定方針: [本番 OSS への移行方針](docs/production-plan.md)

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

| ディレクトリ | 配布 | 移行状況 | 内容 |
|---|---|---|---|
| `u7chan-lab-cache-ttl` | 登録済み | 未移行 | outgoing payload から推定した prompt-cache TTL を footer に表示 |
| `u7chan-lab-cache-savings` | 登録済み | 未移行 | cache hit で払わずに済んだ推定額を footer に表示 |
| `u7chan-lab-minimal-footer` | 登録済み | 未移行 | token/cost 統計ブロックを除いた footer に差し替え |
| `u7chan-lab-default-model` | 登録済み | 未移行 | `/dm` と `set_default_model` で起動時の既定モデルを変更 |
| `u7chan-lab-git-status` | 登録済み | 未移行 | origin のリポジトリと現在ブランチの PR を footer にリンク表示 |
| `u7chan-lab-elapsed` | 登録済み | 未移行 | 指示から完了までの経過時間を working 行にライブ表示し、確定値を footer に残す |
| `u7chan-lab-skill-dispatch` | **未登録** | 対象外 | Jev（TypeSafe System One）で Skill を自動ルーティングする PoC（[#14](https://github.com/u7chan/pi-lab/issues/14)） |

「配布」列は `package.json` の `pi.extensions` と一致している必要があります
（`bun test tests/readme.test.ts` で検査しています）。

「移行状況」は別の本番リポジトリへの移行状況です。対象の 6 機能それぞれについて、
本番リポジトリへの移植・動作確認が完了したら「移行済み」に更新します。
「配布」とは独立して管理し、今回の対象に含めない PoC は「対象外」とします。
詳細は [移行状況の管理](docs/production-plan.md#移行状況の管理)を参照してください。

詳細は各ディレクトリの README を参照してください。
