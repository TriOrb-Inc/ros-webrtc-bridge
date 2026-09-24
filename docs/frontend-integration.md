# Frontend integration guide

This guide targets browser implementations using the current HTTPS signaling and wire v1. No browser SDK is provided. The examples cover minimal connection setup and messages, not a complete SDK with authentication management, type generation, reconnection management, or UI state handling.

Inspect the running server's HTTP specification at `/docs`, `/openapi.json`, and `/openapi.yaml`. The only REST endpoints are `GET /health` and `POST /offer`. Topic catalogs, subscriptions, publication, and video control use WebRTC DataChannels. Services, Actions, and audio are outside this connection's scope.

## Endpoint, authentication, and TLS

Obtain the HTTPS signaling URL, a trusted TLS certificate, a runtime-issued Bearer credential, exposed Topics/permissions, and supported ROS types/schemas from the deployment. The bridge has no credential issuance/renewal service or multi-user authentication. Pass credentials from authenticated application memory; do not store them in code, URLs, logs, localStorage, or sessionStorage. The server receives `BRIDGE_CREDENTIAL` and permission allowlists through injection. See [startup settings](../packages/bridge/src/app/README.md).

The current server does not implement CORS headers or OPTIONS preflight. Different frontend and bridge ports mean different origins. Use a reverse proxy on the frontend's HTTPS origin for browser calls: for example, map frontend `/bridge/offer` to bridge `/offer`, preserving Authorization and Content-Type. `mode: 'no-cors'` is not an alternative. If proxying Swagger too, route its absolute `/docs/*` and `/openapi.json` asset/specification paths on that origin.

An HTTPS proxy forwards signaling; actual DataChannels use the selected ICE path. Proxy reachability does not guarantee connectivity. The bridge has no ICE servers configured and uses host candidates. Deployment supplies any required TURN settings through browser `RTCConfiguration`. See [connection tests](../tests/connection/README.md) for verified scope.

## Three fixed DataChannels and connection order

The browser is the offerer. Create exactly these three channels before creating SDP. Do not specify `negotiated`, fixed IDs, or `maxPacketLifeTime`. Also omit `maxRetransmits` for reliable channels.

| Label | Creation options | Purpose |
| --- | --- | --- |
| `ros.control.v1` | `{ ordered: true }` | hello, subscription/publisher management, errors, acknowledgements |
| `ros.reliable.v1` | `{ ordered: true }` | Topic data with reliable delivery |
| `ros.realtime.v1` | `{ ordered: false, maxRetransmits: 0 }` | Topic data with realtime delivery |

Register receive handlers first and set `binaryType = 'arraybuffer'`. Wire messages are UTF-8 JSON. Sending strings or UTF-8 bytes is supported; handle both forms on receipt because the server sends binary messages.

The following TypeScript targets browsers with DOM types. `offerUrl` is a same-origin proxy URL, `credential` comes from runtime memory, `onWire` handles received messages synchronously, and `onClosed` discards UI state. The function waits for welcome before returning and releases the HTTP request and PeerConnection on failure. In `onWire`, the application must validate each operation's schema, epoch, stream/handle, and delivery channel.

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

  // Release each connection once, including its timer and HTTP request.
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
    // Non-trickle ICE: send the final SDP with candidates exactly once.
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

Do not accumulate messages indefinitely in `onWire`: use a bounded queue or coalesce to the latest value before rendering. An exception from the callback closes the entire connection in this example. `onClosed` must not throw; discard UI send timers, pending requests, and stream/handle/lease state there. Call the returned `close()` on unmount too. Add separate response deadlines to control requests after connection establishment.

## hello, catalog, and schema checks

The first control envelope is `{"v":1,"op":"hello"}`. The welcome catalog contains only bindings authorized for that credential. There is no separate HTTP catalog endpoint or additional catalog request.

```json
{"v":1,"op":"welcome","epoch":"epoch-example","catalog":[{"topic":"/example/state","ros_type":"std_msgs/msg/String","direction":"ros_to_web","delivery":"reliable","schema_id":"sha256:example"}]}
```

IDs, epochs, and hashes below are explanatory placeholders. Use values from actual preceding responses. Topic names are examples; choose public names present in the runtime catalog. Do not compare schema IDs with the placeholder shown here.

Check `ros_type`, `direction`, `delivery`, and `schema_id` against the application's supported contracts. Catalog entries do not contain full field schemas, QoS, rates, command guards, or lease durations. Share those in advance through deployment configuration and ROS interfaces. There is currently no HTTP API for fetching descriptors/JSON Schemas. Do not guess an unknown schema ID or type from its name and publish. A schema ID is a normalized hash of codec/descriptor/non-finite-value policy, not a ROS type hash. See the [generation contract](../packages/bridge/src/app/README.md).

