# Testing policy

Status: Unit and contract tests, real ROS, real Chromium, direct / TURN UDP connections, clean offline ROS package build/install/startup, external custom types, and performance/soak harnesses are implemented. Local validation covers Humble/Jazzy on arm64 and the Fast DDS/Cyclone DDS difference on Jazzy arm64. The PR matrix includes amd64, but it is not considered verified until actual Actions results are available. Network-failure coverage and other areas remain incomplete; this does not mean all gates have passed. Section 11 describes current commands and scope.

[CONTRIBUTING.md](CONTRIBUTING.md) defines shared development rules and mandatory coverage. [docs/design.md](docs/design.md) defines product contracts, and [SECURITY.md](SECURITY.md) defines security boundaries. This document specifies the environments, observations, and acceptance criteria used to verify those contracts. Update related documents together when changing specifications.

## 1. Purpose and guarantees

Priorities, in order, are preventing unauthorized or expired commands from reaching ROS publication, type/protocol compatibility, bounded resource use, connectivity, and performance. Scale testing to the impact of failures on users rather than code size.

- Scope includes Topic Pub/Sub, configuration, codecs, adapters, sessions, SDKs, signaling, transport, and the opt-in video plane.
- Services, Actions, Parameters, audio, browser-to-ROS video, and cyclic ROS-to-ROS forwarding are outside initial-version test scope.
- Mock success is not evidence of real ROS QoS, native callbacks, DDS discovery, browser interoperability, or NAT traversal.
- `published_to_ros` confirms only ROS publish API success. It does not guarantee controller receipt/completion, exactly-once behavior, or robot stopping time.
- Record hardware tests of command gates and watchdogs separately as system validation that includes the target controller. Bridge-only success is not a substitute.

## 2. Responsibilities by layer

| Layer | Main targets and methods | Passing observations |
| --- | --- | --- |
| Unit | Configuration/schema/codec, authorization, leases, sequences, queues; injected clocks and external I/O | Values, state transitions, and side-effect counts match the contract in normal, failure, and boundary cases |
| Contract | Shared mock/real ROS adapter interfaces, wire protocol, SDK, catalog, errors | The same fixtures and expectations fit each implementation; major/schema mismatches are explicitly rejected |
| Real ROS integration | rclnodejs, independent ROS nodes, QoS, entity lifetime, custom message types | Observe the ROS graph and actual received data without replacing them with mocks |
| Browser E2E | Real browsers, SDK, PeerConnections, signaling, real ROS | Verify bidirectional traffic, reconnects, authorization, and channel settings across boundaries |
| Network fault | Actual transport, TURN, injected delay/loss/bandwidth constraints/disconnections | Observe selected ICE paths, drops, queues, publication after revocation, and recovery |
| ROS packaging | colcon discovery/build/test, installation layout, `ros2 run`, `ros2 launch` | Start the installed entry point outside the source tree and verify HTTPS health and resource release |
| Release / performance | Distributed artifacts, fresh environments, sustained load, support matrix | Reproduce installation through startup and satisfy all mandatory gates and agreed budgets |

Units explore many orderings and boundaries quickly; E2E checks major user flows and connected boundaries. Do not duplicate every combination in E2E. Authorization, expiry, and resource release still require more than unit tests alone.

The runner is Node.js 22 `node:test`, with `c8 12.0.0` for coverage. TypeScript 5.9.3 generates source maps; checks include unimported files and unexecuted branches. Browser automation uses `playwright-core 1.63.0`, with actual WebRTC validated in Chromium 153.0.8010.12.

## 3. Fixtures and independent expectations

Current test locations include `tests/unit/`, `tests/contracts/`, `tests/coverage/`, `tests/ros/`, `tests/browser/`, and `tests/connection/`. The layout below also includes dedicated network-failure and performance locations; section 11 distinguishes implemented coverage from future work.

```text
packages/*/src/<module>/       # Implementation and internal API documentation
tests/unit/<module>/           # Configuration / codec / session
tests/contracts/              # Module integration; SDK coverage follows later
tests/coverage/               # Independent calibration of measurement settings
tests/fixtures/               # Manually checked wire values, configuration, type definitions
tests/ros/                    # Independent ROS publishers/subscribers and integration
tests/browser/                # Browser-to-real-ROS E2E
tests/connection/             # Docker isolation, direct/TURN matrix, cleanup
tests/network/                # TURN, fault injection, reconnects
tests/performance/            # Fixed workloads and aggregation
```

- Prepare `std_msgs/String`, `nav_msgs/Odometry`, `geometry_msgs/Twist`, and custom ROS interfaces with nested, bounded, fixed-length, and 64-bit values. Fixtures must be complete ROS messages, not abbreviated design examples.
- Verify encode and decode separately using golden vectors independently derived and reviewed from ROS type definitions and wire specifications. Round trips through the same codec cannot detect symmetric conversion errors.
- Implement real ROS peers as separate rclpy or rclcpp processes without sharing the bridge codec. Judge ROS → Web against ROS-side expectations and Web → ROS against values received by the independent node.
- Include the string `"00123"`, integer minima/maxima and out-of-range values, empty arrays, multibyte UTF-8, invalid or oversized decoded base64, non-finite floats, Time/Duration, and missing/unknown fields.
- Verify schema hashes with fixed vectors: codec-version or field changes alter the hash, while canonically equivalent inputs do not.
- Retain golden vectors when adding property-based tests, and save random seeds and minimal reproductions. Snapshot updates require review of specification changes.

