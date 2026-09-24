# Startup configuration module

`parseBridgeConfig(yaml, options)` reads the [example configuration](../../../../examples/bridge.yaml) and returns a frozen `BridgeConfig`. On failure it throws a `ConfigError` with a location and reason; it never returns a partial configuration. It does not create ROS entities.

The caller explicitly supplies `options.availableTypes`, an array of `package/msg/Message` names verified by the type loader. In the CLI, `app` and `ros` verify generated bindings and build a registry; `router` returns an authorized catalog. The absence of a publisher in the ROS graph is not a rejection reason. A distributable configuration JSON Schema is not implemented yet.

The keys of `topics` are public Web names. When `ros_topic` is omitted, the key is also the ROS destination; when present, the key is an alias. Inject the ROS adapter's remapping and normalization through `options.resolveTopic`; its output becomes `rosTopic`. Without it, names pass through unchanged. Remapping does not change Web names.

The prototype restricts Web and ROS names to absolute names of at most 247 ASCII characters: slash-separated segments beginning with a letter or underscore. Relative names, `~`, and substitution expressions are unsupported. The ROS adapter must also validate names for the active RMW before creating native entities.

| Item | Contract |
| --- | --- |
| YAML | YAML 1.2 core, one document. Duplicate keys, aliases, custom tags, and unknown fields are rejected |
| `maxConfigBytes` | Override in `options`; default 1048576 UTF-8 bytes |
| `maxTopics` | Override in `options`; default 256; at least one binding is required |
| `limits` | All four fields are required positive safe integers. A single message must be at most 16384 bytes and fit in both the peer queue and channel buffer |
| `ros_qos` | All fields required. Uses `keep_last` and a positive `depth`. DDS reliability is independent of DataChannel delivery |
| Delivery | `realtime` requires `latest / max_messages: 1`; `reliable` requires a finite `fifo` |
| `max_rate_hz` | Required positive finite number; fractions are allowed. Higher layers implement rate enforcement |
| `access.exclusive_writer` | `true` requires `command_guard`. `false` without a guard permits multiple writers. `false` with a guard is rejected |
| `command_guard` | When present, requires `required: true`, a positive integer `lease_ms`, Web-to-ROS direction, volatile durability, and an exclusive writer |
| Shared ROS output | Compare remapped names. Reject aliases with different types, QoS, access, guards, rates, delivery, or queues |

Omitting authorization information does not grant publish permission. Authentication policy, process-wide capacity, negotiated transport limits, native callback backlog, and actual rate enforcement belong to higher layers. Validating a configuration does not establish that every configured limit is enforced at runtime.

See the [design](../../../../docs/design.md) and [test policy](../../../../TESTS.md).

## Media plane

`parseVideoConfig` validates `video`, `video_tracks` and `limits.video` separately from
`BridgeConfig`, so raw video never enters the DataChannel contract. It returns `undefined` when none
of the three is present; configuring only some of them is rejected rather than half-applied.

- `video_tracks.<name>` keys are public track names; `ros_topic` is always explicit and must name a
  `sensor_msgs/msg/Image` source with `volatile` durability, because latched history would replay a
  stale frame into a live stream.
- `input` fixes the encoding, geometry and frame rate the source must deliver. Frames that differ are
  rejected, never rescaled, and the values are bounded by `limits.video`.
- `encoder.backend` is mandatory and validated against the known backends. There is no `auto` value.
  `bitrate` is always bits per second; converting to each element's unit belongs to the backend.
  `profile` and `bitrate` are checked against what the selected backend supports.
- `access.subscribe_scope` is required. An omitted scope is not "public": the caller denies every
  scope it was not granted.
- One ROS topic feeds at most one source, and a topic exposed through `topics` cannot also be a video
  source: the two planes have different size limits, authorization and queue behaviour.
