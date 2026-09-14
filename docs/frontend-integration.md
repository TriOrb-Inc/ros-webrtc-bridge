# フロントエンド接続ガイド

このガイドは現行のHTTPS signalingとwire v1を使うブラウザ実装向けです。ブラウザSDKは未提供です。以下は接続の最小例とメッセージ例であり、アプリの認証管理、型生成、再接続管理、UI状態管理を実装したSDKではありません。

HTTP仕様は起動先の `/docs`、`/openapi.json`、`/openapi.yaml` で確認できます。RESTは `GET /health` と `POST /offer` だけです。Topic一覧、購読、publishはWebRTC DataChannelで交換します。Service、Action、MediaTrackはこの接続の対象外です。

## 接続先・認証・TLS

配備側から、HTTPS signaling URL、信頼できるTLS証明書、実行時発行のBearer credential、公開Topic/権限、対応するROS型とschemaを受け取ります。credential発行・更新サービスや多ユーザー認証はbridgeにありません。値をコード、URL、ログ、localStorage、sessionStorageへ保存せず、認証済みアプリの実行時memoryから渡してください。serverには `BRIDGE_CREDENTIAL` と権限allowlistを注入します。設定方法は[起動設定](../packages/bridge/src/app/README.md)を参照してください。

現在のserverはCORS headerとOPTIONS preflightに対応していません。フロントとbridgeでportが違えば別originです。ブラウザから直接呼ぶ場合は、フロントと同じHTTPS originのreverse proxyでsignalingへ中継してください。例えばフロントの `/bridge/offer` をbridgeの `/offer` へ対応させ、AuthorizationとContent-Typeを維持します。`mode: 'no-cors'` は代替になりません。Swaggerも中継する場合、UIが使う `/docs/*` と `/openapi.json` の絶対pathを同じoriginで解決できるルーティングが必要です。

HTTPS proxyが中継するのはsignalingです。実際のDataChannelはICEで選ばれた経路を使うため、proxy到達だけで接続成立を保証しません。bridge側ICE server一覧は空でhost candidateを使用します。必要なTURN設定はブラウザの `RTCConfiguration` へ配備側が渡します。検証範囲は[接続試験](../tests/connection/README.md)を参照してください。

## 固定3 DataChannelと接続順

ブラウザをoffererにして、SDPを作る前に次の3本だけを作ります。`negotiated`、固定ID、`maxPacketLifeTime`は指定しません。reliable側の `maxRetransmits` も指定しません。

| label | 作成option | 用途 |
| --- | --- | --- |
| `ros.control.v1` | `{ ordered: true }` | hello、購読・publisher管理、error、ack |
| `ros.reliable.v1` | `{ ordered: true }` | deliveryがreliableのTopic data |
| `ros.realtime.v1` | `{ ordered: false, maxRetransmits: 0 }` | deliveryがrealtimeのTopic data |

受信handlerを先に登録し、`binaryType = 'arraybuffer'` にします。wireはUTF-8 JSONです。送信はstringでもUTF-8 bytesでも受理され、serverからの受信はbinaryになるため両形式を処理します。

次のTypeScriptはDOM型のあるブラウザ向けです。`offerUrl` はsame-origin proxy URL、`credential` は実行時memory、`onWire` は同期の受信処理、`onClosed` は画面側の状態破棄処理です。返却前にwelcomeを確認し、失敗時はHTTP要求とPeerConnectionを解放します。アプリは `onWire` でoperation別schema、epoch、stream/handle、配信channelを検証してください。

