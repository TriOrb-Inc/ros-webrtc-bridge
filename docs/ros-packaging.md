# ROS packaging

## Purpose and current status

In addition to direct Node.js/TypeScript execution, this repository supports build, installation, and startup as the ament package `ros_webrtc_bridge`. Package version `0.0.0` indicates a connection proof of concept, not a completed Debian/bloom public release.

The ROS package integration consists of:

- `package.xml`: package metadata, ament/Node/launch dependencies, and ownership of dynamic ROS interface dependencies.
- `CMakeLists.txt`: transport and TypeScript build, CTest, and installation of the runtime, dependencies, configuration, and launch files.
- `scripts/ros_webrtc_bridge`: wrapper that starts the installed ES module through `ros2 run`.
- `launch/bridge.launch.py`: launch file that resolves the installed configuration and entrypoint.
- `examples/*.yaml`: example configurations installed under `share/ros_webrtc_bridge/examples`.

## Build and test

Use Node.js 22 and the lockfile. Explicitly generate the rclnodejs native addon and message bindings in an environment sourced for the target ROS distro.

```bash
source /opt/ros/<distro>/setup.bash
npm ci --ignore-scripts
npm rebuild rclnodejs --foreground-scripts
colcon build --packages-select ros_webrtc_bridge
colcon test --packages-select ros_webrtc_bridge
colcon test-result --verbose
```

The colcon build runs `npm run prepare:transport` followed by `npm run build`. Transport preparation verifies 300 bundled, selected/patched core files against hashes, dependency closure, and notices, then generates artifacts without network access. Upstream artifacts are downloaded only through the maintainer-invoked `vendor/werift-datachannel/refresh.mjs`.

To let CMake prepare Node dependencies in an isolated clean workspace, preload the npm cache with every lockfile artifact and use the following options. `ROS_WEBRTC_BRIDGE_RUN_NPM_INSTALL=ON` runs `npm ci --ignore-scripts --offline --no-audit --no-fund`; a cache miss fails without network fallback.

```bash
colcon build --packages-select ros_webrtc_bridge --cmake-args \
  -DROS_WEBRTC_BRIDGE_RUN_NPM_INSTALL=ON \
  -DROS_WEBRTC_BRIDGE_RUN_RCLNODEJS_REBUILD=ON
```

`ROS_WEBRTC_BRIDGE_INSTALL_NODE_MODULES` defaults to `ON` and installs the locked build-time dependency tree, including rclnodejs native bindings, as ordinary files. Source executable bits are not preserved, so dependency helper scripts do not become public `ros2 run` executables. Set it to `OFF` only when release packaging supplies runtime dependencies at the same module-resolution location. `ROS_WEBRTC_BRIDGE_RUN_NPM_TEST` defaults to `ON`, allowing `colcon test` to run existing Unit/Contract/coverage checks and the static package contract.

## Install layout and startup

Main installation paths:

```text
lib/ros_webrtc_bridge/ros_webrtc_bridge
lib/ros_webrtc_bridge/dist/
lib/ros_webrtc_bridge/node_modules/
lib/ros_webrtc_bridge/vendor/
share/ros_webrtc_bridge/examples/
share/ros_webrtc_bridge/launch/
```

Source the overlay and inject secrets and permissions into the process environment. Deployment tooling must supply a method that does not leave values in shell history.

```bash
source install/setup.bash
export BRIDGE_CONFIG="$(ros2 pkg prefix ros_webrtc_bridge)/share/ros_webrtc_bridge/examples/bridge.yaml"
export BRIDGE_CREDENTIAL="${DEPLOYMENT_BRIDGE_CREDENTIAL}"
export BRIDGE_TLS_KEY="${DEPLOYMENT_BRIDGE_TLS_KEY}"
export BRIDGE_TLS_CERT="${DEPLOYMENT_BRIDGE_TLS_CERT}"
export BRIDGE_SUBSCRIBE_TOPICS=/odom
export BRIDGE_PUBLISH_SCOPES=teleop
ros2 run ros_webrtc_bridge ros_webrtc_bridge
```

Launch inherits the same environment. Do not pass secrets as launch arguments. The default configuration is installed `examples/bridge.yaml`, and the default bind address is loopback.

```bash
ros2 launch ros_webrtc_bridge bridge.launch.py \
  config:=/absolute/path/to/bridge.yaml \
  host:=127.0.0.1 port:=7443 node_name:=ros_webrtc_gateway
```

Pass ROS remaps and other ROS arguments through `BRIDGE_ROS_ARGS`, a JSON string array. Extra command-line arguments to the wrapper are not implicitly interpreted as ROS arguments.

Pinned `swagger-ui-dist` CSS/JavaScript is included in the default `node_modules` installation, so `/docs` on the installed entrypoint does not depend on the source tree or a CDN. With `ROS_WEBRTC_BRIDGE_INSTALL_NODE_MODULES=OFF`, supply this package at the module-resolution location just like other runtime dependencies.

## ROS interface dependencies

The message packages needed by the Gateway depend on `ros_type` in `bridge.yaml`; the core package cannot enumerate them. The deployment package owning the configuration declares `exec_depend` for `std_msgs`, `geometry_msgs`, custom interfaces, and other types it uses. Source that overlay and run `npm rebuild rclnodejs --foreground-scripts` to generate bindings.

Missing or ungenerated types are rejected during startup type resolution. There is no fallback that partially exposes types or guesses their structure from names. Only the package integration tests using bundled configurations declare the necessary interfaces as `test_depend`.

## Validation and remaining work

`npm run test:packaging` creates an isolated colcon workspace on Humble or Jazzy and verifies discovery, offline build, CTest, install layout, `ros2 run`, `ros2 launch`, HTTPS health, absence of bundled secrets, and fail-fast handling of unknown interfaces. CI runs the connection image with `--network none`. Connection E2E tests use the same installed colcon entrypoint for bidirectional verification of standard and external custom types between real Chromium and an independent rclpy node.

These tests do not replace independent rclpy, real Chromium, or direct/TURN UDP tests. Debian/bloom publication is currently out of scope. The package is not registered with the ROS build farm; clean-source CI containers without network access provide build-farm-like reproducibility checks. Bundling `node_modules` is a distro/architecture-specific PoC approach. A future public release must separately fix how runtime dependencies and license notices are produced.

Transport materialization already uses only bundled local inputs and works offline. Installing Node dependencies from clean source still requires a prepopulated npm cache; supplying dependency artifacts to the ROS build farm remains unresolved. The packaging smoke test copies source excluding root/vendor `node_modules` and `.runtime`, and colcon `build`/`install`/`log`, then reconstructs offline npm installation, rclnodejs rebuild, build/test/install/run using CMake options. A prebuilt ROS test image can run with `docker run --network none` to check network independence.
