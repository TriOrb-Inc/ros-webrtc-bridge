# Containerised video verification

Verifies the video plane against a real ROS 2 graph and a real browser decoder, without needing a
GPU, GStreamer or a camera.

```bash
npx playwright-core install chromium   # once
npm run test:video            # behaviour, replay backend - no GPU, no GStreamer
npm run test:video:load       # multi-viewer and soak
npm run test:video:hardware   # real encoder on a Jetson, one command
```

Each run writes an evidence file under `.runtime/`: `video-results.json` for the default run, and
`video-results-<backend>-<mode>.json` otherwise, so a hardware run never overwrites the CI one. A
hardware evidence file also records the host it ran on (architecture, kernel, L4T release, GStreamer
version) - a measurement nobody can attribute is not evidence.

## What runs where

| Component | Where | Why there |
| --- | --- | --- |
| Independent image publisher (`../ros/video_peer.py`) | Container | A real rclpy node, so discovery is exercised rather than stubbed. It shares no code with the bridge |
| Bridge | Container | Started through the colcon-installed `ros2 run` entry point, not from the source tree |
| Browser | Host | A decoder is what is being tested, so it must be a real one. Playwright drives Chromium and reaches the container over a private Docker network |

Both containers join a `--internal` Docker network with a test-specific `ROS_DOMAIN_ID`, so DDS
discovery cannot reach the host graph or another job. That bridge does not carry multicast, which is
what DDS discovery defaults to, so the containers name each other through `ROS_STATIC_PEERS` and
discover by unicast instead. Giving up the isolation would be the worse trade on a robot, where the
host graph is live.

## What it proves

- The mock's `sensor_msgs/msg/Image` topic is discovered **by the gateway**, not merely by the container publishing it.
- An offer carrying receive-only `m=video` sections is answered `sendonly`, with one answered section
  per offered slot.
- **Nothing decodes before `video.subscribe`** - a negotiated section is a pipe, not a subscription.
- After subscribing, a real Chromium decoder reports `framesDecoded > 0` with a non-zero frame size.
  This is the assertion no unit test can make: it proves the bytes this bridge sends are decodable.
- After `video.unsubscribe` the decoded count stops advancing.
- Resubscribing resumes on the **same** `mid`, without renegotiation.

## What it does not prove

The encoder is the `fixture` backend, which replays a committed recording
(`../fixtures/video/h264-320x240.rtp`). So this does **not** verify encoding, ROS image metadata
validation, QoS negotiation on the image topic, or any GStreamer element - the replay backend creates
no subscription at all, and the mock publisher's frames are not what reaches the browser.
Those need a hardware backend. `../ros/hardware-video.yaml` is the same configuration with
`backend: l4t_v4l2`, for the manual run described below.

## Hardware encoding on a Jetson

This project never bundles GStreamer, so hardware encoding uses the L4T plugins already installed on
the host. Those plugins are built against the host's glibc and GStreamer, so the container has to
match the host release - on an L4T R39 host, a `noble` base. Mounting them into an older base fails
in the loader, not at run time: the encoder plugin itself needs only `GLIBC_2.17`, but it calls glib
2.80 symbols, and that glib needs `GLIBC_2.38`.

`npm run test:video:hardware` does all of this; the table below is what it sets up, and why. With a
matching base the container needs no extra packages - only mounts and environment:

| What | Why |
| --- | --- |
| `libgstnvvideo4linux2.so` and `libgstnvvidconv.so` bind-mounted into `/hostgst`, plus `GST_PLUGIN_PATH=/hostgst` | `nvv4l2h264enc` and `nvvidconv`. Only these two: exposing the host's whole plugin directory makes GStreamer scan hundreds of plugins that cannot load against a different base, which delays startup and buries real failures |
| `LD_LIBRARY_PATH=/usr/lib/aarch64-linux-gnu/nvidia:/usr/lib/aarch64-linux-gnu/tegra` | `libnvbufsurface`, `libnvv4l2` and the rest of the L4T runtime |
| A bind mount for `libcuda.so.1` | The one link-time dependency the runtime does not inject; without it the plugin does not load at all. `libEGL`/`libGLESv2` need no action - `gstreamer1.0-plugins-bad` already brings them in |
| `NVIDIA_VISIBLE_DEVICES=all`, `NVIDIA_DRIVER_CAPABILITIES=all` | The NVIDIA container runtime injects the driver libraries and `/dev/v4l2-nvenc` |

Measured on an L4T R39 Orin with the mock publisher, 320x240 at 15 fps over 30 seconds: 438 frames
decoded by Chromium, 30 keyframes, no PLI - the same frame count as the software backend, at 787
RTP packets against 558.

## Multi-viewer and soak (`npm run test:video:load`)

Two properties a single-viewer run cannot show:

- **Viewers of one track share the source.** Several browsers subscribe to the same track at once and
  all decode. Then half of them leave, and the rest must keep receiving - one peer going away is not
  a reason for the others to lose their picture, and a per-viewer encoder would show up right here.
- **The cycle does not degrade.** Connect, subscribe, watch, unsubscribe, close - repeated. A later
  cycle decoding a fraction of the first is how a leaked encoder, transceiver, socket or timer looks
  from outside the process.

The two run as separate phases so the gateway's resident memory can be sampled between them. An
encoder loads its libraries once; charging that to the cycles reports every hardware run as a leak.
Measured that way, six cycles cost 2.7 MiB on the replay backend and 3.9 MiB on NVENC.

This covers VID-LEAK-01 and the multi-viewer half of VID-LIFE-02 against a real decoder. It runs on
the replay backend by default, so it needs no GPU; set `VIDEO_BACKEND` to soak a real encoder.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `VIDEO_DISTROS` | `jazzy` | Comma-separated `humble` and/or `jazzy` |
| `VIDEO_PLATFORM` | Host architecture | `linux/amd64` or `linux/arm64` |
| `VIDEO_BUILD_TIMEOUT_MS` | `1200000` | Image build deadline |
| `VIDEO_PEER_WIDTH` / `_HEIGHT` / `_FRAMERATE` / `_ENCODING` | `320` / `240` / `15` / `rgb8` | Mock publisher geometry. Applied to the publisher and to the track configuration together, so the two cannot disagree. The replay backend still sends its recording, so only a real encoder changes what the browser decodes |
| `VIDEO_BACKEND` | `fixture` | `fixture`, `openh264` or `l4t_v4l2`. Anything but `fixture` runs the real media worker |
| `VIDEO_MODE` | `verify` | `load` runs the multi-viewer and soak scenario instead |
| `VIDEO_VIEWERS` / `VIDEO_CYCLES` / `VIDEO_HOLD_MS` | `4` / `6` / `1500` | Load-mode workload |
| `VIDEO_MAX_GROWTH_MIB` | `64` | Gateway resident-memory growth allowed across the load run |
| `VIDEO_LOAD_TIMEOUT_MS` | `600000` | Load-run deadline |
| `VIDEO_HOST_LIBDIR` | `/usr/lib/aarch64-linux-gnu` | Where the host keeps its multiarch libraries, for `l4t_v4l2` |
| `VIDEO_DOCKER_RUNTIME` | `nvidia` | Container runtime for `l4t_v4l2`; named explicitly because the daemon default differs between Jetsons |

Containers, the network and the temporary TLS material are removed on success and on failure.
Results are written to `.runtime/video-results.json` and contain no credentials or connection details.