## 4. Requirements and acceptance criteria

The following are mandatory initial-version conditions. Include IDs in test names or metadata and map them to execution targets during implementation. Report missing implementations as **not implemented** and checks lacking an environment as **not run**; do not count either as passing.

| ID | Scenario or injected condition | Acceptance criteria | Main layers |
| --- | --- | --- | --- |
| CFG-01 | Invalid Topic names, unavailable/unsupported types, contradictory QoS, zero/negative positive-only limits, conflicting command settings | Reject at startup with a reason and no partial catalog/entities. Do not reject configuration merely because the ROS graph has no publisher yet | Unit, real ROS |
| CFG-02 | Omitted/explicit `ros_topic`, public aliases, unconfigured Topics present | Without `ros_topic`, use the `topics` key as both ROS and public name. Otherwise use the key as public name and `ros_topic` as ROS target. Catalog and SDK use the same public name; unconfigured Topics remain hidden | Unit, Contract, real ROS |
| TYPE-01 | Convert all fixtures in both directions; supply out-of-range or unknown fields | Match golden values; reject invalid input without ROS publication | Unit, Contract, real ROS |
| PRO-01 | Major/schema mismatch, unknown operations, invalid channel labels/delivery settings | Explicitly reject the connection or operation; do not process data before permission is granted | Contract, Browser |
| PRO-02 | Reverse data/control ordering; delay ready | No delivery before handler registration and ready; deliver only new samples after ready | Contract, Browser |
| PRO-03 | Late data immediately after unsubscribe, duplicate requests, old handles, reversed sequences | Discard late data using tombstones; avoid duplicate side effects and retain cache bounds; never reuse handles | Unit, Contract |
| AUTH-01 | Other robots/sessions, unauthorized aliases, wrong direction/type, catalog access | Default deny; expose no unauthorized metadata and perform zero ROS publications | Unit, Browser |
| AUTH-02 | Revoke ACL/session/token while Web → ROS publication waits, or while a ROS → Web sample waits under peer backpressure | Reauthorize immediately before ROS publication and DataChannel handoff. After revocation completes, perform zero new ROS publications and zero new protected-sample handoffs; release queued data and listeners | Unit, real ROS, Browser |
| CMD-01 | Receive/dequeue immediately before, exactly at, and immediately after lease expiry | Expire at `now >= expires_at`; zero publications at/after expiry. Allow before expiry only if all other conditions hold | Unit, Contract |
| CMD-02 | Rearm, reconnect, Gateway restart, old epoch/lease/sequence, operations while disconnected | Never resend old commands into a new session or reuse old permissions; the SDK creates commands from new input | Unit, Browser, real ROS |
| CMD-03 | Concurrent arm through aliases resolving to the same ROS Topic after remapping | One writer session per normalized output Topic; reject old-owner or cross-handle lease reuse | Unit, real ROS |
| ACK-01 | ROS publication succeeds/fails; controller is not running | Emit `published_to_ros` only on API success; do not display or interpret it as controller completion | Contract, real ROS |
| QOS-01 | Compatible/incompatible best_effort/reliable and volatile/transient_local combinations | Distinguish successful compatible delivery from mismatch diagnostics; do not claim DataChannel settings recover DDS losses | Real ROS |
| QOS-02 | Latched samples, delayed subscribe, multiple publishers, ROS restart | Distinguish DDS history from Web delivery. Do not replay samples received before Gateway ready handling. DDS samples received after ready may be delivered regardless of source publication time. A snapshot is only the last sample and its age, not a complete tf_static state guarantee | Real ROS, Browser |
| SIZE-01 | Envelope-inclusive UTF-8 size at limit−1/limit/limit+1; supported sensor messages within bounds | Accept up to `min(configured limit, 16 KiB, negotiated limit)` and explicitly reject excess. Do not reject merely because the use case is sensors, count characters instead of bytes, or fragment automatically | Unit, Browser |
| FLOW-01 | Stop one peer while others continue; saturate reliable/realtime traffic | Stop reliable streams with slow_consumer; coalesce realtime to the latest value and record drops; preserve other peers' progress | Unit, Browser, load |
| FLOW-02 | High ROS rate, pending sends, control flood, cache growth | Account for stream/peer/process/channel buffers and cache within limits. Do not block ROS callbacks on sends; observe native backlog too | Real ROS, load |
| NET-01 | Direct/relay-only, TURN UDP/TCP/TLS, UDP blocking | Verify actual paths from selected candidate pairs. Every claimed supported path passes connection, bidirectional traffic, and reconnect recovery | Browser, Network |
| LIFE-01 | Repeated subscriptions/connections, exceptions or process termination mid-operation | Shared ROS entity counts stay fixed by configuration. Release handles/listeners/timers/buffers without unbounded growth | Unit, real ROS, load |
| SEC-01 | Deep JSON, oversized SDP/ICE/schema, authentication failure, logging | Enforce boundary limits/timeouts; exclude payloads, authentication, and connection information from default logs | Unit, Browser |
| OFFLINE-01 | Build clean source without root/vendor node_modules, `.runtime`, or colcon outputs in a network-blocked container | Using only a prepared lockfile cache and bundled transport, complete npm ci, binding generation, colcon build/test, and installed run/launch. Missing cache entries fail without network fallback | Package, CI |
| INST-E2E-01 | Connect a real browser and independent ROS node to the colcon-installed Gateway using `ros2 run`, not the source CLI | Package prefix points into the installation; retain String/Twist, lease/epoch, reconnect, direct/relay assertions | Browser, real ROS, Package |
| TYPE-CUSTOM-01 | Generate nested, bounded, fixed-array, 64-bit, and uint8-sequence types in an external interface overlay | Do not add test-type dependencies to core; match all fields through Web → ROS → Web after binding generation | Browser, real ROS |
| ARCH-AMD64-01 | Run Humble/Jazzy on native amd64 runners | Verify image architecture and `process.arch=x64`; all Fast DDS native, installed E2E, and offline packaging tests pass | CI |
| RMW-02 | Change only Fast DDS to Cyclone DDS from the baseline | Actual RMW identifier matches the request; Humble/Jazzy installed direct E2E and native tests pass | Real ROS, CI |
| PERF-01 | Measure real WebRTC → ROS → Web with a fixed workload | Aggregate RTT, connection time, throughput, CPU/RSS, loss/reject/unexpected, and cleanup without sensitive data; distinguish safety invariants from provisional budgets | Performance |
| SOAK-01 | Sustain the same installed path for one hour | Satisfy crash/OOM, loss/reject/unexpected, RSS, and cleanup criteria; do not treat shared-runner values as absolute performance guarantees | Performance, weekly CI |
| SYS-01 | Browser backgrounding/suspension, Gateway crash, delayed DDS/controller delivery | The target controller watchdog/gate stops and rejects late data as specified; pass only under separately defined system conditions | Hardware/system |
| VID-CFG-01 | Missing/unknown/`auto` backend, backend-incompatible profile or bitrate, unsupported encoding, out-of-range geometry, contradictory limits | Reject at startup naming the configuration path. No `auto` value exists | Unit |
| VID-CFG-02 | A topic served by two video sources, or by both `topics` and `video_tracks`; `video` and `video_tracks` configured apart | Reject at startup. The two planes never share one ROS topic | Unit |
| VID-CFG-03 | No `video_tracks` at all | Media plane never created. `m=video` rejected as before, `video.*` unknown, `welcome` gains no `video` key | Unit, Contract, Browser |
| VID-PROBE-01 | A configured backend that cannot encode on this host | Startup fails **before the listener opens**, naming configuration path, track, backend and cause. Remote errors stay anonymized | Unit, Hardware |
| VID-SDP-01 | Offer with `m=application` plus receive-only `m=video` | Answer `sendonly` H.264, echoing the offered payload type and profile | Unit, Browser |
| VID-SDP-02 | `m=audio`, non-`recvonly` video, simulcast/RID, no usable H.264 payload type, more sections than configured, `a=max-message-size` inside a video section | Reject with a fixed internal classification; the peer sees only `offer_rejected`. The DataChannel limit is read outside video sections | Unit |
| VID-LIFE-01 | Zero viewers | No encoder runs. A negotiated section alone does not start one | Unit, Hardware |
| VID-LIFE-02 | First, second and last viewer; resubscribe inside and after the grace window | One encoder shared by all viewers; a late joiner gets a keyframe; the encoder stops only after `stop_grace_ms`; resuming inside the window does not restart it | Unit, Browser |
| VID-LIFE-03 | Encoder fails to start, never emits, or stops unexpectedly | Viewers are told `failed`; the encoder is released; retried only when somebody subscribes again, never by a hidden loop. A shutdown the bridge asked for is not a failure | Unit |
| VID-LIFE-04 | Subscriptions to more distinct tracks than `limits.video.max_pipelines` | The extra subscription is refused and starts no encoder; a source inside its grace window still counts; a refused peer can retry once a pipeline frees | Unit |
| VID-SDP-03 | Offer whose sections carry different H.264 profiles | A track binds only to a section negotiated for the profile it produces; no compatible section is a rejection, not a silent mismatch | Unit |
| VID-KEY-01 | RTCP PLI, including bursts | One keyframe request per `pli_min_interval_ms`; a failing request is reported without stopping the source | Unit, Hardware |
| VID-AUTH-01 | Track whose `subscribe_scope` was not granted; scope revoked while watching | Absent from the catalog, subscription rejected, zero RTP handed over. After revocation no *new* packet is handed to the peer | Unit, Browser |
| VID-FLOW-01 | One peer failing to accept packets | RTP is never queued; other viewers keep receiving; the failure is reported anonymously | Unit |
| VID-LEAK-01 | Repeated connect/subscribe/disconnect cycles | No encoder, transceiver, socket or timer left behind | Unit, Video |
| VID-HW-01 | A real GStreamer backend on target hardware | The selected element actually encodes and a browser decodes it; evidence recorded | Hardware |

