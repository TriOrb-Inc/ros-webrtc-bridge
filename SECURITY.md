# Security Policy

## 現状

このプロジェクトは設計段階です。サポート対象のリリースはまだなく、認証・認可や通信の安全性を実装済みとは表明していません。

目標はROS 2 graphへ到達するWebRTC Topicブリッジです。以下を実装・運用の要件とし、具体的な保証範囲は [`docs/design.md`](docs/design.md) に従います。

## 接続・操作の境界

- signalingはHTTPS/WSSで保護し、認証したidentity、robot、sessionとSDPを対応付ける。
- Topic、型、方向をallowlistで限定する。閲覧権限からpublish権限を推定しない。catalogも権限で絞る。
- token期限切れ、session撤回、ACL変更を既存DataChannelにも反映する。
- 同じROS出力へのcommand writerを制限し、受信時とROS publish直前に所有権・epoch・sequence・leaseを検証する。
- DTLS暗号化だけで操作権限や指令の新鮮さが保証されるとは扱わない。

## 入力・資源・記録

- message、schema、SDP、ICE候補、control requestにサイズ・件数・rate・timeoutの制限を設ける。
- queue、DataChannel送信buffer、cache、peer数を有限にし、遅いpeerが他peerやROS処理を止めないようにする。
- payload、認証情報、TURN credential、SDP/ICE内の接続情報を既定logに出さない。監査記録は認可結果・拒否理由等に限定し、保存期間とアクセス権を定める。
- secretはリポジトリや例に埋め込まず、外部設定から供給する。診断データを共有する前に機密情報を除く。

## ロボット側の責務

Gatewayの期限検証はROS publish直前までです。DDSやcontroller queueでの遅着を拒否する必要がある場合は、controllerで検証可能な期限・世代情報とcommand gateを使用します。入力途絶watchdogをロボット側に設け、切断、browser suspend、Gateway停止を試験します。

再接続時に古いcommandを再送せず、汎用ブリッジが停止用messageを推測しない方針です。ROS publish成功のackは実機の処理完了を意味しません。

## 脆弱性の報告

公開issueやPRへ未修正の脆弱性の詳細、再現用secret、接続情報を書かないでください。管理者へ非公開で連絡してください。

専用の報告先、GitHub Private Vulnerability Reportingの有効化状況、対応期限は現時点で未整備です。最初の公開リリースまでに報告先とサポート対象versionを本書へ明記します。
