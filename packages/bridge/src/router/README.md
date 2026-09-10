# Session router

現状は設定・codec・共有CommandGuard・DeliveryQueueを1 peerのwire操作へ接続するモジュールです。ROSとDataChannelは注入し、認証・signaling・native entity生成は呼出元が担当します。

`SessionRouter`は`config`、`bindings: [{binding, codec, schemaId}]`、全peerで共有する`guard`、接続ごとに新しい`epoch`、副作用のない単調`clock`、`ros`、`send`を受け取ります。bindingは同じconfigのTopicBindingを使います。`ros.subscribe(publicName, callback)`はlistener解除関数を返し、`ros.publish(publicName, native)`は同期APIです。adapter自体のstart/closeはprocess所有です。

command bindingのcodecは`createCodec(descriptor, {allowNonFinite: false})`で構築します。型registryとcodec生成は起動側の責務です。同じROS型をtelemetryにも使う場合でも、command側は非有限値を拒否するcodecを渡してください。

`authorize(binding, 'subscribe' | 'publish')`は各操作と配信/publish直前に評価し、省略は拒否です。backpressureで待機したtelemetryも`flush()`で送信する前に再評価します。認証失効時はtransport側から`router.close()`を呼びます。CommandGuard自身のpolicyとrouterのpolicyを同じ認証済みidentityに対応付ける必要があります。

wire入力は`receive(channel, Uint8Array)`、送信buffer低水位時は`flush()`、切断時は`close()`を呼びます。送信先は固定3channelです。`send(channel, bytes)`は同期的に受理できた場合だけ`true`を返します。`false`ならqueue先頭を保持します。controlを優先し、controlが詰まった間はdataを送りません。

transportは`receive()`または`flush()`の後に読み取り専用`isClosed`を確認します。routerがcontrol溢れ等で閉鎖した場合、PeerConnectionも閉じてprocess側のpeer登録を解放してください。`isClosed`はcleanup開始時にtrueになり、listener解放で例外が起きてもtrueを維持します。

任意の`onClosed`は全listener/handle/queue/cacheのcleanup後に1回だけ呼びます。listener解放失敗を集約してthrowする場合も、その前に通知します。ROS callback起点の閉鎖もこの通知で回収できます。trusted callbackは例外を投げない契約とし、Endpoint側は`queueMicrotask`で自身のcloseを予約して相互closeの再入を避けてください。

## wire v1

すべてのenvelopeに`v: 1`と`op`を含めます。hello/ready以外のcontrolにはsession内request識別子`id`が必要です。

| channel | 入力opとfield | 応答 |
| --- | --- | --- |
| control | `hello` | `welcome`、epoch、許可されたcatalog |
| control | `subscribe`: id, topic | `subscribed`: id, stream_id, epoch, schema_id |
| control | `ready`: stream_id | 応答なし。以後に受信した新規sampleだけ配信 |
| control | `unsubscribe`: id, stream_id | `unsubscribed`: id |
| control | `advertise`: id, topic | `advertised`: id, handle, epoch, schema_id |
| control | `arm`: id, handle | `lease`: id, handle, epoch, lease_id, expires_at |
| control | `unadvertise`: id, handle | `unadvertised`: id |
| binding指定のdata channel | `publish`: handle, epoch, seq, data、commandならlease_id | controlの`published_to_ros`: handle, seq |

ROS sampleはbinding指定data channelの`message`でstream_id、epoch、uint64 decimal seq、codec dataを運びます。data publishは任意の`id`も受理しますが、ack対応はhandleとseqで行います。不正operation、方向、所有handle、型値、channel、envelopeサイズを拒否し、内部例外本文を含めない`error`をcontrolへ返します。ackはROS API成功だけを意味し、controller完了ではありません。

## 上限と寿命

`limits.maxHandles`、`maxRequests`、`requestTtlMs`、`maxControlRateHz`は正の安全整数を必須指定します。maxHandlesはsubscriptionとpublisherの合計です。control rateは1秒固定windowの件数上限です。Topic rateはmaxRateHz由来の最小間隔で、telemetryは間引き、publishは拒否します。再接続時の操作・commandの再送は行いません。

単一messageはmin(config上限,16KiB)、送信待ちはconfigのpeer queue bytes、control待機件数はmaxRequestsです。cacheは別途同じpeer queue bytesを上限にrequest本文(UTF-16)とresponse bytesを計上します。したがってqueueとcacheの合計は最大その2倍です。cacheは件数と寿命でも制限し、同じid・同じ内容を再実行せず応答を再利用します。同じid・異なる内容は拒否します。cache期限後のrequest ID再送を同一操作として保証しません。

reliable streamのqueue超過では当該listenerとqueueを解放します。realtimeは最新値へ置換し、残byte不足ならdropします。control応答を保持できない場合はpeerを閉じて資源を解放します。request失敗時に成功応答は返しません。process全体budget、DDS/native callback滞留、token発行とrequest retry SDKは別途統合が必要です。
