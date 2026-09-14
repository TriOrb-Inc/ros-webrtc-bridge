# Browser-to-ROS connection tests

`npm run test:connection` checks Humble and Jazzy sequentially. It requires a Linux host that can run Docker directly, Node.js 22, npm dependencies, Playwright Chromium, and OpenSSL. Connections across a Docker Desktop VM have not been verified. The host must be able to reach container IP addresses on the dedicated Docker network.

```bash
npm ci --ignore-scripts
npm run prepare:transport
npx playwright-core install chromium
npm run test:connection
```

Building uses outbound connections to obtain images and npm artifacts. Tests run the Gateway, an independent rclpy node, and coturn on a job-specific `--internal` network. DDS uses domain 73 and the `/bridge_test` namespace; separate networks isolate jobs. The tests do not use host networking or the host ROS graph. HTTPS connects to port 7443 on the container IP, without publishing a host port.

Each run generates temporary Gateway Bearer credentials, TLS keys/certificates, and TURN credentials. A temporary directory readable only by its owner is mounted read-only and read by the container as root. Secret files are deleted after testing. Self-signed test certificates are accepted only in the dedicated Playwright context. This is not a procedure for managing TLS or credentials in a public deployment.

| Setting | Default and meaning |
| --- | --- |
| `CONNECTION_DISTROS` | `humble,jazzy`; select `humble` or `jazzy` for an individual investigation |
| `CONNECTION_TURN` | Only `0` skips TURN; both paths run by default |
| `CONNECTION_RMW_IMPLEMENTATION` | `rmw_fastrtps_cpp` (default) or `rmw_cyclonedds_cpp` |
| `CONNECTION_EXPECTED_ARCH` | Compare measured architecture with `arm64` or `x64` in CI |
| `CONNECTION_PLATFORM` | `linux/amd64` or `linux/arm64` for local emulation of a different CPU |
| `CONNECTION_BUILD_TIMEOUT_MS` | Docker image build deadline: default 1,200,000 ms (20 minutes), configurable from 60,000 to 1,800,000 ms |
| Gateway configuration | [connection-custom.yaml](../ros/connection-custom.yaml) pins standard types, an external custom type, QoS, and a 250 ms lease |
| Build/pull | Build uses the setting above; pull is limited to 180 seconds |
| Readiness | 30 seconds overall; 1 second per HTTPS request |
| Browser helper | 120 seconds per path shared by setup and scenario; `timeoutMs` permits 1–600 seconds. Cleanup allows 3 seconds each for close, kill, and exit confirmation |
| ROS peer | 360 seconds in this harness, injected into the peer through an environment variable |

Progress is reported every four seconds. The Gateway starts with `ros2 run ros_webrtc_bridge ros_webrtc_bridge` from the overlay built and installed by colcon inside the Docker image, without falling back to the source-tree CLI. Both the rclpy peer and the installed rclnodejs addon report their actual RMW identifiers, which must match the requested value. Node's `process.arch` and the Docker image architecture must match the matrix expectations. `tests/browser/connection.ts` starts real Chromium, where a raw client creates three DataChannels. This does not test a product SDK. `tests/ros/peer.py` is an independent peer that does not share the bridge codec.

- Match unique String markers through Web → ROS → Web.
- Publish a complete Twist with run-specific values and compare all fields observed by the independent ROS node. Also verify the receiving channel, stream, and epoch.
- Build the external `bridge_test_interfaces/msg/BridgeFrame` in an overlay before generating bindings, then check nested messages, bounded strings, int64/uint64, fixed uint8 sequences, and fixed float arrays through Web → ROS → Web.
- Reject expired leases and old epochs, and confirm that invalid commands are absent during the observation window. Continue monitoring all later messages for rejected values, with valid control commands before and after each rejection.
- On browser health failure, record only the fixed failure classification, attempt count, elapsed time, and Gateway `running`, `exitCode`, and `oomKilled` values in `result.json`. Results exclude URLs, credentials, SDP, and raw logs.
- Verify that epochs are not reused across the initial connection and two reconnects. Do not resend old commands.
- Inspect the selected candidate pair with `getStats()`. The TURN path forces browser `relay-only` mode and fails unless the selected local candidate is `relay`.

Locally verified configurations are Linux arm64, ROS Humble/Jazzy with Fast DDS, Jazzy with Cyclone DDS, Node 22.22.2, the bundled rclnodejs 2.2.0 prebuilt addon, Playwright 1.63.0 / Chromium 153.0.8010.12, and coturn 4.6.3. Fast DDS covers direct and TURN UDP paths; Cyclone DDS covers direct connections. Measure amd64 on native GitHub runners rather than substituting QEMU results. These results do not cover native-addon source compilation, TURN TCP/TLS, UDP blocking, QoS mismatches, or controller watchdogs.

Sanitized results and build diagnostics are stored under the root `.runtime/` directory. `connection-results.json` contains the aggregate; each distro's working directory contains its image ID and detailed results. Reruns after failure use separate directories. Containers and networks are released on both success and failure; cleanup failure is itself reported as a test failure.

[PR CI](../../.github/workflows/ci.yml) separates arm64 + Fast DDS, amd64 + Fast DDS, and amd64 + Cyclone DDS into individual jobs for Humble and Jazzy. Fast DDS runs direct/TURN UDP paths; Cyclone DDS runs direct paths. Each then uses the same Docker image for independent native tests and network-isolated packaging tests. Check the Job Summary for sanitized connection results and job logs for image-build diagnostics. See the CI section of [TESTS.md](../../TESTS.md) for retention details.