CMD-01 verifies the monotonic-clock expiry boundaries in the design. Do not substitute the browser wall clock for Gateway expiry decisions.

Verify rejection beyond error responses: for writes, assert zero publications with adapter spies and an independent ROS subscriber; for reads, assert zero protected-sample handoffs with transport spies and an independent browser. Mere absence at ROS or the browser could mean missed detection, so establish matched observers, valid controls before and after testing, unique markers, and observation windows. Do not misinterpret missing delivery from QoS mismatch as successful rejection.

Read-side revocation guarantees stop at the boundary where protected samples are newly handed from the application queue to transport after revocation completes. They do not guarantee retrieval of samples already handed to a DataChannel before revocation.

Test authorization, protocol, and input validation with raw clients that bypass the SDK. An SDK preventing invalid input does not prove Gateway validation.

## 5. Controlling time, races, and faults

- Test lease, request-cache, rate, and timeout boundaries with a fake monotonic clock. Separately inject a wall clock into identity validators that handle absolute token expiry. Wall-clock jumps must not affect leases.
- Insert barriers between receive validation and ROS publication for Web → ROS, and between queueing and transport handoff for ROS → Web. Deliberately trigger ACL revocation, expiry, disconnection, and writer changes rather than waiting for accidental races.
- Retain Browser/real ROS tests using actual timers; fake-timer units cannot establish real event-loop or browser-throttling behavior.
- With real timers, test comfortably inside/outside deadlines; verify exact equality in units. Configure tolerances for the environment, but never allow expired commands as part of timing tolerance.
- Verify independence from control/data ordering using both a transport harness that deliberately delays different channels and actual PeerConnections.
- Specify fault direction and configure 1%/5% loss, 100/300 ms RTT, bandwidth limits, disconnects, and recovery. Record injected and measured values. Unit packet dropping does not replace actual network tests. Seeds cannot reproduce process scheduling or packet order alone; retain direction and timing as well.
- Include forced relay-only TURN tests and do not count direct fallback as success. Collect selected candidate pairs; successful connection alone does not prove TURN use.

