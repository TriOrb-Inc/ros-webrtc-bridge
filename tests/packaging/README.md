# ROS package integration tests

## Purpose

Validate the ROS package integration of `ros_webrtc_bridge` separately from npm unit tests and connection tests. The scope covers colcon discovery/build/test, install layout, installed entrypoints, launch files, absence of bundled secrets, and fail-fast behavior for configuration-dependent ROS interfaces.

## Execution scope

Run `smoke.sh` on Linux with ROS 2 Humble or Jazzy, OpenSSL, colcon, and an npm cache containing every lockfile artifact. Distro images built from `tests/ros/Dockerfile` populate the cache during online builds, so the test container can run with `--network none`. The ROS graph defaults to localhost-only and `ROS_DOMAIN_ID=75`; set a job-specific `PACKAGING_ROS_DOMAIN_ID` for parallel runs.

```bash
source /opt/ros/${ROS_DISTRO}/setup.bash
bash tests/packaging/smoke.sh
```

For acceptance with network isolation, first build the image and npm cache normally. `npm ci --offline` fails on cache misses rather than falling back to network access.

```bash
docker run --rm --init --network none \
  --env ROS_DOMAIN_ID=75 --env ROS_LOCALHOST_ONLY=1 \
  ros-webrtc-bridge-test:<distro> \
  bash -lc 'source "/opt/ros/${ROS_DISTRO}/setup.bash" && bash tests/packaging/smoke.sh'
```

The test checks the following in order:

1. Static contracts for `package.xml`, ament dependencies, executable scripts, launch files, and bundled configuration.
2. A clean source copy excluding root/vendor `node_modules` and `.runtime`, plus colcon `build`, `install`, and `log`.
3. In an isolated workspace, `colcon build` with cache-only `npm ci --offline`, rclnodejs rebuild, and local transport materialization, followed by `colcon test` and `colcon test-result`.
4. The installed ament index, package metadata, launch files, configuration, `ros2 pkg executables`, and reusable credential-store CLI under the package share directory.
5. HTTPS health becomes ready through installed `ros2 run ros_webrtc_bridge ros_webrtc_bridge`.
6. The same health becomes ready through installed `ros2 launch ros_webrtc_bridge bridge.launch.py`.
7. A temporary configuration referencing an unavailable ROS interface fails fast rather than completing startup or timing out.
8. Package artifacts and shareable logs contain neither private keys nor runtime credentials.

Credentials and self-signed TLS keys are generated at runtime in an owned directory under `/tmp` and removed on exit. Values are not passed in command arguments, repository files, or CI artifacts. Diagnostics are saved under `.runtime/packaging-<distro>-*` and checked for credential matches at the end.

## CI integration

The existing Humble/Jazzy ROS matrix runs this script against each distro image created by connection tests. Adding package tests does not remove or skip independent rclpy native tests, real Chromium direct/TURN UDP connections, Unit/Contract tests, or the C0/C1 100% requirement.

Do not register `smoke.sh` directly with CTest in `CMakeLists.txt`: it would recurse into its own `colcon test`. Register the existing npm tests with CTest and run the packaging smoke script as a separate CI ROS-job step.

## Interpreting success

Success establishes that a package can be built, installed, and started from a source checkout for the specified distro. It does not guarantee Debian/bloom distribution or binary installation on a clean host. amd64, additional RMWs, performance, and long-running operation are assessed by separate connection/performance/CI layers; this script alone does not establish their support. `TESTS.md` distinguishes completed verification from unverified scope.
