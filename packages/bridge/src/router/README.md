# Session router

This module connects configuration, codecs, a shared CommandGuard, and DeliveryQueue to one peer's wire operations. ROS and DataChannels are injected; authentication, signaling, and native entity creation belong to the caller.

`SessionRouter` accepts `config`, `bindings: [{binding, codec, schemaId}]`, a `guard` shared by all peers, a fresh per-connection `epoch`, a side-effect-free monotonic `clock`, `ros`, and `send`. Bindings must be TopicBindings from that same configuration. `ros.subscribe(publicName, callback)` returns an unsubscribe function; `ros.publish(publicName, native)` is synchronous. The process owns adapter startup and shutdown.

Construct command-binding codecs using `createCodec(descriptor, {allowNonFinite: false})`. The startup layer owns type registries and codec creation. Even when the same ROS type is used for telemetry, the command codec must reject non-finite values.

`authorize(binding, 'subscribe' | 'publish')` is evaluated for each operation and immediately before delivery/publication. Omitting it denies access. `flush()` reauthorizes telemetry delayed by backpressure immediately before transmission. On authentication revocation, the transport must call `router.close()`. CommandGuard and router policies must refer to the same authenticated identity.

Call `receive(channel, Uint8Array)` for wire input, `flush()` when the send buffer reaches its low watermark, and `close()` on disconnection. Output uses the three fixed channels. `send(channel, bytes)` returns `true` only when accepted synchronously; `false` retains the queue head. Control has priority, and blocked control prevents data transmission.

After `receive()` or `flush()`, the transport checks read-only `isClosed`. A router closed by control overflow or another fatal condition must also close the PeerConnection and release the process's peer registration. `isClosed` becomes true when cleanup starts and stays true even if listener cleanup throws.

Optional `onClosed` is called once after all listeners, handles, queues, and caches are cleaned up, before aggregated cleanup failures are thrown. This trusted callback must not throw. The Endpoint schedules its own close with `queueMicrotask` to avoid re-entrant closure between components.

## Wire v1

Every envelope contains `v: 1` and `op`. Control operations other than hello/ready require a session-local request identifier `id`.

| Channel | Input operation and fields | Response |
| --- | --- | --- |
| control | `hello` | `welcome`, epoch, authorized catalog |
| control | `subscribe`: id, topic | `subscribed`: id, stream_id, epoch, schema_id |
| control | `ready`: stream_id | No response; only newly received samples are delivered afterward |
| control | `unsubscribe`: id, stream_id | `unsubscribed`: id |
| control | `advertise`: id, topic | `advertised`: id, handle, epoch, schema_id |
| control | `arm`: id, handle | `lease`: id, handle, epoch, lease_id, expires_at |
| control | `unadvertise`: id, handle | `unadvertised`: id |
| Binding-selected data channel | `publish`: handle, epoch, seq, data; lease_id for commands | `published_to_ros` on control: handle, seq |

ROS samples use `message` on the binding's data channel, carrying stream_id, epoch, uint64 decimal seq, and codec data. Data publication also accepts an optional `id`, but acknowledgements are matched by handle and seq. Invalid operations, directions, owned handles, values, channels, and envelope sizes are rejected with a control `error` that excludes internal exception text. Acknowledgements establish only ROS API success, not controller completion.

## Limits and lifetime

`limits.maxHandles`, `maxRequests`, `requestTtlMs`, and `maxControlRateHz` must be positive safe integers. maxHandles counts subscriptions and publishers together. Control rate uses a fixed one-second window. Topic rate uses the minimum interval derived from maxRateHz: telemetry is sampled down and excess publication is rejected. Reconnection does not replay operations or commands.

Single messages are limited to min(configured limit, 16 KiB); pending output is bounded by configured peer queue bytes and pending control entries by maxRequests. The cache separately uses the same peer-byte limit to account for request text (UTF-16) and response bytes. Queue plus cache can therefore total twice that byte limit. The cache also bounds count and lifetime. The same ID with identical content reuses a response without repeating execution; the same ID with different content is rejected. Reusing an ID after cache expiration is not guaranteed to identify the same operation.

Reliable stream overflow releases its listener and queue. Realtime replaces old data with the latest value and drops it if insufficient bytes remain. If a control response cannot be retained, the peer closes and releases resources. Failed requests receive no success response. Process-wide budgets, native callback backlog, token issuance, and a request-retry SDK require further integration.

## Video control operations

Present only when the deployment configures `video_tracks`; otherwise `video.*` stays an unknown
operation and the `welcome` envelope is unchanged.

| Operation | Fields | Response |
| --- | --- | --- |
| `video.subscribe` | `id`, `track` | `video.subscribed` with `track` and the negotiated `mid` |
| `video.unsubscribe` | `id`, `mid` | `video.unsubscribed` |

`welcome` gains a `video` array of `{track, codec}` for the tracks this peer may watch. Backend, ROS
topic and bitrate are never disclosed: they describe the host, not the offered stream.

A negotiated `m=video` section is a pipe, not a subscription - watching is an explicit act, so an
idle transceiver costs nothing. A slot binds to a track on first subscribe and stays bound for the
session: reusing a mid for a different source would change resolution and parameter sets underneath a
decoder that was never told to expect it. Unsubscribing stops delivery but keeps the binding, so
resuming reuses the same mid without renegotiation.

Lifecycle changes arrive as `video.state` with `starting`, `active`, `idle` or `failed` and never
carry a cause. Authorization is re-evaluated on every flush; losing a scope detaches the viewer
immediately. As on the Topic side, the guarantee is that no *new* RTP is handed to the peer after
revocation completes - packets already given to the transport cannot be recalled.
