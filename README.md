# ros-webrtc-bridge

ROS 2 TopicのPub/SubをWebRTC DataChannelへ双方向に接続するOSSの設計案です。現在は設計段階で、実行可能なブリッジは未実装です。

[設計検討書](docs/design.md)に、構成、プロトコル、QoS、型変換、認証、MVPと検証計画をまとめています。

基本方針は、設定で公開Topicと方向を限定し、ROS 2のQoSとWebRTCの配送方針を別々に定義することです。初期版ではブラウザとの小〜中サイズのメッセージ交換を対象とします。

初期対応対象はROS 2 HumbleとJazzyとし、Dockerでdistroごとに検証します。Web公開名は原則ROS Topic名と一致させ、YAMLで別名も指定できる設計です。

## 開発・運用文書

- [CONTRIBUTING.md](CONTRIBUTING.md): 共通の開発規約、検証、依存ライセンス方針。
- [TESTS.md](TESTS.md): テスト設計、受け入れ条件、カバレッジ測定、CIとリリースの判定方針。
- [AGENTS.md](AGENTS.md): エージェントの作業手順と計画・開発・QAの3チーム運用。
- [SECURITY.md](SECURITY.md): セキュリティ要件と脆弱性報告の現状。

## ライセンス

[Apache License 2.0](LICENSE)。依存ライブラリのライセンスは個別に確認します。
