# ROS adapter

`TopicRosAdapter`は起動設定にあるROS publisher/subscriptionを`start()`時に生成します。設定済み出力名・型・QoSが同じentityは共有し、`subscribe(publicName, callback)`はlogical listenerだけを追加します。戻り値の解除関数はROS entityを破棄しません。`publish(publicName, native)`は方向と型・値を検証して同期的にROS APIを呼び、成功をcontroller処理完了とは扱いません。

## 現状と使用方法

`createRclnodejsBackend`へ実rclnodejsモジュール、node名、namespace、ROS引数、spin timeout、非throwの`onError`を注入します。専用contextの初期化完了後に返る`resolveTopic`を設定loaderへ渡し、remap後の名前でwriter所有権を管理します。`describe`はbinding生成済みの型を`MessageIntrospector`から取得します。

`resolveTopic`は解決済名と元の入力名を対応付けます。native entity生成には元の名前を渡し、同じnodeのremapを一度だけ適用します。例えば`/source:=/target`と`/target:=/other`があるとき、`/source`の所有名と実際のROS名はともに`/target`です。解決済`/target`を再びnativeへ入力して`/other`へ進めることはありません。entity生成後にもnativeの実Topic名を照合し、不一致は起動を拒否します。設定の解決とentity生成には同じbackendを使い、`resolveTopic`を通していない名前を直接生成しないでください。

```typescript
const backend = await createRclnodejsBackend(rclnodejs, {
  nodeName: 'bridge', namespace: '/', args: [], spinTimeoutMs: 5,
  onError: reportError,
});
const config = parseBridgeConfig(yaml, {
  availableTypes, resolveTopic: backend.resolveTopic,
});
const registry = config.topics.map((binding) => ({
  binding,
  codec: createCodec(descriptorFromRos(binding.rosType, backend.describe), {
    allowNonFinite: !binding.commandGuard,
  }),
}));
const adapter = new TopicRosAdapter(registry, backend, reportError);
adapter.start();
```

`start`以前と`close`以後のTopic操作、未知公開名、方向違いを拒否します。部分的な起動失敗も全contextを終了し、cleanupの失敗は元の失敗と合わせて報告します。アプリケーションはbackend初期化後の設定・registry生成失敗時にも`backend.close()`を呼ぶ必要があります。`close`はidempotentで、終了後のcallbackは破棄します。`onError`は例外やpayloadを既定公開logへ無加工で出さず、例外を投げない診断handlerにしてください。

`MockRosBackend`を同じ`TopicRosAdapter`へ注入すると、同じAPIで単体・router試験を実行できます。mockはDDS discovery、QoS、serialization、実配送、native callbackの滞留を模擬しません。

## 型・QoSの境界

`descriptorFromRos`はbool、string、整数8/16/32/64、float32/64、uint8配列、通常配列、nested messageを明示した型metadataから構築します。固定長・bounded制約を保持し、定数をenum制約へ変換しません。循環・過深schema、未対応primitiveを起動前に拒否します。`wstring`、`byte`、`char`等の互換性は未確定であり、推測した型を公開しません。ROS type hashとwire schema IDは本モジュールの対象外です。

`rclnodejs 2.2.0`のscalar 64bit整数は、生成方式によりsubscription側でsafe範囲number、decimal string、または`bigint`として現れる可能性があります。本モジュールはどの入力もschema範囲を検証してbridgeの`bigint`へ統一し、publish時は生成message setterが要求する`bigint`を維持します。一般のstringは変換しません。subscriptionは`enableTypedArray: false`を指定し、uint8列だけをbridgeの`Uint8Array`へ変換します。未知field、配列のholeや追加propertyを暗黙に捨てません。

backendの`codecOptions`と`descriptorFromRos`の第3引数`maxDepth`で変換資源上限を調整できます。既定値は[codec](../codec/README.md)と同じです。string boundのUTF-8 byte規約とrclnodejsの生成bindingとの完全な対応は、多byte bounded stringの実ROS fixtureで今後検証します。実ROSで確認した型は下記の範囲に限定します。

DDS QoSは`keep_last`、指定depth、reliable/best_effort、volatile/transient_localをnativeの`QoS`へ写します。DataChannel配送設定は参照しません。不一致QoSの診断やmatched数監視、native callback滞留制御は未実装です。

## 検証と制約

単体試験はnative facadeを注入し、起動・解放・例外、remap、QoS enum、型metadata、64bit/bytes変換を検証します。実ROS試験は[tests/ros](../../../../tests/ros/README.md)を参照してください。Humble/Jazzyのarm64環境でString・Twistを独立rclpy対向processと交換する試験を用意しています。他の型、RMW、architecture、性能条件の対応保証には広げません。

ROSへの接続権限、session所有権、command lease、rate、peer/process容量、WebRTC、SDKは上位層の責務です。ROS bindingがインストールされていることと、全ROS型の実運用検証が済んでいることは別です。

## 依存と配布

`rclnodejs 2.2.0`を固定し、Node.js 22.22.2で評価しています。本体はApache-2.0で、解決したnpm推移依存はMIT、ISC、Apache-2.0、BlueOak-1.0.0、0BSD、またはMIT/Apache-2.0の選択licenseです。vendored ref-napi由来コードの通知は[vendor/rclnodejs-notices](../../../../vendor/rclnodejs-notices/README.md)へ補完しています。実ROS・OS componentの配布通知も別途維持してください。

一次資料: [rclnodejs 2.2.0](https://github.com/RobotWebTools/rclnodejs/tree/2.2.0)、[MessageIntrospector](https://github.com/RobotWebTools/rclnodejs/blob/2.2.0/types/message_introspector.d.ts)、[QoS](https://github.com/RobotWebTools/rclnodejs/blob/2.2.0/lib/qos.js)、[native整数表現](https://github.com/RobotWebTools/rclnodejs/blob/2.2.0/third_party/ref-napi/src/ref_napi_bindings.cpp)。
