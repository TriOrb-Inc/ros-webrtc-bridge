# ros-webrtc-bridge

ROS 2 TopicのPub/SubをWebRTC DataChannelへ双方向に接続するOSSです。現在は接続PoC段階で、Humble／Jazzyのarm64 Docker環境と実Chromium間の双方向通信、直接接続・TURN UDPを検証しています。

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

`npm test`はbuild、単体・結合試験、ファイルごとのC0/C1 100%判定を実行します。生成物はGit管理外の`.runtime/`へ出力します。transportは[ライセンス適合を確認したwerift core](vendor/werift-datachannel/README.md)を明示生成します。

Linux Docker hostで接続試験を再現できます。

```bash
npx playwright-core install chromium
npm run test:connection
```

Humble／Jazzyごとに専用networkでGateway、独立rclpyノード、coturnを起動し、String／Twist、期限切れcommand拒否、再接続、選択ICE候補を実測します。成否を問わずcontainer・network・一時credentialを解放します。[接続試験の前提と設定](tests/connection/README.md)を確認してください。

常駐起動は、ROS環境でnative依存を準備し、[起動設定](packages/bridge/src/app/README.md)を注入して`npm run bridge`を使います。ブラウザSDK、外向きrendezvous、多ユーザー認証、通信障害・性能試験は未整備です。対応範囲と残件は[設計書 §14](docs/design.md#14-モジュール試作の契約と残る接続境界)に記載しています。

PR作成・再オープン・PRブランチへの追加pushでは、[GitHub Actions](.github/workflows/ci.yml)が単体・結合・カバレッジ・transport試験と、Humble／Jazzyの実ROS・Chromium・TURN UDP試験を実行します。draft PRと文書変更も対象です。[CIの範囲と結果の確認](TESTS.md#8-ciと対応matrix)を参照してください。

## 開発・運用文書

- [CONTRIBUTING.md](CONTRIBUTING.md): 共通の開発規約、検証、依存ライセンス方針。
- [TESTS.md](TESTS.md): テスト設計、受け入れ条件、カバレッジ測定、CIとリリースの判定方針。
- [AGENTS.md](AGENTS.md): エージェントの作業手順と計画・開発・QAの3チーム運用。
- [SECURITY.md](SECURITY.md): セキュリティ要件と脆弱性報告の現状。

## ライセンス

[Apache License 2.0](LICENSE)。依存ライブラリのライセンスは個別に確認します。
