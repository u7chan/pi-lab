# pi-lab

Pi ハーネス検証用リポジトリ

- 公式: https://pi.dev/

## Prompt-cache TTL footer PoC

Issue #1 の PoC は `.pi/extensions/cache-ttl.ts` にあります。明示的に読み込む場合:

```sh
pi --extension ./.pi/extensions/cache-ttl.ts
```

プロジェクト拡張として通常の Pi 起動から読み込む場合は、プロジェクトを信頼したうえで
リポジトリ直下から `pi` を起動します。

拡張は `before_provider_request` の outgoing payload を観測し、Footer に次の status
segment を追加します。

```text
CACHE 04:31
CACHE expired
CACHE pending
CACHE unsupported
CACHE unknown
```

`cache_control.ttl` / `cacheControl.ttl`、`cachePoint.ttl`、
`prompt_cache_retention`、`prompt_cache_options.ttl` を検出し、同じ payload に複数ある場合は
最短値を使います。TTL が省略された短い cache directive、`options.cacheRetention: "short"`、
`prompt_cache_key` 単独は provider の短い既定値（5分）として表示します。`long`、`none`、
不明な値は `CACHE unknown` です。session/model を開始しただけでまだ provider request がない
場合は `CACHE pending`、request は発生したが cache metadata がない場合は
`CACHE unsupported` です。直接の
`prompt_cache_retention` は `24h` などの duration のみを確定値として扱い、未指定や
`short` / `in_memory` のように provider に依存する既定値は推測しません。

表示は provider が返す実際の expiry ではなく、request 開始時刻を基準にした推定値です。
モデル変更、session 切り替え、shutdown、cache metadata のない新しい request では古い時計を
破棄します。タイマーは absolute expiry から毎回残り時間を再計算し、`unref()` しています。

テスト:

```sh
bun test
```
