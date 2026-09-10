# SessionRouter 実装

## 目的

wire operationからROS論理listener/publishへの経路で、設定・認可・型・配送上限を一貫して検証します。

## 対象範囲

1 peerのsessionを所有し、全peerで共有するCommandGuardにpublisher leaseを委譲します。ROS native entityとtransport connectionの生成は対象外です。

## 現状

hello、subscribe/ready、advertise/arm、publish、解除操作、有限queue/cacheを実装しています。インターフェースは[README](README.md)を参照してください。

## 実装上の判断

publishには非同期待機を挟まず、codec/認可を同期ROS呼出直前に再評価します。control優先queueは送信拒否時に先頭を維持します。subscriptionのlistenerを登録した時点ではreadyではなく、同期的に発火した初期sampleも捨てます。request cacheは副作用後の再送を期限内で重複実行しません。

閉鎖開始時に`isClosed`をtrueにし、全資源のcleanup後に任意の`onClosed`を1回通知します。Endpointは通知からmicrotaskでPeerConnectionを閉じ、ROS callback起点のrouter閉鎖もprocessのpeer登録から回収します。

## 目標

実ROS/browserとの接続、requestの再送SDK、process全体budget、障害注入でモジュール境界を検証します。

## 関連

[設計書](../../../../docs/design.md)、[session core](../session/README.md)、[codec](../codec/README.md)。
