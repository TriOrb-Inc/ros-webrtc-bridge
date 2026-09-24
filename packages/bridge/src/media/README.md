# Media plane

## Purpose

Serve configured ROS image sources as H.264 WebRTC video tracks, on demand, without letting raw
frames or RTP touch the JSON Topic path.

## Scope

- `index.ts` - `MediaService`: one `VideoSource` per configured track, the startup probe, the
  authorization-filtered catalog, viewer attach/detach and internal diagnostics.
- `source.ts` - `VideoSource`: viewer reference counting, the encoder lifecycle and RTP fan-out.
- `fixture.ts` - the `fixture` backend: replays a recorded RTP stream with no encoder or GPU.
- `types.d.ts` - the backend seam (`MediaSource`), the viewer sink and the injected `Schedule`.

Out of scope: SDP negotiation (`../transport/sdp.ts`), the `video.*` control operations
(`../router/video.ts`), and everything a backend does internally.

## Current state

Implemented and covered by unit tests: lifecycle, fan-out, keyframe rate limiting, the startup probe
and the `fixture` backend. `l4t_v4l2` and `openh264` are provided by the out-of-process media worker
([`worker/`](../../../../worker/README.md)), which this package drives through `createWorkerFactory`.
A host that cannot run the selected backend fails the probe with an actionable message rather than
falling back.

### Worker descriptor contract

The worker is a drop-in replacement point, so the descriptors are part of the contract rather than an
implementation detail:

| Descriptor | Carries |
| --- | --- |
| stdin | NDJSON control, one message per line, from the bridge |
| stdout | NDJSON events, one message per line, to the bridge |
| stderr | Human-readable diagnostics, relayed to the bridge log |
| fd 3 | RTP, RFC 4571 framed as `<uint16 big-endian length><packet>` |

A worker that puts anything else on stdout is broken, and the bridge treats it as such. That is not
hypothetical: L4T encoder elements print progress on stdout, so a worker loading them must claim the
event channel before anything else can write to it. The bundled worker duplicates fd 1 at startup and
points fd 1 at stderr, which makes the rule structural instead of a caution.

## Implementation decisions

**The encoder runs only while somebody watches.** A negotiated `m=video` section is a pipe, not a
subscription: watching starts with an explicit `video.subscribe`. The first viewer starts the
encoder, the last one leaving stops it after `video.stop_grace_ms`, so reconnecting does not restart
the pipeline. All viewers of one source share a single encoded stream.

**RTP is never queued.** A late frame is worth less than the next one, so packets are fanned out
immediately and dropped if a peer cannot take them. Each write is isolated: one failing peer does
not interrupt the others.

**Backends are injected, never discovered.** `MediaOptions.backends` maps a backend id to a factory.
A backend the build does not provide fails at probe time with the same message shape as a missing
GStreamer element. There is no `auto` selection and no fallback to another encoder: measurements on
four Jetson hosts showed that whether hardware encoding works depends on the carrier board's device
tree and on which packages are installed, so only an explicit choice plus a real probe is honest.

**The probe encodes.** `MediaService.probe()` runs before the HTTPS listener opens. Checking that an
element exists is not enough - an element can register and still fail because its device node is
absent - so a backend proves itself by producing output.

**Failure is terminal until somebody asks again.** A source that fails notifies its viewers and
stops. It is retried when a new subscription arrives, never by a hidden retry loop.

**Time is injected.** `Schedule` and the monotonic clock come from outside, so the grace window, the
start deadline and the PLI rate limit are tested at exact boundaries rather than by sleeping.

## Goals

- A GStreamer-backed worker providing `l4t_v4l2` and `openh264` behind the same `MediaSource` seam.
- ROS image metadata validation, which lives in the worker because raw frames never enter this
  process.
- Per-source bandwidth and drop accounting once a real encoder reports it.

## Related resources

- [Media configuration](../config/README.md) - `video`, `video_tracks` and `limits.video`.
- [Video control operations](../router/README.md) - `video.subscribe`, `video.unsubscribe`, `video.state`.
- [Transport](../transport/types.d.ts) - `VideoSlot`, the per-peer sink this plane writes into.
- [Design](../../../../docs/design.md) - negotiated contracts and verified scope.