```typescript
type Wire = Record<string, unknown>;
const CONTROL = 'ros.control.v1';

export async function connectBridge(
  offerUrl: string,
  credential: string,
  onWire: (label: string, wire: Wire) => void,
  onClosed: () => void,
  rtcConfiguration: RTCConfiguration = {},
  timeoutMs = 15000,
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid_timeout');
  const pc = new RTCPeerConnection(rtcConfiguration);
  const abort = new AbortController();
  const channels = new Map<string, RTCDataChannel>();
  let closed = false;
  let welcome: Wire | undefined;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });

  // timerとHTTP要求を含め、接続単位で一度だけ解放する。
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    abort.abort();
    for (const channel of channels.values()) channel.close();
    pc.close();
    onClosed();
  };
  const fail = () => { rejectFailure(new Error('bridge_connection_failed')); close(); };
  const timer = setTimeout(fail, timeoutMs);
  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && !closed) fail();
  };
  const until = async (ready: () => boolean) => {
    while (!ready()) {
      if (closed) throw new Error('bridge_connection_closed');
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
  };

  const establish = async () => {
    for (const label of [CONTROL, 'ros.reliable.v1', 'ros.realtime.v1']) {
      const channel = pc.createDataChannel(label, label === 'ros.realtime.v1'
        ? { ordered: false, maxRetransmits: 0 } : { ordered: true });
      channel.binaryType = 'arraybuffer';
      channel.onclose = () => { if (!closed) fail(); };
      channel.onerror = fail;
      channel.onmessage = event => {
        try {
          const text = typeof event.data === 'string' ? event.data
            : new TextDecoder('utf-8', { fatal: true }).decode(event.data as ArrayBuffer);
          const value: unknown = JSON.parse(text);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
          const wire = value as Wire;
          if (wire.v !== 1 || typeof wire.op !== 'string') throw new Error();
          if (!welcome) {
            if (label !== CONTROL || wire.op !== 'welcome'
              || typeof wire.epoch !== 'string' || !Array.isArray(wire.catalog)) throw new Error();
            welcome = wire;
          }
          onWire(label, wire);
        } catch { fail(); }
      };
      channels.set(label, channel);
    }
    await pc.setLocalDescription(await pc.createOffer());
    await until(() => pc.iceGatheringState === 'complete');
    if (closed || !pc.localDescription) throw new Error('missing_offer');
    // trickle ICEではない。candidateを含む最終SDPを一度だけ送る。
    const response = await fetch(offerUrl, {
      method: 'POST', signal: abort.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
      body: JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }),
    });
    if (response.status !== 200) throw new Error(`signaling_http_${response.status}`);
    const answer: RTCSessionDescriptionInit = await response.json();
    if (closed || answer.type !== 'answer' || typeof answer.sdp !== 'string') throw new Error('invalid_answer');
    await pc.setRemoteDescription(answer);
    await until(() => [...channels.values()].every(channel => channel.readyState === 'open'));
    channels.get(CONTROL)!.send(JSON.stringify({ v: 1, op: 'hello' }));
    await until(() => welcome !== undefined);
    return { pc, channels, welcome: welcome!, close };
  };
  try {
    const result = await Promise.race([establish(), failure]);
    clearTimeout(timer);
    return result;
  } catch (error) { close(); throw error; }
}
```

`onWire` は無限にmessageを蓄積せず、有限queueか最新値への集約で描画へ渡してください。callbackから例外が出るとこの例は接続全体を閉じます。`onClosed` は例外を投げず、画面の送信timer、未完了request、stream/handle/leaseを破棄します。画面のunmount時も返却された `close()` を呼びます。接続後の各control requestには別途応答timeoutを設けます。

## hello、catalog、schema確認

controlへ送る最初のenvelopeは `{"v":1,"op":"hello"}` です。welcomeのcatalogには、そのcredentialに許可されたbindingだけが入ります。別のHTTP catalog endpointや追加のcatalog requestはありません。

```json
{"v":1,"op":"welcome","epoch":"epoch-example","catalog":[{"topic":"/example/state","ros_type":"std_msgs/msg/String","direction":"ros_to_web","delivery":"reliable","schema_id":"sha256:example"}]}
```

ここ以降のID・epoch・hashは説明用の記号です。実際には直前の応答値を使います。Topic名は例であり、実行時catalogに存在する公開名を選択します。schema IDをこの例の文字列と比較してはいけません。

