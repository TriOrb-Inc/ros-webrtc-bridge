# Werift DataChannel core

`werift 0.24.4` の通常 entry から到達する core を、同梱した検証済み bytes から生成する local package です。`RTCPeerConnection` は RTP 等の共通実装にも依存するため、それらの依存も保持します。通常 entry の依存閉包に含まれない `nonstandard`、RTP `extra`、その `mediabunny` 依存を配布・インストールしません。存在しない module への stub や runtime fallback はありません。

通常buildの入力は [prepared-core](prepared-core) の選択・patch済みJS/型宣言300 files（1,162,127 bytes）です。[prepared-manifest.json](prepared-manifest.json) に各fileのpatch後SHA-256、参照commit、entry、外部import、notice hashを固定しています。上流npm artifactのSHA-512とpatch前fileのSHA-256は、maintainer更新用の [upstream-manifest.json](upstream-manifest.json) に分離しています。MIT の [LICENSE](LICENSE)、上流の [NOTICE](NOTICE)、元fileのcommentを保持します。これは上流TypeScript compilerの再buildではなく、公開済みcompiler出力の選択・検証です。

1 箇所の修正を [patches.json](patches.json) に明示しています。上流の DCEP OPEN は partial reliability の指定時に unordered bit を上書きするため、`channelType = 1 / 2` を bit OR に変更します（[RFC 8832 §5.1](https://www.rfc-editor.org/rfc/rfc8832.html#section-5.1)）。更新時に対象fileの修正前後のhashと一意置換を検証し、通常buildでもpatch後hashを再検証します。

rootで依存を導入してから明示的に生成・検証します。Node.js 22とrootのTypeScript開発依存が必要です。通常の`materialize.mjs`はURLを読まず、networkやnpm cacheへfallbackしません。

```bash
npm ci --ignore-scripts
node vendor/werift-datachannel/materialize.mjs
node vendor/werift-datachannel/smoke.mjs
```

`materialize.mjs`はlocal inputの完全なfile集合とhashを検証し、ASTでJSと型宣言のimport閉包を確認します。動的module指定、依存欠落、予期しない外部module、閉包外code、notice差分を拒否します。全検証とstageへのwriteが終わってから`.runtime/lib`を切り替えるため、途中生成物をruntimeとして公開しません。

upstream更新は通常buildと分離したmaintainer操作です。network接続できる環境で`upstream-manifest.json`、license一覧、notice、patchをreviewしてから次を実行し、`prepared-core`と`prepared-manifest.json`の差分をcommitします。download timeoutは`TRANSPORT_REFRESH_TIMEOUT_MS`（既定30000 ms）で変更できます。

```bash
node vendor/werift-datachannel/refresh.mjs
node vendor/werift-datachannel/materialize.mjs
node vendor/werift-datachannel/smoke.mjs
```

`prepare:transport`からrefreshへ到達するnpm lifecycle hookや自動downloadは追加しません。root packageにmaintainer用shortcutを追加する場合のscript名は`refresh:transport`とし、上記`refresh.mjs`だけを呼びます。

生成先`.runtime/lib`はこのlocal packageの`main` / `types`を相対解決するためvendor配下に置く例外です。Gitの`.runtime/`除外が適用されます。clone後や生成物削除後はlocal inputから再生成してください。配布時も生成物とlicense通知を含む配置が必要です。外部由来の生成codeはbridge自作runtimeのcoverage分母に含めません。

source mapは実行・型解決・依存閉包に不要で、上流TypeScript本文も内包するためlocal inputへ含めません。生成JS末尾の`sourceMappingURL` commentは動作へ影響せず、mapなしの4 DataChannel smokeで確認しています。`--enable-source-maps`を使った上流TypeScript位置へのstack trace変換は、この縮小配布物では利用できません。

`smoke.mjs` は 2 peer を接続し、reliable ordered 2 本、unordered / maxRetransmits=0 の 1 本、patch 回帰確認用 unordered / maxPacketLifeTime の 1 本で、それぞれ 16 KiB payload を往復させます。待機上限は `TRANSPORT_SMOKE_TIMEOUT_MS`（既定 20000 ms）です。実ブラウザ、ROS、TURN、通信障害の検証は別途必要です。

maxPacketLifeTime の smoke は相手側の DCEP 属性と即時送受信だけを検証します。期限超過時の破棄動作・時刻単位は未検証であり、bridge v0.1 はこの配送方式を許可しません。

直接依存の version は [package.json](package.json)、検証した推移依存の version / license / integrity は [dependency-licenses.json](dependency-licenses.json)、通知本文は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にあります。実際の解決版は root lockfile を正本とし、lockfile 更新時は license manifest と通知も再照合してください。license は MIT、BSD-3-Clause、Apache-2.0、0BSD、Unlicense です。既知 advisory の照合だけで安全性全体を保証しません。

更新時は upstream version を単に差し替えず、依存閉包・選択ファイル・license・security advisory を再確認し、manifest と smoke の両方を更新します。
