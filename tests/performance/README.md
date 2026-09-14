# Performance and soak harness

This harness starts the Gateway with `ros2 run ros_webrtc_bridge ros_webrtc_bridge` from a colcon installation in an image previously built with `tests/ros/Dockerfile`. It does not start the source-tree Gateway directly. Only the performance configuration and independent rclpy echo peer are mounted read-only.

It measures String echo round trips as a black box, from real Chromium through a reliable DataChannel, the Gateway, actual DDS, and an independent ROS peer. Connection time and RTT p50/p95/p99/max use the browser's single `performance.now()` clock, without assuming host/container clock synchronization. The harness also records sent messages, echoes, losses, rejections, unexpected messages, total failures, and effective throughput. Host-side `docker stats` periodically samples CPU and RSS for the entire Gateway container.

## Running

Requirements are Node.js 22, npm dependencies, Playwright Chromium, Docker, OpenSSL, and the connection-test image. The harness does not build or pull images and runs on a dedicated Docker network without outbound connectivity. The default image is `ros-webrtc-bridge-test:jazzy-fastrtps`.

```bash
npm ci --ignore-scripts
npm run prepare:transport
npx playwright-core install chromium
docker build -f tests/ros/Dockerfile \
  --build-arg ROS_IMAGE=ros:jazzy-ros-base-noble \
  --build-arg BRIDGE_RMW_IMPLEMENTATION=rmw_fastrtps_cpp \
  -t ros-webrtc-bridge-test:jazzy-fastrtps .
npm run build
node .runtime/build/tests/performance/run.js
```

The same harness runs soak tests:

```bash
PERFORMANCE_MODE=soak node .runtime/build/tests/performance/run.js
```

Each run owns its Docker containers, network, Chromium process, TLS keys, and temporary credentials, and closes or deletes them within bounded deadlines on success or failure. Secret files live in an OS temporary directory. Only sanitized aggregate JSON is saved under `.runtime/`, separated by mode, timestamp, and random suffix. JSON and stdout exclude URLs, container/image names, credentials, SDP, ICE information, raw payloads, and raw process logs.

## Default profiles

The source of truth is [`default.json`](default.json). `performance` is a short PR/local measurement; `soak` measures one hour of operation.

| Value | performance | soak |
| --- | ---: | ---: |
| Peers | 1 | 1 |
| Rate per peer | 10 msg/s | 10 msg/s |
| String data bytes | 256 | 256 |
| Warm-up | 3 s | 30 s |
| Measurement duration | 15 s | 3600 s |
| Echo drain timeout | 10 s | 30 s |
| Overall deadline | 90 s | 3720 s |
| CPU/RSS sample interval | 1 s | 5 s |
| Heartbeat | 4 s | 4 s |

`bridge.yaml` fixes a maximum of four peers, 16 KiB messages, reliable/volatile/keep-last QoS with depth 256, reliable DataChannels, and direct connections. The default workload uses small-to-medium Strings. Use separate profiles/configurations that state the intent when testing near limits, overload, or TURN.

## Configuration and environment variables

`PERFORMANCE_CONFIG` accepts JSON or YAML. The document contains `version: 1` and a `profiles` map; the selected profile follows the structure in `default.json`. Unknown fields, out-of-range values, aliases, and warm-up/measurement/drain durations that cannot fit within the overall deadline are rejected before starting. `PERFORMANCE_MODE` selects a profile. Environment variables override its selected values.

| Environment variable | Default | Range and meaning |
| --- | --- | --- |
| `PERFORMANCE_CONFIG` | `tests/performance/default.json` | JSON/YAML configuration path |
| `PERFORMANCE_MODE` | `performance` | Profile name; `soak` is also included |
| `PERFORMANCE_IMAGE` | `ros-webrtc-bridge-test:jazzy-fastrtps` | Image containing a colcon installation |
| `PERFORMANCE_RMW_IMPLEMENTATION` | `rmw_fastrtps_cpp` | `rmw_fastrtps_cpp` / `rmw_cyclonedds_cpp` |
| `PERFORMANCE_PEERS` | Profile value | 1–4 |
| `PERFORMANCE_RATE_HZ` | Profile value | 0.1–500 per peer |
| `PERFORMANCE_PAYLOAD_BYTES` | Profile value | 64–12000 ASCII String data bytes |
| `PERFORMANCE_WARMUP_SECONDS` | Profile value | 0–3600 |
| `PERFORMANCE_DURATION_SECONDS` | Profile value | 1–86400 |
| `PERFORMANCE_DRAIN_TIMEOUT_SECONDS` | Profile value | 1–300 |
| `PERFORMANCE_OVERALL_TIMEOUT_SECONDS` | Profile value | 10–90000 |
| `PERFORMANCE_RESOURCE_SAMPLE_SECONDS` | Profile value | 0.25–60 |
| `PERFORMANCE_HEARTBEAT_SECONDS` | Profile value | 1–5 |
| `PERFORMANCE_MAX_LOSS` | 0 | Safety invariant; nonnegative integer |
| `PERFORMANCE_MAX_REJECTS` | 0 | Safety invariant; nonnegative integer |
| `PERFORMANCE_MAX_UNEXPECTED` | 0 | Safety invariant; nonnegative integer |
| `PERFORMANCE_MAX_RSS_MIB` | 1024 | Safety invariant |
| `PERFORMANCE_REQUIRE_NO_CRASH` | `1` | `0` / `1` |
| `PERFORMANCE_REQUIRE_NO_OOM` | `1` | `0` / `1` |
| `PERFORMANCE_REQUIRE_CLEANUP` | `1` | `0` / `1` |
| `PERFORMANCE_MAX_RTT_P99_MS` | 5000 | Provisional PoC budget |
| `PERFORMANCE_MAX_CONNECTION_P99_MS` | 30000 | Provisional PoC budget |
| `PERFORMANCE_MIN_THROUGHPUT_RATIO` | 0.5 | Effective throughput / configured rate; 0–1 |
| `PERFORMANCE_MAX_RSS_GROWTH_MIB_PER_HOUR` | Profile value (short run: 16384; soak: 512) | Provisional PoC budget; least-squares slope of samples taken on a monotonic clock |

## Meaning of the gates

Safety invariants are reported separately: `loss/reject/unexpected=0`, no Gateway/peer crashes or OOMs, successful cleanup, and the RSS limit. RSS slope requires at least two samples spanning at least one second; otherwise it records `null` and fails. RTT, connection time, throughput ratio, and RSS slope use deliberately loose `provisional` PoC budgets to begin measurement. Review these provisional values against a baseline using the same workload and environment before M1, and replace them with formal budgets before an M2 release candidate.

Results from shared runners gate regressions and invariants; they do not guarantee absolute performance. Do not directly compare results with different CPU allocations, competing jobs, or architectures, or cite a single best run as evidence of improvement. JSON records CPU model/core count/RAM, OS, ROS/RMW, Node, Chromium, transport, workload, QoS, and network path alongside results.

## Currently unmeasured areas

This initial harness covers CPU/RSS, connection time, RTT, throughput, and failures for direct/reliable/String echo. It does not yet measure event-loop delay, native callback backlog, application queue bytes, DataChannel `bufferedAmount`, degradation of healthy peers caused by slow peers, control-response latency, resource growth after repeated connections, TURN, network impairment, or large sensor payloads/fragmentation. RSS slope is an external observation of the entire container; it cannot identify the cause of native backlog or prove a leak. Do not treat unmeasured areas as passing release criteria.
