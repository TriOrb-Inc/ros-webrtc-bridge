# ros-webrtc-bridge

Open-source software connecting ROS 2 Topic Pub/Sub bidirectionally to WebRTC DataChannels. It is currently a connection proof of concept, with verification of bidirectional communication between Humble/Jazzy Docker environments and real Chromium, direct/TURN UDP connections, and installed ROS packages.

The [design document](docs/design.md) describes architecture, protocols, QoS, type conversion, authentication, the MVP, and validation plans.

The approach is to explicitly configure exposed Topics and directions while defining ROS 2 QoS independently of WebRTC delivery. The initial version targets small-to-medium messages exchanged with browsers.

Initial target distros are ROS 2 Humble and Jazzy, tested separately in Docker. Public Web names normally match ROS Topic names, with YAML aliases available.

## Implementation and execution

- [Configuration](packages/bridge/src/config/README.md): YAML validation, public-name/ROS-destination resolution, and protection-conflict detection.
- [Codec](packages/bridge/src/codec/README.md): JSON conversion using explicit type descriptors, with 64-bit integer, base64, and bounded-value validation.
- [Session](packages/bridge/src/session/README.md): command lease, sequence, and ownership validation; finite per-peer queues.
- [ROS adapter](packages/bridge/src/ros/README.md): descriptor generation, rclnodejs normalization, fixed ROS entities, and logical listeners.
- [Router](packages/bridge/src/router/README.md): wire v1, ready, catalog, Pub/Sub, authorization, rates, and reconnection.
- [Persistent credential storage](docs/ros-packaging.md#persistent-credential-store): initialize once or read an existing private Bearer file through an installed ESM helper.
- [Startup and HTTPS](packages/bridge/src/app/README.md): explicit single-Bearer permissions, TLS, three DataChannels, and cleanup.

Runs on Node.js 22 (22.12 or later; verified with 22.22.2).

```bash
npm ci --ignore-scripts
npm run prepare:transport
npm run typecheck
npm test
```

`npm test` builds, runs unit/integration tests, and enforces C0/C1 100% for each file. Generated artifacts go under Git-ignored `.runtime/`. Transport preparation verifies and generates the [bundled, license-reviewed werift core](vendor/werift-datachannel/README.md) without network access.

Connection tests are reproducible on a Linux Docker host:

```bash
npx playwright-core install chromium
npm run test:connection
```

For each Humble/Jazzy distro, the tests run an installed Gateway, independent rclpy node, and coturn on a dedicated network. They measure String/Twist and external custom BridgeFrame exchange, expired-command rejection, reconnection, and selected ICE candidates. Containers, networks, and temporary credentials are released regardless of outcome. See [connection test prerequisites and settings](tests/connection/README.md).

`npm run test:performance` runs performance regression tests; `npm run test:soak` uses a long-running profile. They measure real WebRTC→ROS→Web RTT, throughput, CPU/RSS, and cleanup. Shared-runner measurements are not absolute performance guarantees. The [performance harness](tests/performance/README.md) documents profiles and unmeasured areas.

For a persistent service, prepare native dependencies in the ROS environment, inject [startup settings](packages/bridge/src/app/README.md), and use `npm run bridge`. A browser SDK, outbound rendezvous, multi-user authentication, and comprehensive fault handling remain incomplete. See [design §14](docs/design.md#14-prototype-contracts-and-remaining-connection-boundaries) for implemented scope and remaining work.

Swagger UI is at `/docs` on the HTTPS server's origin. HTTP specifications are available at `/openapi.json` and `/openapi.yaml`, covering `GET /health` and Bearer-authenticated `POST /offer`. Topic Pub/Sub uses the DataChannel contract, not REST. The UI uses bundled assets with external validation and credential persistence disabled.

## Using the ROS 2 package

The ROS package is named `ros_webrtc_bridge`. Prepare rclnodejs in the ROS environment, then build/install through ament/colcon.

```bash
source /opt/ros/<distro>/setup.bash
npm ci --ignore-scripts
npm rebuild rclnodejs --foreground-scripts
colcon build --packages-select ros_webrtc_bridge
source install/setup.bash
```

Inject credentials and TLS keys/certificates through `BRIDGE_CREDENTIAL`, `BRIDGE_TLS_KEY`, and `BRIDGE_TLS_CERT` in the execution environment, not command lines. Topic subscription/publication permissions retain default-deny behavior.

```bash
export BRIDGE_CONFIG="$(ros2 pkg prefix ros_webrtc_bridge)/share/ros_webrtc_bridge/examples/bridge.yaml"
ros2 run ros_webrtc_bridge ros_webrtc_bridge
ros2 launch ros_webrtc_bridge bridge.launch.py
```

Launch defaults to installed `examples/bridge.yaml`. Override `config`, `host`, `port`, and `node_name` with launch arguments. The deployment package declares dependencies for interfaces referenced by custom configurations; regenerate rclnodejs bindings in that ROS environment. See [ROS packaging](docs/ros-packaging.md) for details, CMake options, and verification scope.

On PR creation, reopening, or pushes to a PR branch, [GitHub Actions](.github/workflows/ci.yml) runs unit/integration/coverage/transport tests and real ROS, Chromium, and colcon package tests across a matrix varying Humble/Jazzy, arm64/amd64, and Fast DDS/Cyclone DDS one axis at a time. The [performance workflow](.github/workflows/performance.yml) runs short PR regressions and one-hour soaks weekly or manually. Draft PRs and documentation changes are included. See [CI scope and results](TESTS.md#8-ci-and-support-matrix).

## Development and operations documentation

- [Frontend integration guide](docs/frontend-integration.md): HTTPS signaling, three fixed DataChannels, subscription, commands, reconnection, and type conversion.
- [CONTRIBUTING.md](CONTRIBUTING.md): development rules, validation, and dependency license policy.
- [TESTS.md](TESTS.md): test design, acceptance criteria, coverage measurement, and CI/release gates.
- [docs/ros-packaging.md](docs/ros-packaging.md): colcon build, install layout, execution, and dynamic interface dependencies.
- [AGENTS.md](AGENTS.md): agent workflow and planning/development/QA team operation.
- [SECURITY.md](SECURITY.md): security requirements and vulnerability-reporting status.

## License

[Apache License 2.0](LICENSE). Dependency licenses are reviewed individually.
