# Werift DataChannel core

`werift 0.24.4` の通常 entry から到達する core を、上流 artifact の検証済み bytes と下記の明示patchから生成する local package です。`RTCPeerConnection` は RTP 等の共通実装にも依存するため、それらの依存も保持します。通常 entry の依存閉包に含まれない `nonstandard`、RTP `extra`、その `mediabunny` 依存を配布・インストールしません。存在しない module への stub や runtime fallback はありません。

上流 npm artifact の SHA-512、選択した全ファイルの SHA-256、参照 commit、外部 import は [upstream-manifest.json](upstream-manifest.json) に固定しています。MIT の [LICENSE](LICENSE)、上流の [NOTICE](NOTICE)、元ファイルのコメントを保持します。これは上流 TypeScript compiler の再ビルドではなく、公開済み compiler 出力の再現可能な選択・検証です。

1 箇所の修正を [patches.json](patches.json) に明示しています。上流の DCEP OPEN は partial reliability の指定時に unordered bit を上書きするため、`channelType = 1 / 2` を bit OR に変更します（[RFC 8832 §5.1](https://www.rfc-editor.org/rfc/rfc8832.html#section-5.1)）。対象ファイルの修正前後の hash を検証し、他の上流コード・型宣言・source map はそのまま保持します。source map 内の元 TypeScript は修正前の上流版です。

root で依存を導入してから明示的に生成・検証します。Node.js 22 と root の TypeScript 開発依存が必要です。

```bash
npm ci --ignore-scripts
node vendor/werift-datachannel/materialize.mjs
node vendor/werift-datachannel/smoke.mjs
```

`materialize.mjs` は tar 全体の integrity と選択ファイルの hash を検証し、AST で JS と型宣言の import 閉包を確認します。動的 module 指定、依存欠落、予期しない外部 module、閉包外コードを拒否します。不要な media 領域はメモリ上で読み捨て、tar 自体を保存しません。ダウンロード timeout は `TRANSPORT_PREPARE_TIMEOUT_MS`（既定 30000 ms）で変更できます。

生成先 `.runtime/lib` はこの local package の `main` / `types` を相対解決するため vendor 配下に置く例外です。Git の `.runtime/` 除外が適用されます。clone 後や生成物削除後は再生成してください。配布時も生成物とライセンス通知を含む配置が必要です。外部由来の生成コードは bridge 自作 runtime のカバレッジ分母に含めません。

`smoke.mjs` は 2 peer を接続し、reliable ordered 2 本、unordered / maxRetransmits=0 の 1 本、patch 回帰確認用 unordered / maxPacketLifeTime の 1 本で、それぞれ 16 KiB payload を往復させます。待機上限は `TRANSPORT_SMOKE_TIMEOUT_MS`（既定 20000 ms）です。実ブラウザ、ROS、TURN、通信障害の検証は別途必要です。

maxPacketLifeTime の smoke は相手側の DCEP 属性と即時送受信だけを検証します。期限超過時の破棄動作・時刻単位は未検証であり、bridge v0.1 はこの配送方式を許可しません。

直接依存の version は [package.json](package.json)、検証した推移依存の version / license / integrity は [dependency-licenses.json](dependency-licenses.json)、通知本文は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にあります。実際の解決版は root lockfile を正本とし、lockfile 更新時は license manifest と通知も再照合してください。license は MIT、BSD-3-Clause、Apache-2.0、0BSD、Unlicense です。既知 advisory の照合だけで安全性全体を保証しません。

更新時は upstream version を単に差し替えず、依存閉包・選択ファイル・license・security advisory を再確認し、manifest と smoke の両方を更新します。
