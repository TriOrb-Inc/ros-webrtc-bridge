# Independent ROS tests

`Dockerfile` builds an independent image for each ROS distro/RMW, and `native.test.ts` communicates with an rclpy peer in another process. It checks UTF-8 String echo, complete Twist messages, every field of an external `BridgeFrame`, native remapping, and normal teardown. The Python peer does not share the bridge codec.

String transmission and reception configure both `source→target` and `target→other` rules. The test verifies that configuration ownership names and actual native Topic names agree on the once-resolved `target`. For both publishers and subscriptions, an erroneous second remap to `other` prevents communication with the peer.

```bash
docker build -f tests/ros/Dockerfile --build-arg ROS_IMAGE=ros:humble-ros-base-jammy --build-arg BRIDGE_RMW_IMPLEMENTATION=rmw_fastrtps_cpp -t ros-webrtc-bridge-test:humble-fastrtps .
docker build -f tests/ros/Dockerfile --build-arg ROS_IMAGE=ros:jazzy-ros-base-noble --build-arg BRIDGE_RMW_IMPLEMENTATION=rmw_fastrtps_cpp -t ros-webrtc-bridge-test:jazzy-fastrtps .
docker run --rm --network none -e ROS_LOCALHOST_ONLY=1 -e ROS_DOMAIN_ID=91 ros-webrtc-bridge-test:humble-fastrtps bash -lc 'source /opt/ros/humble/setup.bash && source /bridge/test_interfaces/install/setup.bash && node --test /bridge/.runtime/build/tests/ros/native.test.js'
docker run --rm --network none -e ROS_LOCALHOST_ONLY=1 -e ROS_DOMAIN_ID=92 ros-webrtc-bridge-test:jazzy-fastrtps bash -lc 'source /opt/ros/jazzy/setup.bash && source /bridge/test_interfaces/install/setup.bash && node --test /bridge/.runtime/build/tests/ros/native.test.js'
```

These examples run two processes in containers without external network access, keeping them out of the host and other jobs' ROS graphs. When running jobs on the same network, assign a dedicated network and distinct domain per job. `ROS_LOCALHOST_ONLY` works on both distros, though Jazzy emits a deprecation notice.

Use Node 22.22.2 and the lockfile, installing rclnodejs and generating types in the ROS environment. A compatible prebuilt native binary is used when available; that result does not count as compiling the native addon from source.

Cyclone DDS is an external test-only implementation installed only in RMW comparison images with `BRIDGE_RMW_IMPLEMENTATION=rmw_cyclonedds_cpp`. It is not a core ROS package or release-artifact dependency, and the test image itself is not publicly distributed.

Under `ROS_TEST_NAMESPACE` (default `/bridge_test`), the peer echoes String `in` to `out` and reports Twist `cmd_vel` as JSON on String `observed`. It also echoes BridgeFrame `custom_in` to `custom_out` using the external `bridge_test_interfaces` overlay, checking every field including 64-bit integers and bytes. `ROS_TEST_TIMEOUT_SECONDS` defaults to 120 seconds, with a maximum of 3600. Native tests set deadlines of 40 seconds for the peer, 45 seconds overall, 15 seconds per response, and two seconds for shutdown. The peer prints status every four seconds; discovery is not declared successful merely after a fixed sleep.

This test covers the ROS adapter and independent node. WebRTC, browsers, TURN, QoS mismatches, all ROS types, controller watchdogs, network faults, and CPU/RSS/latency performance require separate tests. The adapter context and peer process are released even on failure or exception.