## subscribe → subscribed → ready → message

Do not reuse control request `id` values within a session; correlate responses by `id`. Start by subscribing to a catalog Topic with `ros_to_web` direction.

```json
{"v":1,"op":"subscribe","id":"r1","topic":"/example/state"}
```

Control response:

```json
{"v":1,"op":"subscribed","id":"r1","stream_id":"stream-example","epoch":"epoch-example","schema_id":"sha256:example"}
```

Check the response epoch/schema and register stream handling before sending ready on control. Do not include a request ID in ready.

```json
{"v":1,"op":"ready","stream_id":"stream-example"}
```

Ready has no acknowledgement. Messages arrive on the data channel selected by the binding's delivery mode.

```json
{"v":1,"op":"message","stream_id":"stream-example","epoch":"epoch-example","seq":"1","data":{"data":"sample"}}
```

Validate the stream ID, epoch, schema-compatible data, and channel before rendering. Samples from before ready are not automatically replayed. DDS history delivered after ready can still be forwarded; evaluate ROS message timestamps when freshness matters. To unsubscribe, send `{"v":1,"op":"unsubscribe","id":"r2","stream_id":"stream-example"}` on control. The response is `unsubscribed` with the same `id`. The UI must discard late data for removed streams.

## advertise, arm, and publish

Send advertise on control for a catalog Topic with `web_to_ros` direction.

```json
{"v":1,"op":"advertise","id":"r3","topic":"/example/command"}
```

```json
{"v":1,"op":"advertised","id":"r3","handle":"handle-example","epoch":"epoch-example","schema_id":"sha256:example"}
```

For a binding with a command guard, request arm on control next. Arming an ordinary unguarded binding is rejected, so obtain guard requirements from the deployment contract.

```json
{"v":1,"op":"arm","id":"r4","handle":"handle-example"}
```

```json
{"v":1,"op":"lease","id":"r4","handle":"handle-example","epoch":"epoch-example","lease_id":"lease-example","expires_at":12345}
```

Send publish on **the data channel selected by the binding's delivery mode**. This example uses `std_msgs/msg/String`; populate every field of the actual type.

```json
{"v":1,"op":"publish","handle":"handle-example","epoch":"epoch-example","lease_id":"lease-example","seq":"1","data":{"data":"new input"}}
```

Omit `lease_id` for unguarded bindings. `seq` is a canonical uint64 decimal string such as `"1"`, not a JSON number. Increase it monotonically per handle, without reusing a sequence consumed by a rejected send. Manage it with `BigInt` and transmit `.toString()`. At the upper limit, create a new handle. Publication may include an optional `id`, but match successful acknowledgements by handle and seq.

Successful acknowledgement on control:

```json
{"v":1,"op":"published_to_ros","handle":"handle-example","seq":"1"}
```

An acknowledgement means the ROS publish API succeeded; it does not guarantee controller execution/stopping completion or exactly-once delivery. Check corresponding telemetry for required completion state. To remove a publisher, send `{"v":1,"op":"unadvertise","id":"r5","handle":"handle-example"}` on control and verify `unadvertised` with the same `id`.

## Leases, reconnection, and send queues

`expires_at` belongs to **the bridge's monotonic clock**. Do not directly compare it with browser `Date.now()` or `performance.now()`, or interpret their difference as remaining lease time. The public protocol has no clock synchronization. Agree on lease durations and renewal policy with deployment; the server is authoritative for expiry and authorization immediately before publication.

Re-arm with a fresh request ID; it invalidates the old lease. On lease renewal, epoch change, disconnect, or UI shutdown, discard old commands and unsent queues and send only newly entered input. Do not reset sequence numbers when re-arming the same handle. Reconnection starts from a new PeerConnection, three channels, and hello/welcome; never reuse old streams, handles, leases, or epochs. The control request cache is finite, so request retransmission is not guaranteed to be deduplicated forever.

Monitor `RTCDataChannel.bufferedAmount` and deployment rate/capacity limits; suppress sending at the limit. Each UTF-8 envelope must fit the minimum of the configured limit, 16 KiB, and the negotiated limit. There is no automatic fragmentation. Do not accumulate old commands in reliable queues or reconnect replay queues. Lease expiry itself does not publish a stop command or zero velocity to ROS. The command guard and controller watchdog have separate responsibilities.

