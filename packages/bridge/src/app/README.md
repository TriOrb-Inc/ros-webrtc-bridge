# Startup and composition

`cli.main()` validates environment settings, TLS, and YAML before assembling a dedicated rclnodejs context, shared ROS entities, command guard, per-peer routers/WebRTC endpoints, and HTTPS signaling. Importing the module does not start it.

```bash
node -e "import('./.runtime/build/packages/bridge/src/app/cli.js').then(m=>m.main())"
```

Source the ROS environment and prepare the native addon and Werift core before startup. ROS distro, domain, and RMW use standard environment variables such as `ROS_DISTRO`, `ROS_DOMAIN_ID`, and `RMW_IMPLEMENTATION`. The CLI uses `rclnodejs` directly and requires no Python sidecar.

After ament/colcon installation, `ros2 run ros_webrtc_bridge ros_webrtc_bridge` or `ros2 launch ros_webrtc_bridge bridge.launch.py` invokes the same `cli.main()`. Launch arguments are limited to `config`, `host`, `port`, and `node_name`. Credentials, TLS keys/certificates, and Topic permissions are inherited from the environment rather than placed in launch arguments.

| Environment variable | Requirement/default | Purpose |
|---|---|---|
| `BRIDGE_CREDENTIAL` | Required, at least 32 characters | Single runtime-issued Bearer credential |
| `BRIDGE_CONFIG` | Required | Bridge YAML path |
| `BRIDGE_TLS_KEY` / `BRIDGE_TLS_CERT` | Required | PEM private key / certificate paths |
| `BRIDGE_HOST` / `BRIDGE_PORT` | `127.0.0.1` / `7443` | HTTPS bind address |
| `BRIDGE_SUBSCRIBE_TOPICS` | Empty | Comma-separated public Web names allowed for reading |
| `BRIDGE_PUBLISH_SCOPES` | Empty | Comma-separated allowed `access.publish_scope` values |
| `BRIDGE_NODE_NAME` | `ros_webrtc_gateway` | ROS node name |
| `BRIDGE_ROS_ARGS` | `[]` | JSON string array of ROS arguments, including remaps |
| `BRIDGE_SPIN_TIMEOUT_MS` | `10` | rclnodejs spin timeout |
| `BRIDGE_ICE_STUN_URL` | Unset | Optional `stun:` or `stuns:` URI used by the bridge to discover a server-reflexive candidate |
| `BRIDGE_ICE_PORT_MIN` / `BRIDGE_ICE_PORT_MAX` | Unset | Optional inclusive UDP allocation range; both bounds are required and the minimum must be lower than the maximum |
| `BRIDGE_MAX_CONFIG_BYTES` | `1048576` | YAML document limit |
| `BRIDGE_NEGOTIATION_TIMEOUT_MS` | `30000` | Deadline for SDP/ICE/three-channel establishment and peer closure |
| `BRIDGE_MAX_SDP_BYTES` | `262144` | Signaling body and SDP limit |
| `BRIDGE_REQUEST_TIMEOUT_MS` | `10000` | HTTP body read deadline |
| `BRIDGE_MAX_HANDLES` | `64` | Stream/publisher handles per peer |
| `BRIDGE_MAX_REQUESTS` | `64` | Request cache/control queue entries per peer |
| `BRIDGE_REQUEST_TTL_MS` | `30000` | Request cache lifetime |
| `BRIDGE_MAX_CONTROL_RATE_HZ` | `100` | Control operation rate per peer |

YAML `limits` is authoritative for concurrent peers, message bytes, queues, and channel buffers. Guard leases use each binding's `command_guard.lease_ms`. Empty permission lists deny the corresponding operation. Publication also checks the explicit scope and binding direction. This startup mode provides fixed permissions for a single credential; JWT, per-user permission updates, and credential issuance services are unimplemented.

An omitted `BRIDGE_HOST` selects loopback. An explicitly empty string rejects startup to prevent unintended wildcard binding.

The server provides `GET /health` and authenticated `POST /offer`.

Swagger UI is available at `/docs`, with HTTP specifications at `/openapi.json` and `/openapi.yaml` on the same HTTPS origin. Reading them requires no authentication. UI CSS/JavaScript comes from pinned `swagger-ui-dist 5.32.15` (Apache-2.0), served on the same origin without a CDN or external validator. Requests target the origin being viewed. Credentials entered into Authorize remain only in browser memory and are not persisted. Server credentials are never injected into the document or UI.

OpenAPI describes only the implemented health/offer endpoints. ROS Topic Pub/Sub uses the DataChannel wire protocol and is not listed as REST endpoints. A valid offer submitted through Try it out still requires a client implementing the three fixed DataChannels, ICE gathering, answer application, and ready handshake.

By default, the Gateway's ICE server list is empty and it uses host candidates. A deployment may set `BRIDGE_ICE_STUN_URL` to discover a server-reflexive candidate and must use `BRIDGE_ICE_PORT_MIN` / `BRIDGE_ICE_PORT_MAX` when its firewall permits only a fixed UDP range. The range controls local socket allocation; it does not configure the firewall, guarantee NAT traversal, or replace TURN. The test configuration supplies TURN on the browser side. SIGINT/SIGTERM revoke sessions and release peers, shared ROS entities, and HTTP sockets. The running process prints anonymous status every five seconds.

`registry.ts` syntax-checks candidate YAML types, resolves every actual type through the native loader, and constructs codecs. Schema IDs consist of `sha256:` followed by the hash of UTF-8 canonical JSON for `{codec:'ros-json-v1',descriptor,allowNonFinite}`. Object keys are recursively sorted in ascending JavaScript string order; array order is preserved. These IDs are distinct from ROS type hashes and public JSON Schema documents. Differences in non-finite-value policy caused by command guards also affect the ID.

Unit tests in `tests/unit/app/` use a native facade and real HTTPS sockets to verify authentication, ownership, synchronous publication after lease validation, and initialization/shutdown failures. Type availability, DDS, browser connections, and TURN require separate connection tests.
