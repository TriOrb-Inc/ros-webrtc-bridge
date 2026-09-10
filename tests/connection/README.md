# ブラウザから実ROSまでの接続試験

`npm run test:connection`はHumbleとJazzyを順に検証します。Dockerを直接実行できるLinux host、Node.js 22、npm依存、Playwright Chromium、OpenSSLが必要です。Docker DesktopのVMを跨ぐ接続は未検証です。hostから専用Docker networkのcontainer IPへ到達できる構成を使います。

```bash
npm ci --ignore-scripts
npm run prepare:transport
npx playwright-core install chromium
npm run test:connection
```

build時はimage・npm artifact取得の外向き接続を使います。試験時はjob固有の`--internal` networkにGateway、独立rclpy node、coturnを置きます。DDSはdomain 73と`/bridge_test` namespaceを使用し、異なるjobは別networkで隔離します。host networkやhostのROS graphを使いません。HTTPSはcontainer IPの7443へ接続し、host portを公開しません。

Gatewayの一時Bearer、TLS key/cert、TURN credentialを毎回生成します。所有者だけが読める一時directoryをread-only mountし、containerはrootで読みます。試験後は秘密ファイルを削除します。試験用自己署名証明書はPlaywrightの専用contextでのみ許容します。これは公開運用のTLS・credential管理手順ではありません。

| 設定 | 既定値・意味 |
| --- | --- |
| `CONNECTION_DISTROS` | `humble,jazzy`。単独調査では`humble`または`jazzy` |
| `CONNECTION_TURN` | `0`だけがTURN省略。既定は両経路を実行 |
| Gateway設定 | [connection.yaml](../../examples/connection.yaml)。別名、型、QoS、250ms leaseを固定 |
| build/pull | 各900秒／180秒で打切り |
| readiness | 全体30秒、個々のHTTPS要求1秒 |
| browser helper | setupとscenario共通で各経路120秒、引数`timeoutMs`で1〜600秒へ変更可能。終了処理はclose・kill・終了確認に各3秒 |
| ROS peer | 本harnessでは360秒、環境変数で対向nodeに注入 |

4秒ごとに工程を表示します。`tests/browser/connection.ts`は実Chromiumを起動し、ブラウザ内のraw clientが3本のDataChannelを作ります。製品SDKを使った試験ではありません。`tests/ros/peer.py`はbridgeのcodecを共有しない独立対向nodeです。

- Stringの固有markerをWeb→ROS→Webで照合。
- 実行固有の値を含む完全なTwistをpublishし、独立ROS nodeの観測した全fieldを照合。受信channel・stream・epochも検証する。
- 期限切れlease・旧epochを拒否し、観測windowで不正commandを受信しないことを確認。拒否した値は以後の全受信でも監視し、拒否の前後に正常な対照commandを流す。
- 初回と2回の再接続でepoch非再利用を確認。古いcommandを再送しない。
- `getStats()`の選択candidate pairを確認。TURN経路ではブラウザの`relay-only`を強制し、選択local candidateが`relay`でなければ失敗。

検証済み構成はLinux arm64、ROS Humble/Jazzy、Fast DDS、Node 22.22.2、rclnodejs 2.2.0の同梱prebuilt、Playwright 1.63.0 / Chromium 153.0.8010.12、coturn 4.6.3です。directとTURN UDPが対象です。amd64、native addonのsource compile、TURN TCP/TLS、UDP遮断、QoS不一致、負荷・長時間試験、controller watchdogはこの結果に含みません。

各実行の機密を除いた結果とbuild診断はroot `.runtime/`へ保存します。最終集計は`connection-results.json`、各distroの作業directoryにimage IDと詳細結果を保存します。失敗後の再実行は別directoryへ記録します。成否を問わずcontainerとnetworkを解放し、後始末の失敗もtest失敗として報告します。