## ROS JSON representation

Follow the [codec specification](../packages/bridge/src/codec/README.md). In particular, do not reuse another REST Gateway's JSON representation.

| ROS value | DataChannel JSON |
| --- | --- |
| int64 / uint64 | Canonical decimal strings: `"42"`, and `"-42"` only for int64. uint64 cannot be negative. No `"42n"`, leading zeroes, or exponent notation |
| uint8 sequence | Padded standard base64 string, not an ordinary numeric array |
| Nested object | Every field required; unknown fields rejected |
| Fixed/bounded array | Exact length / upper bound enforced |
| float32 | Rounded to binary32; overflow rejected |
| Non-finite float | `"NaN"`, `"Infinity"`, or `"-Infinity"` only for permitted telemetry; forbidden for commands |

Do not treat the Node `Buffer`-based server codec as a directly importable browser SDK. Implement browser-side types/conversion and check interoperability against independent expected values.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| CORS/TLS fetch error | Certificate trust/host match and same-origin proxy; OPTIONS is currently unsupported |
| HTTP 401 / 415 | Runtime Bearer injection; Content-Type must be exactly `application/json` |
| HTTP 400 | Unknown JSON fields, offer type, application-only SDP; errors are anonymized |
| HTTP 408 / 413 / 503 | Body read deadline / byte limit / concurrent pending negotiations |
| Channels stay closed after answer | Final SDP candidates, ICE path, three channel labels/delivery attributes, negotiation timeout |
| Topic missing from welcome | Exposed configuration and credential subscribe allowlist / publish scopes |
| No data after subscribed | ready, delivery channel, ROS publisher/QoS, stream/epoch, schema, rate |
| Command rejected | Direction, schema, guard requirement, lease, epoch, monotonic seq, rate, channel, capacity |

Wire errors arrive as control `error`; the public `code` is always `request_rejected`. Internal reasons such as lease expiry and writer conflicts are not exposed. If `id` is present, resolve the corresponding pending request as failed; for asynchronous errors without `id`, define a policy to recheck stream/connection state. Observe HTTP/ICE/DTLS/SCTP/wire/ROS separately. Do not put credentials, SDP, ICE candidates, or payloads in normal logs. See the reproducible raw client in the [browser test](../tests/browser/scenario.ts) and the authoritative wire specification in [Session router](../packages/bridge/src/router/README.md).

## Receiving video

Available only when the deployment configures video tracks. Without them the server rejects any
offer containing an `m=video` section, so add one only if the deployment told you it serves video.

Create the receive-only transceivers **before** the offer, alongside the three DataChannels:

```typescript
const transceiver = pc.addTransceiver('video', { direction: 'recvonly' });
transceiver.receiver.track.onunmute = () => { videoElement.srcObject = new MediaStream([transceiver.receiver.track]); };
```

Add at most as many sections as the deployment allows; extra ones are rejected rather than ignored.
Each must offer H.264 with `packetization-mode=1`, which is the browser default. The answer is
`sendonly`, and the server echoes the payload type and `profile-level-id` your offer named.

After `welcome`, its `video` array lists the tracks you may watch, each as `{track, codec}`. The key
is absent when you may watch none. Backend, ROS topic and bitrate are deliberately not disclosed.

A negotiated section carries nothing until you ask for it:

```json
{"v":1,"op":"video.subscribe","id":"r7","track":"front"}
{"v":1,"op":"video.subscribed","id":"r7","track":"front","mid":"1"}
```

Match the returned `mid` against `transceiver.mid` to find the receiver carrying that track. Keep the
binding: unsubscribing stops delivery but the section stays bound to the track, so resubscribing
resumes on the same `mid` without renegotiation. A `mid` is never reassigned to a different track
within a session.

```json
{"v":1,"op":"video.unsubscribe","id":"r8","mid":"1"}
{"v":1,"op":"video.unsubscribed","id":"r8"}
```

Lifecycle changes arrive unsolicited on the control channel and never carry a cause:

```json
{"v":1,"op":"video.state","track":"front","mid":"1","state":"active"}
```

`starting` means the encoder is being brought up, `active` that packets are flowing, `idle` that the
source stopped, and `failed` that it cannot serve you - after which you may subscribe again to retry.
Treat rejected requests as you do any other: the server replies with the fixed `request_rejected`
classification and never explains why.

The encoder runs only while somebody is watching, so the first subscription may take a moment before
`active` arrives. The server sends a keyframe when you join, and decoder keyframe requests (RTCP PLI)
are forwarded automatically; there is no operation for requesting one.
