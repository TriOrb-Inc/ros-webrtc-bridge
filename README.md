# ros-webrtc-bridge

ROS 2 TopicのPub/SubをWebRTC DataChannelへ双方向に接続するOSSです。現在は接続PoC段階で、Humble／JazzyのDocker環境と実Chromium間の双方向通信、直接接続・TURN UDP、install済みROS packageを検証しています。

[設計検討書](docs/design.md)に、構成、プロトコル、QoS、型変換、認証、MVPと検証計画をまとめています。

基本方針は、設定で公開Topicと方向を限定し、ROS 2のQoSとWebRTCの配送方針を別々に定義することです。初期版ではブラウザとの小〜中サイズのメッセージ交換を対象とします。

初期対応対象はROS 2 HumbleとJazzyとし、Dockerでdistroごとに検証します。Web公開名は原則ROS Topic名と一致させ、YAMLで別名も指定できる設計です。

## 実装と実行

- [設定](packages/bridge/src/config/README.md): YAML検証、公開名とROS接続先の解決、保護条件の衝突検出。
- [codec](packages/bridge/src/codec/README.md): 明示した型descriptorによるJSON変換、64bit整数・base64・bounded値の検証。
- [session](packages/bridge/src/session/README.md): commandのlease・sequence・所有権検証、peerごとの有限queue。
- [ROS adapter](packages/bridge/src/ros/README.md): 型descriptor生成、rclnodejs値の正規化、固定ROS entityとlogical listener。
- [router](packages/bridge/src/router/README.md): wire v1、ready、catalog、Pub/Sub、認可・rate・再接続。
- [起動・HTTPS](packages/bridge/src/app/README.md): 単一Bearerの明示権限、TLS、3 DataChannel、資源解放。

Node.js 22（22.12以上、検証版22.22.2）で実行できます。

```bash
npm ci --ignore-scripts
npm run prepare:transport
npm run typecheck
npm test
```

`npm test`はbuild、単体・結合試験、ファイルごとのC0/C1 100%判定を実行します。生成物はGit管理外の`.runtime/`へ出力します。transportは[ライセンス適合を確認した同梱werift core](vendor/werift-datachannel/README.md)をnetworkなしで検証・生成します。

Linux Docker hostで接続試験を再現できます。

```bash
npx playwright-core install chromium
npm run test:connection
```

Humble／Jazzyごとに専用networkでinstall済みGateway、独立rclpyノード、coturnを起動し、String／Twist、外部packageの独自BridgeFrame、期限切れcommand拒否、再接続、選択ICE候補を実測します。成否を問わずcontainer・network・一時credentialを解放します。[接続試験の前提と設定](tests/connection/README.md)を確認してください。

性能回帰は`npm run test:performance`、長時間profileは`npm run test:soak`で、実WebRTC→ROS→Web RTT、throughput、CPU/RSS、cleanupを測定します。共有runnerの値は絶対性能保証ではありません。[性能harness](tests/performance/README.md)にprofileと未計測項目を記載しています。

常駐起動は、ROS環境でnative依存を準備し、[起動設定](packages/bridge/src/app/README.md)を注入して`npm run bridge`を使います。ブラウザSDK、外向きrendezvous、多ユーザー認証、通信障害の全条件は未整備です。対応範囲と残件は[設計書 §14](docs/design.md#14-モジュール試作の契約と残る接続境界)に記載しています。

HTTPS serverと同じoriginの `/docs` でSwagger UIを閲覧できます。HTTP仕様は `/openapi.json` と `/openapi.yaml` で取得できます。対象は `GET /health` とBearer認証付き `POST /offer` です。Topic Pub/SubはDataChannel契約でありRESTではありません。UIは同梱assetを使い、外部validator通信と認証値の永続保存を無効にしています。

## ROS 2 packageとして使う

ROS package名は`ros_webrtc_bridge`です。ROS環境でrclnodejsを準備した後、ament/colconでbuild・installできます。

```bash
source /opt/ros/<distro>/setup.bash
npm ci --ignore-scripts
npm rebuild rclnodejs --foreground-scripts
colcon build --packages-select ros_webrtc_bridge
source install/setup.bash
```

credentialとTLS鍵・証明書はcommand lineへ書かず、`BRIDGE_CREDENTIAL`、`BRIDGE_TLS_KEY`、`BRIDGE_TLS_CERT`として実行環境から注入します。Topicの購読・publish権限も既存のdefault denyを維持します。

```bash
export BRIDGE_CONFIG="$(ros2 pkg prefix ros_webrtc_bridge)/share/ros_webrtc_bridge/examples/bridge.yaml"
ros2 run ros_webrtc_bridge ros_webrtc_bridge
ros2 launch ros_webrtc_bridge bridge.launch.py
```

launchはinstall済み`examples/bridge.yaml`を既定設定にし、`config`、`host`、`port`、`node_name`をlaunch argumentで上書きできます。任意設定が参照するROS interface packageはdeployment側packageで依存宣言し、同じROS環境でrclnodejs bindingを再生成してください。詳細とCMake option、検証範囲は[ROS package化](docs/ros-packaging.md)を参照してください。

PR作成・再オープン・PRブランチへの追加pushでは、[GitHub Actions](.github/workflows/ci.yml)が単体・結合・カバレッジ・transport試験と、Humble／Jazzy、arm64／amd64、Fast DDS／Cyclone DDSの1軸差分matrixで実ROS・Chromium・colcon package外装試験を実行します。[性能workflow](.github/workflows/performance.yml)はPRで短時間回帰、週次と手動実行で1時間soakを行います。draft PRと文書変更も対象です。[CIの範囲と結果の確認](TESTS.md#8-ciと対応matrix)を参照してください。

## 開発・運用文書

- [CONTRIBUTING.md](CONTRIBUTING.md): 共通の開発規約、検証、依存ライセンス方針。
- [TESTS.md](TESTS.md): テスト設計、受け入れ条件、カバレッジ測定、CIとリリースの判定方針。
- [docs/ros-packaging.md](docs/ros-packaging.md): colcon build、install layout、実行、動的interface依存。
- [AGENTS.md](AGENTS.md): エージェントの作業手順と計画・開発・QAの3チーム運用。
- [SECURITY.md](SECURITY.md): セキュリティ要件と脆弱性報告の現状。

## ライセンス

[Apache License 2.0](LICENSE)。依存ライブラリのライセンスは個別に確認します。
