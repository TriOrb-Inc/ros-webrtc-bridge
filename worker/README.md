# Media worker

## Purpose

Encodes one configured ROS image topic into H.264 RTP, in its own process. The bridge owns
signalling, authorization and lifecycle; this worker owns the ROS subscription, frame validation and
the encoder. Raw frames never enter the bridge process.

## Scope

One worker serves exactly one video track, for as long as somebody is watching it. It contains the
ROS subscription, the GStreamer pipeline and the RTP framing. It contains no authorization, no
catalog, no credentials and no knowledge of peers: the bridge sends it only what it acts on.

Out of scope: choosing when to run (the bridge decides that from viewer count), retry policy, and
anything to do with SDP or SRTP.

## Current state

`media_worker.py` implements the contract below with `gi` (GStreamer) and `rclpy`. Two backends are
provided, selected explicitly by configuration:

| Backend | Chain | Where it runs |
| --- | --- | --- |
| `l4t_v4l2` | `nvvidconv ! nvv4l2h264enc` | Jetson, using the host's L4T GStreamer plugins |
| `openh264` | `openh264enc` | Anywhere `gstreamer1.0-plugins-bad` is installed |

Both are verified to a real browser decoder; see [the video harness](../tests/video/README.md) for
the hardware recipe and measurements. A process per source is what makes cleanup structural rather
than careful: stopping a source ends a process, so a leaked pipeline, subscription or socket is not
possible, and one backend crashing cannot disturb another.

## Implementation decisions

**Python rather than C++.** The worker needs a ROS subscription and a GStreamer pipeline and almost
nothing else. `rclpy` and `gi` provide both with no new dependency, no build step and no addition to
the distributed package, which a C++ worker would have required for no behaviour the bridge can see.

**The event channel is a private duplicate of fd 1.** The worker duplicates stdout at startup and
points fd 1 at stderr, so anything a loaded library prints becomes diagnostics. This is not defensive
tidiness: L4T encoder elements print progress on stdout, and one such line reaching the bridge is
read as malformed control output and fails the source. Moving the channel makes the contract hold
whatever a backend does.

**Scaling happens before the encoder, not after.** A track's `output` geometry is applied by the
chain itself - `videoscale` for the software backend, `nvvidconv` for L4T, which resizes in hardware
and is already in that chain. Encoding a smaller picture is also cheaper, so the cost is negative.

**The worker's ROS node takes no remaps.** A track's `ros_topic` is the name it subscribes to, and
nothing rewrites it. The bridge's own node applies the deployment's ROS arguments; the worker
deliberately does not, so a track names one topic and means it.

**Frames are rejected, never reinterpreted.** A frame whose encoding, geometry or endianness differs
from the negotiated caps is counted and dropped, as is one whose stride is narrower than a row or
whose data length disagrees with its own stride. Guessing would send a viewer a corrupted picture
that looks like a decoder fault. Row padding is the one thing accepted rather than rejected: a stride
wider than a row is repacked to the caps, because aligning rows is what many camera drivers do.

**The probe warns about the encoded level.** It parses the level the encoder actually produced and
says so on stderr when it exceeds the level browsers commonly offer, naming `output` as the way down.
Measuring beats computing it from the specification tables, because encoders differ.

**The probe proves the encoder, not the configuration.** It pushes blank frames through the real
pipeline, requires at least one RTP packet, and parses the SPS to check that the encoder produced the
profile that was asked for. An element that registers but cannot encode on this host is caught before
the listener opens.

### Descriptor contract

| Descriptor | Carries |
| --- | --- |
| stdin | NDJSON control, one message per line, from the bridge |
| stdout | NDJSON events, one message per line, to the bridge |
| stderr | Human-readable diagnostics, relayed to the bridge log |
| fd 3 | RTP, RFC 4571 framed as `<uint16 big-endian length><packet>` |

Control messages are `probe`, `start`, `force_keyframe` and `shutdown`. Events are `probe_result`,
`started`, `stats`, `failed` and `stopped`. Every message carries `v: 1`; a worker speaking another
version is refused rather than tolerated. A replacement worker only has to honour this contract.

## Goals

- Keep the encoder boundary a process boundary, so failure and cleanup stay structural.
- Keep everything encoder-specific in `BACKENDS`, so adding one is a single entry and nothing else.
- Keep the contract small enough that a worker in another language is a realistic substitution.

## Related resources

- [Media plane](../packages/bridge/src/media/README.md) - the bridge side of this contract
- [Video harness](../tests/video/README.md) - containerised verification and the Jetson recipe
- [Design](../docs/design.md) - section 15, video plane
- [Tests](../TESTS.md) - `VID-*` acceptance identifiers