## 6. Environment isolation and cleanup

Run real ROS jobs independently in Docker with job-specific networks, nonconflicting `ROS_DOMAIN_ID` values, and Topic namespaces. Allocate domain IDs exclusively from their valid range rather than sharing a fixed value across parallel jobs. Verify that test nodes, Topics, and messages do not enter host or other-job ROS graphs. Domain isolation alone is not a security boundary; confine DDS discovery to the job network too.

- Run ROS nodes, the bridge, signaling, and TURN as job-owned processes. Verify discovery and readiness before sending samples.
- Isolate ports, browser profiles, workspaces, and certificates per job. Generate/inject credentials at runtime without storing them in the repository or artifacts.
- Use per-wait timeouts and an overall job deadline; fixed sleeps alone do not establish success.
- Release browsers, PeerConnections, ROS entities, child processes, ports, and network impairments in finally blocks on success or failure. Detect leftover processes/handles as failures.
- Apply impairments only in dedicated namespaces, never to developer-machine or shared-runner networks.
- Follow the shared rule of progress output at least every five seconds. Before an indivisible silent operation, report its reason and expected duration.
- Store local temporary output in `.runtime/`. Remove credentials/payloads/SDP/ICE information from CI artifacts and configure retention per job.

## 7. Coverage

The [shared rules](CONTRIBUTING.md#testing-rules) require **100% C0 and C1**. Use statement coverage for C0 and branch coverage for C1, not line coverage alone. MC/DC is out of scope.

- Measure all first-party runtime TypeScript, including bridge, SDK, and signaling. Do not exclude ROS adapters, startup, exceptions, or shutdown paths. The current implementation is bridge-only; `.c8rc.json` includes `packages/bridge/src/**/*.ts`. Expand it when adding packages.
- Explicitly include target sources so files never imported by tests still count at 0%. Verify C0/C1 100% overall and per file.
- Merge required unit/contract/integration/browser measurements tied to the same commit and source. Check duplicate Node/browser measurements and incorrect source-map associations.
- At M0, use small fixtures with unexecuted branches to calibrate TypeScript source maps, detection of unexecuted files, branch counting, and multi-job merging. Do not trust runner defaults alone.
- Exclude external dependencies, ROS/DDS/native libraries, generated artifacts, type declarations, and tests/harnesses from the runtime TypeScript denominator. Record exclusions and reasons in coverage configuration; do not exclude the first-party runtime source that produced generated artifacts.
- Native/DDS boundaries need real ROS tests even when outside coverage. If first-party native code is introduced, add a measurement policy for its language before declaring success.
- Units may stub external boundaries, but 100% through stubs does not establish real ROS/transport support. Do not satisfy numeric targets through execution without assertions about expected side effects.
- Remove unreachable code or reconsider its design. Do not use ignores, shrink denominators, or permanently skip tests merely to reach a number. Agree and record necessary exceptions as shared-rule changes first.

Coverage does not replace the acceptance table. Even 100% is insufficient when requirements remain unverified; implementation PRs must not report unmeasured coverage as achieved.

## 8. CI and support matrix

### Current PR workflow

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on `pull_request` events `opened`, `reopened`, and `synchronize`; pushing a new commit triggers `synchronize`. It does not filter by base branch or changed paths: all jobs run for draft PRs and documentation-only changes too. Per-PR concurrency cancels older runs to validate the latest changes.

- Unit job: Node 22.22.2, `npm ci --ignore-scripts`, transport preparation, typecheck, Unit/Contract tests and per-file C0/C1 100%, measurement calibration, and actual DataChannel tests.
- ROS jobs: separate VMs for each Humble/Jazzy combination with arm64 + Fast DDS, amd64 + Fast DDS, and amd64 + Cyclone DDS, changing one axis from baseline. Validate independent native tests, installed Gateway/Chromium direct connections, TURN UDP for Fast DDS, and clean network-blocked colcon build/test/run/launch. A failure in one must not suppress the other results.
- Performance workflow: PRs run a 15-second Jazzy/amd64/Fast DDS regression profile; weekly/manual `soak` runs the same installed path for one hour. Summaries contain sanitized aggregates only; shared-runner absolute values are not product performance guarantees.
- Grant only `contents: read` and do not retain checkout credentials. CI needs no long-lived credentials; harnesses generate connection credentials and TLS keys at runtime. Check out the PR merge commit to validate its combination with the base.
- Set timeouts for jobs and long operations. Harnesses release resources after success/failure; disposal of job-specific VMs reclaims leftovers after forced cancellation.

PR Checks expose job logs and Job Summaries. Publish coverage summaries and sanitized connection results to summaries, and credential-free Docker image-build diagnostics to job logs from explicitly selected paths only. Do not collect all of `.runtime/`, secret files, or Gateway/TURN logs. Failures before results are generated appear as missing results in summaries and require job-log diagnosis. Generated results alone do not prove that every job passed.

Retention follows the repository's Actions log settings. Downloadable artifacts containing raw coverage or connection results are not implemented. Reproduce detailed results with the section 11 commands and retrieve them from local `.runtime/`.

The workflow applies starting with PRs that contain it; it is not automatically added retroactively to existing PRs. Merge it into the base branch for shared application. Fork PRs follow GitHub's execution-approval settings; conflicted PRs follow GitHub's execution conditions. See [pull request event conditions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).

Automatic CI and branch-protection/ruleset settings that prohibit merging on failure are separate. This workflow does not change required-check administration.

### Future gates and support goals

The following are goals to add to the current PR workflow. Lint, fault injection, nightly, controller, and full release gates are not yet complete. If a required job for an implemented feature cannot run due to its environment, that change remains unverified.

| Trigger | Mandatory gates | Scope |
| --- | --- | --- |
| M0 implementation PR | Build/typecheck introduced by the PR, Unit/Contract, C0/C1 100%, real ROS and Chromium E2E on Humble and Jazzy | Add and pass runners/reproduction steps in the same PR as the PoC implementation. Mark future features as unimplemented, without exempting M0 implementation from validation |
| M1+ implementation PR | Build/lint/typecheck, Unit/Contract, C0/C1 100%, real ROS and Chromium E2E in both Humble/Jazzy baselines | Extend M0 gates with type fixtures, shared adapter contracts, and acceptance IDs for the change. Run jobs required for whole-runtime coverage regardless of changed files |
| Communication/authorization/QoS/dependency PR | Gates for its implementation stage, plus relay-only, relevant races/faults, and affected supported environments | Validate the change's risks without waiting for nightly |
| Nightly | Bridge acceptance criteria except SYS-01, support matrix, TURN paths, fault injection, repeated resource cleanup, sustained load | Expand combinations narrowed for PRs. Do not carry failures into the next day's release candidate |
| Hardware tests for controller examples | SYS-01 and controller-specific watchdog/gate criteria | Separate from core nightly; required before releasing examples and when controller contracts change |
| Release candidate | All mandatory tests pinned to the candidate commit/lockfile/artifact, agreed performance budgets, clean installation, dependency/license review | Every claimed environment/path; record artifact hashes and do not reuse success from earlier commits |

Target ROS distributions are Humble and Jazzy. PR/release baselines are both Ubuntu 22.04 / ROS 2 Humble and Ubuntu 24.04 / ROS 2 Jazzy, targeting Fast DDS / Linux amd64 / Chromium. Current PR CI adds native amd64 runners and Cyclone DDS variation to its arm64 baseline. Reproduce each environment in Docker and pin Node, rclnodejs, RMW, transport, and browser versions. Adding workflow entries alone does not establish support: inspect Actions results for the target SHA.

| Environment or axis | Introduction and promotion criteria |
| --- | --- |
| ROS-free mock / fixed Node version | Every PR from M0; reproduce contracts without ROS |
| Ubuntu 22.04 + Humble + Fast DDS + amd64 + Chromium | Bidirectional PoC at M0; baseline PR job from M1; mandatory for release |
| Ubuntu 24.04 + Jazzy + Fast DDS + amd64 + Chromium | Bidirectional PoC at M0; baseline PR job from M1; mandatory for release |
| Firefox / Playwright WebKit | Add Browser E2E and document support by M2. Distinguish Playwright's patched Firefox from product Firefox, and WebKit from actual Safari; product support needs separate real-browser validation |
| Linux arm64 | Current PR CI baseline; native runners execute Humble/Jazzy build, real ROS, and E2E. Assess performance guarantees separately |
| Cyclone DDS / additional ROS distributions | Add real ROS contract/QoS tests as demand and runners permit. Do not list untested RMWs/distributions as supported |
| TURN UDP/TCP/TLS and UDP blocking | Establish TURN at M0; publish per-path results at M2 and require claimed supported paths for release |

Both Humble and Jazzy baselines are mandatory. A full Cartesian product of extra axes is not required; vary one axis at a time from baseline. Add combinations when combination-specific bugs appear. If narrowing M2 browser goals or candidate CPUs, update the design and support table too.

## 9. Performance and soak tests

Use M0 measurements to set provisional budgets before M1, and formal budgets before measuring an M2 release candidate. Undecided values and untested paths cannot count as passing release criteria. Make thresholds configurable and review reasons for changes.

Current `tests/performance/` measures installed direct/reliable/String echo using 15-second PR and one-hour weekly profiles. It records browser-monotonic-clock RTT, connection time, throughput, loss/reject/unexpected, external `docker stats` CPU/RSS, process state, and cleanup in JSON. Default RTT and similar limits are loose initial PoC budgets, not formal product SLOs.

- Fix workloads around small-to-medium messages, specifying type/encoded bytes/rate, one/four peers, delivery mode, network conditions, and ROS QoS. Include near-limit and overload cases. Large sensor transfer performance and fragmentation are not mandatory initial-version goals.
- Record CPU model/core count, RAM, OS, ROS/RMW, Node, browser/transport versions, direct/relay path, warm-up, measurement duration, and repetition count with results.
- Record p50/p95/p99 latency, connection time, CPU, RSS, event-loop delay, native callback backlog, queue bytes, bufferedAmount, and drops/rejections.
- Use one-way latency only when clock synchronization and error can be assessed; otherwise use RTT or intervals within a single clock.
- Separate bounded-queue assertions from long-term RSS trends. Account for GC variation; growing native backlog fails even when application queues stay within bounds.
- Include degradation of healthy peers caused by slow peers, control-response latency, maximum RSS, resource growth after repeated connections, and soak duration in budgets.
- Compare against baselines using the same workload and environment. Do not claim improvement from a single best run or different load conditions.

## 10. Failures, flaky tests, and results

Preserve the first failure; an automatic retry succeeding does not turn a required gate green. Record investigative retries separately. Retain seeds, acceptance IDs, commit, environment, timeout, expected/observed values, and sanitized diagnostics.

Readiness checks before connection scenarios may use bounded polling within a shared deadline. Limit retries to transient reachability errors and retain the first fixed failure classification, attempt count, and elapsed time. Do not hide HTTP errors, authentication failures, or browser/Gateway shutdowns with retries, and do not rerun the connection scenario after readiness succeeds. This differs from retrying an entire failed acceptance test.

Track flaky tests with an issue, owner, causal hypothesis, and fix deadline. Quarantining must not silently remove coverage or mandatory acceptance criteria; without equivalent deterministic validation, the corresponding release gate remains unmet. Do not release while treating authorization, command-expiry, or resource-limit failures as tolerated.

Distinguish **pass**, **fail**, **skip**, **not implemented**, and **not run**. Give reasons for skips and never count them as passing mandatory criteria. Tie the support matrix, coverage scope/exclusions, results per acceptance ID, and remaining risks to the same commit. Section 8 describes PR CI retention and failure diagnosis.

## 11. Implementation order and completion criteria

1. **M0**: In implementation PRs, establish runner/measurement evaluation, Unit/Contract and first-party C0/C1 measurement, independent ROS fixtures, real-browser bidirectional PoC, and TURN. Pin selected versions and baseline environments, and establish provisional performance budgets.
2. **M1**: Expand type vectors, shared mock/real ROS adapter tests, queues/epochs, and related features while continuing M0 baseline E2E, coverage, and PR gates.
3. **M2**: Add lease/ACL/reconnect, multiple browsers, network faults, nightly load, artifact checks, and system tests for controller examples to meet mandatory initial-version IDs.

Each feature's implementation PR must add normal, failure, and boundary tests and execution steps. Do not defer validation of implemented functionality on the grounds that testing belongs to a later stage.

The current module prototype can run without ROS. Use Node.js 22 (22.12 or later; validated version 22.22.2), npm, and lockfile dependencies. See [CONTRIBUTING.md](CONTRIBUTING.md#local-checks) for build/typecheck details.

```bash
npm ci --ignore-scripts
npm run prepare:transport
npm run typecheck
npm test
npm run test:coverage
npm run test:transport
npm run test:transport:media
npm run test:packaging:contract
```

`npm test` builds and runs unit and module integration tests, requiring 100% statement/branch/function/line coverage for every first-party runtime file. Individual tests have a 10-second timeout and usually finish within seconds. Type declarations (`.d.ts`), external dependencies, generated JS, and tests/harnesses are excluded. Generated Werift code is external, but `npm run test:transport` verifies actual DataChannel traffic including pinned patches.

`npm run test:transport:media` verifies the vendored Werift media path between two local peers: that
send-only H.264 transceivers keep their m-line order and receive mids, that RTP survives DTLS-SRTP
with the sender stamping its own SSRC, that RTCP PLI reaches the sender, and what SRTP costs. It
paces packets at their media rate, because an unpaced burst overruns the receiver and measures
nothing. Measured on AGX Orin (JetPack 5, Node 20.20.2): 3.32 Mbps at 0% loss for roughly a quarter
of one core.

`npm run test:coverage` calibrates measurement settings. Isolated TypeScript fixtures check source maps, unexecuted branches, unimported files, and merging across processes. It asserts failures in intentionally under-covered child processes; the parent passing means calibration passed. Product thresholds are not lowered. Child timeouts default to 30 seconds and can be overridden with positive integer milliseconds in `COVERAGE_CALIBRATION_TIMEOUT_MS`. The overall limit is twelve times that value, with progress every five seconds while waiting.

| Current tests | Partial acceptance-ID coverage | Unverified boundaries |
| --- | --- | --- |
| `tests/unit/config/` | CFG-01/02, CMD-03 configuration conflicts | Native boundaries covered by ROS tests |
| `tests/unit/codec/` | TYPE-01, SEC-01 descriptors/values/capacity | Native compatibility of all ROS types |
| `tests/unit/session/`, `router/` | AUTH, CMD, FLOW, SIZE, LIFE, PRO state/wire boundaries | Load, native backlog, SDK |
| `tests/unit/ros/`, `app/` | Descriptors, 64-bit/bytes, hashes, startup/shutdown, real HTTPS/authentication | Multiple user identities, all ROS types |
| `tests/unit/config/video.ts`, `media/`, `router/video.ts`, `transport/sdp.ts` | VID-CFG-01/02/03, VID-PROBE-01, VID-SDP-01/02, VID-LIFE-01/02/03, VID-KEY-01, VID-AUTH-01, VID-FLOW-01 | Real encoders, ROS image validation, browser playback |
| `tests/unit/transport/`, `signaling/` | Three-channel properties, SDP/message capacity, pending cancellation, rejection before authentication, peer release, matching HTTP JSON/YAML specifications, same-origin Swagger assets, no credential exposure | Actual network faults |
| `tests/contracts/module-flow.test.ts` | Configuration → codec → guard → synchronous publish spy; codec → byte queue | Independent ROS observation below |
| `tests/ros/native.test.ts` | String/Twist, external BridgeFrame, chained remapping, real entities/shutdown | QoS mismatches, all ROS types, performance |
| `tests/browser/`, `tests/connection/` | Installed artifacts, actual wire/String/Twist/BridgeFrame, CMD-01/02, ACK-01, NET-01 UDP, reconnects | TURN TCP/TLS, UDP blocking, controller |
| `tests/packaging/` | ament metadata, clean offline colcon build/test, installed run/launch, no bundled secrets | Debian/bloom publication, official ROS build farm registration |
| `tests/video/` | VID-SDP-01, VID-LIFE-01/02, VID-AUTH-01, VID-LEAK-01 through a real ROS graph and a real decoder; `VIDEO_BACKEND` also runs VID-PROBE-01 and VID-HW-01 against a real encoder | Nothing in the video plane, once a backend is selected |
| `tests/performance/` | Installed direct String echo, RTT/throughput/CPU/RSS, 15-second regression, one-hour soak, cleanup | Event-loop/native backlog, queue/buffers, slow peers, fault injection, formal SLOs |

On a Linux Docker host, verify both distributions' direct / TURN UDP connections, and the video
plane against a real ROS graph and a real browser decoder, with:

```bash
npx playwright-core install chromium
npm run test:connection
npm run test:video
```

`npm run test:video` runs an independent rclpy image publisher and the colcon-installed bridge in
containers on a private network, and drives a real Chromium from the host. It asserts that nothing
decodes before `video.subscribe`, that a real decoder then reports `framesDecoded > 0`, that the
stream stops on unsubscribe, and that resuming reuses the same section. The encoder is the replay
backend, so it needs no GPU and verifies everything except encoding itself. See
[video tests](tests/video/README.md).

After sourcing the target ROS distribution and preparing the rclnodejs native addon, verify ROS packaging in isolation with the commands below. CI reuses the connection-test image in each Humble/Jazzy ROS job.

```bash
npm run test:packaging
npm run test:performance
npm run test:soak
```

See [connection tests](tests/connection/README.md) for environment isolation, credential creation/deletion, timeouts, and investigative matrix selection; [ROS tests](tests/ros/README.md) for standalone ROS checks; and the [performance harness](tests/performance/README.md) for load settings. Local validation covers Humble/Jazzy arm64 Fast DDS, Jazzy arm64 Cyclone DDS, Node 22.22.2, rclnodejs 2.2.0, Chromium 153.0.8010.12, and coturn 4.6.3. Promote amd64 to verified only after checking Actions results. Browser tests use raw clients because the SDK is not implemented.

`npm run test:video` passes on Jazzy/arm64: Chromium 153.0.8010.12 decodes a 320x240 stream through
the containerised bridge. That run found a real defect no unit test could - the PeerConnection was
built without declaring a video codec, so the browser received a payload type it had not negotiated
and counted packets that never became frames.

In CI the video plane is verified through the replay backend: negotiation, control operations,
lifecycle, authorization and RTP fan-out are covered, and a committed RTP recording
(`tests/fixtures/video/h264-320x240.rtp`) stands in for an encoder. Browser playback of the replayed
stream is not yet part of the browser suite.

**VID-HW-01 passes on hardware.** On an L4T R39 Orin, both GStreamer backends were run through the
containerised bridge to a real Chromium decoder over 30 seconds:

| Backend | Source | Decoded | Resolution | Keyframes | PLI |
| --- | --- | --- | --- | --- | --- |
| `l4t_v4l2` (NVENC) | Mock `sensor_msgs/msg/Image` publisher | 438 | 320x240 | 30 | 0 |
| `openh264` | Live camera on `/camera0` | 311 | 1600x1300 | 26 | 0 |

The two rows use different sources because this host cannot combine them: hardware encoding needs a
container matching the host Ubuntu release, while the camera publishers need the Fast DDS build they
were compiled against. [The video harness](tests/video/README.md) records the mount recipe and the
ABI constraint behind that split.

Those runs found two defects no unit test reproduced: an L4T encoder element writing to the worker's
stdout control channel, and asynchronous `video.state` events never being flushed to a peer that only
watches video. Both are fixed and now covered by unit tests.

`npm run test:video:hardware` reproduces a hardware run in one command on the target and writes its
evidence, including the host it ran on, to `.runtime/video-results-<backend>-<mode>.json`.

**Delivery over a real network is verified.** Every other video measurement in this document was taken
with the browser and the bridge on one machine, so nothing had crossed a network interface. This one
ran the bridge on an L4T R39 robot and the browser on a separate machine, over Wi-Fi and across
subnets, at 1280x720:

| Source | Link | Decoded / received in 30 s | Packets | Lost | PLI | RTT |
| --- | --- | --- | --- | --- | --- | --- |
| Mock publisher, 1280x720, NVENC | Wi-Fi, across subnets | 399 / 400 | 2830 | 0 | 0 | 9 ms |
| Real camera `/camera0`, 1600x1300 | Wired, same subnet | 320 / 321 | 6162 | 0 | 0 | 12 ms |
| Real camera `/camera0`, 1600x1300 | Wi-Fi, across subnets | 7 / 7 | 71 | 0 | 4 | 17 ms |

The third row is a slow camera, not a slow bridge: that robot publishes `/camera0` at 0.20 fps, and
the browser decoded 0.23 fps. Its four PLIs are the decoder asking for an IDR because
`keyframe_interval: 12` is about 52 seconds at that rate - real-network evidence that the keyframe
path works, and a reminder that the interval is a frame count, not a duration.

The bridge configures no ICE servers and offers host candidates only (`iceServers: []` in
`packages/bridge/src/app/cli.ts`), so a relayed video path is out of scope by construction; TURN, when
a deployment needs it, is the browser's `RTCConfiguration`.

**VID-LEAK-01 and multi-viewer VID-LIFE-02 pass against a real decoder.** `npm run test:video:load`
runs several browsers on one track at once, then repeats the whole connect/subscribe/leave cycle:

| Measurement | `fixture` | `l4t_v4l2` (NVENC) |
| --- | --- | --- |
| Concurrent viewers of one track, all decoding | 4 of 4 | 4 of 4 |
| Viewers still advancing after half of them left | 2 of 2 | 2 of 2 |
| Frames decoded per cycle, 6 cycles | 25, 25, 25, 25, 25, 25 | 26, 24, 25, 25, 23, 24 |
| Gateway resident growth across the cycles | 2.7 MiB | 3.9 MiB |

Both against a 64 MiB budget. A later cycle decoding a fraction of the first is how a leaked encoder,
transceiver or timer shows up from outside the process, so the flat per-cycle count is the assertion
that matters. Resident memory is sampled *between* the two phases rather than around both: an encoder
loads its libraries once, and charging that to the cycles reported a hardware run as a 94 MiB leak
when the repeated part actually costs 3.9 MiB.

Encoder backends can only run on host hardware, so they sit outside the CI coverage gate by the rule
in [CONTRIBUTING.md](CONTRIBUTING.md#testing-rules). Everything around them - the seam they plug
into, the lifecycle, the probe and its error text - stays inside it, and hardware runs must record
their evidence rather than being assumed.

Passing this scope and packaging tests does not mean every acceptance ID passes. QOS-01/02 mismatches/latched history, NET-01 TCP/TLS/UDP blocking, SYS-01, unmeasured performance indicators, and formal SLOs remain unverified or unimplemented. Debian/bloom publication is currently out of scope. ACK-01 verifies through an actual ROS observer, not controller completion. Distinguish these results from satisfying every mandatory gate and release condition in section 8.

Build output goes to `.runtime/build/` and coverage to `.runtime/coverage/`. Inspect per-file percentages in `coverage-summary.json`, and statement/branch locations in `coverage-final.json` and `lcov.info`. Do not commit measurement artifacts or investigation notes. Each harness README gives detailed ROS/browser/TURN startup, timeout, and cleanup instructions.

## 12. Primary references for tool evaluation

- [Node.js test runner](https://nodejs.org/api/test.html): Runner execution, isolation, and mocking features.
- [c8](https://github.com/bcoe/c8): Measurement of unloaded files with `--all` and source-map support. Calibrate includes/exclusions and thresholds for the selected version.
- [Playwright browsers](https://playwright.dev/docs/browsers): Reflect distributed browser types and differences from product browsers in the support matrix.

## Credential-store validation

`npm test` also runs `tests/unit/credential/*.test.mjs` directly and enforces C0/C1 100% for `scripts/credential-store.mjs`. Tests cover create-once concurrency, existing-value retention, private permissions, symlink/nonregular/path rejection, malformed tokens, ownership, storage publication failure cleanup, ordered directory fsync including newly created ancestors and existing/concurrent winners, directory-sync failure rejection, secret-free CLI output, direct execution through symlink installations, and inert ESM imports. Tokens are generated at runtime and assertions never render their values. The package contract verifies the shared helper's source and CMake install rule; the packaging smoke test executes `ensure` and `read` from the installed `share/ros_webrtc_bridge/scripts/credential-store.mjs`. These checks do not establish safety against malicious processes with the same user identity or credential delivery over HTTP.
