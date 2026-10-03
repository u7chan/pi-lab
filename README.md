# pi-lab

Piハーネス検証用リポジトリ

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

移行の凡例は、✅が移行済み、—が対象外です。

| ディレクトリ | 移行 | 内容 |
|---|---|---|
| `u7chan-lab-cache-ttl` | ✅ | outgoing payload から推定した prompt-cache TTL を footer に表示 |
| `u7chan-lab-cache-savings` | ✅ | cache hit で払わずに済んだ推定額を footer に表示 |
| `u7chan-lab-minimal-footer` | ✅ | token/cost 統計ブロックを除いた footer に差し替え |
| `u7chan-lab-default-model` | ✅ | `/dm` と `set_default_model` で起動時の既定モデルを変更 |
| `u7chan-lab-git-status` | ✅ | origin のリポジトリと現在ブランチの PR を footer にリンク表示 |
| `u7chan-lab-elapsed` | ✅ | 指示から完了までの経過時間を working 行にライブ表示し、確定値を footer に残す |
| `u7chan-lab-skill-dispatch` | — | Jev（TypeSafe System One）で Skill を自動ルーティングする PoC（[#14](https://github.com/u7chan/pi-lab/issues/14)） |

配布対象外: `u7chan-lab-skill-dispatch`。
それ以外は `package.json` の `pi.extensions` に登録し、`pi install` で配布しています。
配布対象外の PoC は通常の Pi 起動では読み込まれず、`pi -e` で明示的に読み込んだときだけ動きます。
一覧と配布対象外の注記は、`bun test tests/readme.test.ts` で検査しています。

移行欄は、本番リポジトリへの移植・動作確認の状況です。配布状況とは独立して管理します。
詳細は[移行状況の管理](docs/production-plan.md#移行状況の管理)を参照してください。

移行先は[mypi](https://github.com/u7chan/mypi)です。対象6機能の移植・テストと、
実際の Pi 1.0.0 SDK / regular・fullscreen 対話 TUI での隔離検証を完了しています。
providerはローカルmock、PRありのリンク表示はgit/gh fixtureで確認しました。
実サービスでの推定値と端末のリンククリックは未検証で、常用環境での外部拡張との共存は確認しています。
再現手順と残る確認は [mypi の移行記録](https://github.com/u7chan/mypi/blob/main/docs/migration.md)を参照してください。
常用環境のPi packageはmypiに切り替え済みです。`pi remove git:github.com/u7chan/pi-lab@main`で
pi-labを外し、`pi install git:github.com/u7chan/mypi@main`でmypiを導入しました。
インストール済みmypiの隔離スモークテストと、常用環境での実利用確認は完了しています。
pi-labの配布manifestと元コードは維持しています。mypiと同時にロードしないでください。

詳細は各ディレクトリの README を参照してください。
