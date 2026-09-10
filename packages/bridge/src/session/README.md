# Session core

現状はROSやWebRTCへ接続しない独立した境界モジュールです。`CommandGuard`はleaseとpublisher handle、`DeliveryQueue`は1 peerの送信待ちを管理します。公開wire protocolではなく、上位session実装のための内部APIです。

`CommandGuard`は認証済み接続ごとに`openSession(epoch)`、設定・remap解決済みのROS完全Topic名に`openHandle(sessionId, topic)`を呼びます。`authorize(identity, phase)`は`open`、`arm`、`receive`、`publish`の各段階で明示的に`true`を返す場合だけ許可されます。認証token、設定Topic、方向、型の検証は上位policyの責務です。

`arm`は同じ出力Topicの別sessionを排他します。同じsessionによる別handleからの再armも以前のleaseを失効させます。`prepare`で受信sequenceを消費し、返されたticketの`publish`で期限・認可・epoch・lease・所有権・publish sequenceを再検証します。ticketは成功・失敗にかかわらず一度しか使用できません。SDKは新leaseに古いpayloadを付け直してはいけません。

`publish`には同期的なROS publish処理だけを渡します。callback内で非同期待機するadapterは対象外です。payloadの型・値とrateは上位層が受信時と同期publish直前に検証する必要があり、このモジュールだけでcommandの安全性は完成しません。callback失敗でもsequenceは巻き戻さず、ROS API成功からcontroller完了を推測しません。

`clock`は副作用なしでGatewayの非負の単調millisecondを返します。clockからguard操作を再入呼出してはいけません。期限一致で拒否します。`maxSessions`、`maxHandles`、`leaseMs`はconstructorで正の安全整数を必須指定し、上位設定loaderから渡します。モジュール内の暗黙の既定値はありません。session撤回・handle閉鎖で登録を解放し、guard全体の`close`後は再利用できません。外部が保持するticket自体の数・payload memoryは上位の有限queueにより制限してください。

Topic別の起動設定`command_guard.lease_ms`は`openHandle(sessionId, topic, leaseMs)`の第3引数に渡します。省略時はconstructorの`leaseMs`を使います。上書き値も正の安全整数で検証し、登録後はhandleに固定します。複数Topicを同じguardへ登録することでTopic別期限と出力Topic単位のwriter排他を両立します。同じ出力Topicに向くalias間の設定矛盾は起動設定loaderが拒否する責務です。

`DeliveryQueue`は`maxStreams`、`maxBytes`、`maxMessageBytes`と、streamごとの`maxMessages`を必須指定します。`latest`の件数は1だけ許可し、更新時に旧値を破棄します。peerの残byteに収まらない新値も破棄し`false`を返します。`reliable`超過時は待機payloadを解放してstreamを停止し、以降も`slow_consumer`を返します。復旧には`closeStream`と明示再登録が必要です。stream閉鎖時の旧ID拒否・再利用禁止は上位sessionの責務です。

queueはenvelopeを含むencode済みの非空`Uint8Array`をcopyして保持します。dropは累積`bigint`です。dequeue後のtransport buffer、process全体budget、control優先scheduler、rate、native callbackの滞留制御は未実装です。これらを統合した実ROS/browserでの評価が必要です。