`ros_type`、`direction`、`delivery`、`schema_id` をアプリの対応表と照合します。catalogは完全なfield schema、QoS、rate、command guardやlease期間を含みません。それらは配備設定・ROS interfaceから事前に共有してください。現在はdescriptor/JSON Schemaを取得するHTTP APIもありません。未知のschema IDや型を名前だけで推測してpublishしないでください。schema IDはROS type hashではなく、codec/descriptor/非有限値policyの正規化hashです。[生成契約](../packages/bridge/src/app/README.md)を参照してください。

## subscribe → subscribed → ready → message

control requestの `id` はsession内で再利用せず、応答の `id` と対応付けます。まずcatalogの `ros_to_web` Topicにsubscribeします。

```json
{"v":1,"op":"subscribe","id":"r1","topic":"/example/state"}
```

control応答:

```json
{"v":1,"op":"subscribed","id":"r1","stream_id":"stream-example","epoch":"epoch-example","schema_id":"sha256:example"}
```

応答のepoch/schemaを確認し、streamの受信処理を登録してからcontrolへreadyを送ります。readyにrequest IDは付けません。

```json
{"v":1,"op":"ready","stream_id":"stream-example"}
```

ready自体への応答はありません。bindingのdeliveryに対応するdata channelにmessageが届きます。

```json
{"v":1,"op":"message","stream_id":"stream-example","epoch":"epoch-example","seq":"1","data":{"data":"sample"}}
```

stream ID、epoch、schemaに合うdata、channelを確認して描画します。ready前のsampleは自動再生されません。DDSからready後に届いた履歴sampleは配信され得るので、freshnessが必要ならROS messageのstamp等も評価してください。`unsubscribe` はcontrolへ `{"v":1,"op":"unsubscribe","id":"r2","stream_id":"stream-example"}` を送ります。応答は `unsubscribed` と同じ `id` です。解除したstreamへの遅着dataもUI側で捨てます。

## advertise、arm、publish

catalogの `web_to_ros` Topicへcontrolのadvertiseを送ります。

```json
{"v":1,"op":"advertise","id":"r3","topic":"/example/command"}
```

```json
{"v":1,"op":"advertised","id":"r3","handle":"handle-example","epoch":"epoch-example","schema_id":"sha256:example"}
```

command guard付きbindingでは、さらにcontrolでarmを要求します。通常のguardなしbindingにarmを送ると拒否されるため、配備側の契約からguardの有無を把握してください。

```json
{"v":1,"op":"arm","id":"r4","handle":"handle-example"}
```

```json
{"v":1,"op":"lease","id":"r4","handle":"handle-example","epoch":"epoch-example","lease_id":"lease-example","expires_at":12345}
```

publishは **bindingのdeliveryに対応するdata channel** に送ります。次は `std_msgs/msg/String` を使う例です。実際の型の全fieldを埋めてください。

```json
{"v":1,"op":"publish","handle":"handle-example","epoch":"epoch-example","lease_id":"lease-example","seq":"1","data":{"data":"new input"}}
```

guardなしbindingでは `lease_id` を省略します。`seq` はcanonical uint64 decimal string（`"1"` 等）であり、JSON numberではありません。handle単位で単調増加させ、拒否された送信にも使用済みseqを再利用しません。`BigInt` で管理し `.toString()` して送ります。上限に達したら新しいhandleを作成します。任意の `id` もpublishに付与できますが、成功ackの照合はhandleとseqです。

controlに返る成功ack:

```json
{"v":1,"op":"published_to_ros","handle":"handle-example","seq":"1"}
```

ackはROS publish API成功を示し、controllerの実行完了・停止完了やexactly-onceを保証しません。必要な完了状態は対応するtelemetryで確認します。publisherを破棄するにはcontrolへ `{"v":1,"op":"unadvertise","id":"r5","handle":"handle-example"}` を送り、`unadvertised` と同じ `id` を確認します。

