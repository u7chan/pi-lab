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
| `u7chan-lab-cache-ttl` | 登録済み | 移行済み | outgoing payload から推定した prompt-cache TTL を footer に表示 |
| `u7chan-lab-cache-savings` | 登録済み | 移行済み | cache hit で払わずに済んだ推定額を footer に表示 |
| `u7chan-lab-minimal-footer` | 登録済み | 移行済み | token/cost 統計ブロックを除いた footer に差し替え |
| `u7chan-lab-default-model` | 登録済み | 移行済み | `/dm` と `set_default_model` で起動時の既定モデルを変更 |
| `u7chan-lab-git-status` | 登録済み | 移行済み | origin のリポジトリと現在ブランチの PR を footer にリンク表示 |
| `u7chan-lab-elapsed` | 登録済み | 移行済み | 指示から完了までの経過時間を working 行にライブ表示し、確定値を footer に残す |
| `u7chan-lab-skill-dispatch` | **未登録** | 対象外 | Jev（TypeSafe System One）で Skill を自動ルーティングする PoC（[#14](https://github.com/u7chan/pi-lab/issues/14)） |

「配布」列は `package.json` の `pi.extensions` と一致している必要があります
（`bun test tests/readme.test.ts` で検査しています）。

「移行状況」は別の本番リポジトリへの移行状況です。対象の 6 機能それぞれについて、
本番リポジトリへの移植・動作確認が完了したら「移行済み」に更新します。
「配布」とは独立して管理し、今回の対象に含めない PoC は「対象外」とします。
詳細は [移行状況の管理](docs/production-plan.md#移行状況の管理)を参照してください。

移行先は [mypi](https://github.com/u7chan/mypi) です。対象６機能の移植・テストと、
実際の Pi 1.0.0 SDK / regular・fullscreen 対話 TUI での隔離検証を完了しています。
provider はローカル mock、PR ありのリンク表示は git/gh fixture で確認しました。
実サービスでの推定値と端末のリンククリックは未検証で、常用環境での外部拡張との共存は確認しています。
再現手順と残る確認は [mypi の移行記録](https://github.com/u7chan/mypi/blob/main/docs/migration.md)を参照してください。
常用環境の Pi package は mypi に切り替え済みです。`pi remove git:github.com/u7chan/pi-lab@main` で
pi-lab を外し、`pi install git:github.com/u7chan/mypi@main` で mypi を導入しました。
インストール済み mypi の隔離 smoke と、常用環境での実利用確認は完了しています。
pi-lab の配布 manifest と元コードは維持しています（mypi と同時にロードしないでください）。

詳細は各ディレクトリの README を参照してください。
