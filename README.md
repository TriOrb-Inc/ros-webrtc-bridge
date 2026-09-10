# ros-webrtc-bridge

ROS 2 TopicのPub/SubをWebRTC DataChannelへ双方向に接続するOSSです。現在は構想設計と独立モジュールの試作段階で、実行可能なブリッジは未実装です。

[設計検討書](docs/design.md)に、構成、プロトコル、QoS、型変換、認証、MVPと検証計画をまとめています。

基本方針は、設定で公開Topicと方向を限定し、ROS 2のQoSとWebRTCの配送方針を別々に定義することです。初期版ではブラウザとの小〜中サイズのメッセージ交換を対象とします。

初期対応対象はROS 2 HumbleとJazzyとし、Dockerでdistroごとに検証します。Web公開名は原則ROS Topic名と一致させ、YAMLで別名も指定できる設計です。

## モジュール試作

- [設定](packages/bridge/src/config/README.md): YAML検証、公開名とROS接続先の解決、保護条件の衝突検出。
- [codec](packages/bridge/src/codec/README.md): 明示した型descriptorによるJSON変換、64bit整数・base64・bounded値の検証。
- [session](packages/bridge/src/session/README.md): commandのlease・sequence・所有権検証、peerごとの有限queue。

Node.js 22（22.12以上、検証版22.22.2）で実行できます。

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```

`npm test`はbuild、単体・モジュール結合試験、ファイルごとのC0/C1 100%判定を実行します。生成物は`.runtime/`に出力します。[bridge.yaml](examples/bridge.yaml)は設定loaderの入力例で、起動コマンドではありません。

ROS adapter、型自動ロード、WebRTC transport、signaling、SDK、CIは未実装です。実ROS・ブラウザ・TURNの対応は未検証で、M0の終了条件は未達です。試作の範囲と次の検証対象は[設計書 §14](docs/design.md#14-モジュール試作の契約と残る接続境界)に記載しています。

## 開発・運用文書

- [CONTRIBUTING.md](CONTRIBUTING.md): 共通の開発規約、検証、依存ライセンス方針。
- [TESTS.md](TESTS.md): テスト設計、受け入れ条件、カバレッジ測定、CIとリリースの判定方針。
- [AGENTS.md](AGENTS.md): エージェントの作業手順と計画・開発・QAの3チーム運用。
- [SECURITY.md](SECURITY.md): セキュリティ要件と脆弱性報告の現状。

## ライセンス

[Apache License 2.0](LICENSE)。依存ライブラリのライセンスは個別に確認します。
