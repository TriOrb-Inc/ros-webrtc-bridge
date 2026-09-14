# ROS adapter

`TopicRosAdapter` creates the configured ROS publishers and subscriptions in `start()`. Entities with identical configured output names, types, and QoS are shared. `subscribe(publicName, callback)` only adds a logical listener; its unsubscribe function does not destroy the ROS entity. `publish(publicName, native)` validates direction, type, and values, then calls the ROS API synchronously. Success does not mean controller completion.

## Current behavior and usage

Inject the real rclnodejs module, node name, namespace, ROS arguments, spin timeout, and a non-throwing `onError` into `createRclnodejsBackend`. After its dedicated context initializes, pass the returned `resolveTopic` to the configuration loader to manage writer ownership by remapped names. `describe` obtains generated type metadata from `MessageIntrospector`.

`resolveTopic` associates resolved names with their original input names. Native entity creation receives the original name, applying the node's remapping once. For example, with `/source:=/target` and `/target:=/other`, both the ownership name and actual ROS name for `/source` are `/target`. The resolved `/target` is not passed to the native layer again to become `/other`. After entity creation, the actual native Topic name is checked; a mismatch rejects startup. Use the same backend for configuration resolution and entity creation, and do not create names that have bypassed `resolveTopic`.

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

Topic operations before `start` or after `close`, unknown public names, and incorrect directions are rejected. Partial startup failure shuts down the entire context, reporting cleanup failures alongside the original failure. The application must also call `backend.close()` if configuration or registry creation fails after backend initialization. `close` is idempotent; callbacks after closure are discarded. `onError` must be a non-throwing diagnostic handler and must not dump raw exceptions or payloads into public default logs.

Injecting `MockRosBackend` into the same `TopicRosAdapter` supports unit and router tests through the same API. The mock does not simulate DDS discovery, QoS, serialization, actual delivery, or native callback backlog.

## Type and QoS boundaries

`descriptorFromRos` constructs booleans, strings, 8/16/32/64-bit integers, float32/64, uint8 arrays, ordinary arrays, and nested messages from explicit type metadata. It preserves fixed-length and bounded constraints; constants do not become enum constraints. Cyclic or excessively deep schemas and unsupported primitives are rejected before startup. Compatibility of `wstring`, `byte`, `char`, and similar types remains unresolved; guessed types are not exposed. ROS type hashes and wire schema IDs are outside this module's scope.

Depending on binding generation, subscription-side scalar 64-bit integers in `rclnodejs 2.2.0` may be safe-range numbers, decimal strings, or `bigint`. This module validates each representation against the schema and normalizes it to bridge `bigint`. Publication preserves the `bigint` required by generated message setters. Ordinary strings are not converted. Subscriptions use `enableTypedArray: false`; only uint8 sequences become bridge `Uint8Array` values. Unknown fields, array holes, and extra properties are not silently discarded.

Conversion resource limits are configurable through the backend's `codecOptions` and the third `maxDepth` argument of `descriptorFromRos`. Defaults match the [codec](../codec/README.md). Full compatibility between UTF-8 byte string bounds and rclnodejs-generated bindings still needs real ROS fixtures with multibyte bounded strings. Real ROS verification is limited to the types listed below.

DDS `keep_last`, configured depth, reliable/best_effort, and volatile/transient_local map to native `QoS`. DataChannel delivery settings are not consulted. QoS mismatch diagnostics, matched-count monitoring, and native callback backlog control are unimplemented.

## Validation and limitations

Unit tests inject a native facade to verify startup, cleanup, exceptions, remapping, QoS enums, type metadata, and 64-bit/byte conversion. See [tests/ros](../../../../tests/ros/README.md) for real ROS tests. Tests exchange String and Twist with an independent rclpy process on Humble/Jazzy arm64. This does not imply support guarantees for other types, RMWs, architectures, or performance conditions.

ROS access, session ownership, command leases, rates, peer/process capacity, WebRTC, and SDKs belong to higher layers. Installed ROS bindings do not establish production validation of every ROS type.

## Dependencies and distribution

`rclnodejs 2.2.0` is pinned and evaluated on Node.js 22.22.2. Its license is Apache-2.0; resolved transitive npm dependencies use MIT, ISC, Apache-2.0, BlueOak-1.0.0, 0BSD, or a choice of MIT/Apache-2.0. Supplementary notices for vendored ref-napi-derived code are in [vendor/rclnodejs-notices](../../../../vendor/rclnodejs-notices/README.md). Maintain distribution notices for real ROS and OS components separately.

Primary references: [rclnodejs 2.2.0](https://github.com/RobotWebTools/rclnodejs/tree/2.2.0), [MessageIntrospector](https://github.com/RobotWebTools/rclnodejs/blob/2.2.0/types/message_introspector.d.ts), [QoS](https://github.com/RobotWebTools/rclnodejs/blob/2.2.0/lib/qos.js), [native integer representation](https://github.com/RobotWebTools/rclnodejs/blob/2.2.0/third_party/ref-napi/src/ref_napi_bindings.cpp).