## lease・再接続・送信queue

`expires_at` は **bridgeの単調clockに属する値** です。ブラウザの `Date.now()` や `performance.now()` と直接比較できず、単純な差分を有効残時間として使えません。公開protocolにclock同期はありません。配備側とlease期間・更新方式を取り決め、期限判定とpublish直前の認可はserverを正とします。

再armは新しいrequest IDを使い、旧leaseを無効にします。lease更新、epoch変更、disconnect、画面停止時には古いcommandと未送信queueを捨て、新しい操作入力から送信します。同じhandleの再armでseqを巻き戻しません。再接続は新しいPeerConnection、3 DataChannel、hello/welcomeから始め、旧stream/handle/lease/epochを流用しません。control request cacheは有限で、IDの再送が常に重複排除されるとは保証しません。

`RTCDataChannel.bufferedAmount` と配備側rate/容量上限を監視し、上限時に送信を抑制してください。単一envelopeはUTF-8で設定上限・16KiB・合意上限の最小値以内です。自動断片化はありません。古いcommandをreliable queueへためたり、切断後の再送queueへ入れたりしません。leaseの期限切れ自体はROSへ停止指令やゼロ速度をpublishしません。command guardとcontroller側watchdogは別の責務です。

## ROS JSONの表現

[codec仕様](../packages/bridge/src/codec/README.md)に従います。特にREST側の別GatewayのJSON表現を流用しないでください。

| ROS値 | DataChannel上のJSON |
| --- | --- |
| int64 / uint64 | canonical decimal string。`"42"`、int64のみ`"-42"`。uint64は負数不可。`"42n"`、先頭ゼロ、指数表記は不可 |
| uint8列 | padding付き標準base64 string。通常の数値配列ではない |
| nested object | 全field必須、未知field不可 |
| 固定配列 / bounded配列 | 指定長 / 上限を守る |
| float32 | binary32へ丸められる。overflow拒否 |
| 非有限float | 許可されたtelemetryのみ `"NaN"` / `"Infinity"` / `"-Infinity"`。commandは不可 |

Nodeの `Buffer` を使うserver codecをブラウザSDKとしてそのままimportできるとは扱いません。ブラウザ側に型と変換を実装し、独立した期待値で互換性を確認してください。

## 問題の切り分け

| 症状 | 確認点 |
| --- | --- |
| fetchがCORS/TLSエラー | 証明書の信頼・host一致、same-origin proxy。OPTIONSは現状未対応 |
| HTTP 401 / 415 | Bearer値の実行時注入、Content-Typeが正確に `application/json` か |
| HTTP 400 | JSON未知field、offer型、SDPがapplicationのみか。errorは匿名化される |
| HTTP 408 / 413 / 503 | body読取期限 / body byte上限 / pending交渉上限 |
| answer後にchannelが開かない | 最終SDPのcandidate、ICE経路、3本のlabel/配送属性、negotiation timeout |
| welcomeにTopicがない | 公開設定、credentialのsubscribe allowlist / publish scope |
| subscribed後にdataがない | ready、delivery channel、ROS publisher・QoS、stream/epoch、schema、rate |
| command拒否 | direction、schema、guard有無、lease、epoch、seq単調性、rate、channel、容量 |

wire errorはcontrolの `error` で受け取り、公開 `code` は一律 `request_rejected` です。内部のlease失効・writer競合等の理由文字列は公開されません。`id` がある場合は該当requestを解放し、`id` のない非同期errorにはstream/接続状態を再確認する方針を設けます。HTTP/ICE/DTLS/SCTP/wire/ROSを分けて観測し、credential、SDP、ICE candidate、payloadを通常ログへ出さないでください。再現可能なraw clientは[ブラウザ試験](../tests/browser/scenario.ts)、正本wire仕様は[Session router](../packages/bridge/src/router/README.md)にあります。
