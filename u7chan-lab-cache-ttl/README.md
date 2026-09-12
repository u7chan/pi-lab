# Prompt-cache TTL footer PoC

Issue #1 の PoC です。リポジトリ直下からこのディレクトリへ移動します。

```sh
cd u7chan-lab-cache-ttl
```

## インストール

リポジトリ直下の Pi package に含まれています。

```sh
pi install git:github.com/u7chan/pi-lab@main
```

package は `u7chan-lab-*` の 5 拡張をまとめて配布します。この拡張だけを使う場合は
`pi config` で他を OFF にしてください。更新は `pi update --extensions` です。

明示的に拡張を読み込んで起動する場合:

```sh
pi --extension ./.pi/extensions/cache-ttl.ts
```

プロジェクト拡張として通常の Pi 起動から読み込む場合は、このディレクトリを信頼したうえで
`cache-ttl` から `pi` を起動します。

拡張は `before_provider_request` の outgoing payload と assistant message の usage を観測し、
Footer に次の status segment を追加します。

```text
CACHE 04:31
CACHE expired
CACHE pending
CACHE auto
CACHE hit
CACHE unsupported
CACHE unknown
```

`cache_control.ttl` / `cacheControl.ttl`、`cachePoint.ttl`、
`prompt_cache_retention`、`prompt_cache_options.ttl` を検出し、同じ payload に複数ある場合は
最短値を使います。TTL が省略された短い cache directive、`options.cacheRetention: "short"`、
`prompt_cache_key` 単独は provider の短い既定値（5分）として表示します。`long`、`none`、
不明な値は `CACHE unknown` です。session/model を開始しただけでまだ provider request がない
場合は `CACHE pending`、request は発生したが cache metadata がない場合は
`CACHE unsupported` です。DeepSeek / Z.AI のように cache metadata を request に持たず
provider 側で暗黙にキャッシュする provider は `CACHE auto` と表示します。`opencode-go`
のような複数モデルを束ねる gateway provider では provider 名が一致しないため、outgoing
payload の `model` が `deepseek-*`（OpenRouter 形式の `deepseek/...` を含む）のような
既知の暗黙キャッシュ family なら `CACHE auto` と判定します。レスポンスの
`usage.cacheRead` が正のときは `CACHE hit` と表示します。これらは provider がTTLを公開しない
ため、カウントダウンは表示しません。直接の
`prompt_cache_retention` は `24h` などの duration のみを確定値として扱い、未指定や
`short` / `in_memory` のように provider に依存する既定値は推測しません。

表示は provider が返す実際の expiry ではなく、request 開始時刻を基準にした推定値です。
モデル変更、session 切り替え、shutdown、cache metadata のない新しい request では古い時計を
破棄します。タイマーは absolute expiry から毎回残り時間を再計算し、`unref()` しています。
表示は Codex adapter と同じく、`CACHE` ラベルを accent 色、残り時間や状態を dim 色で描画します。

テスト:

```sh
cd u7chan-lab-cache-ttl
bun test
```
