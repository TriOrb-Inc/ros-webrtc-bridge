# Video fixtures

## `h264-320x240.rtp`

An RFC 4571 framed RTP recording of a short H.264 stream, replayed by the `fixture` encoder backend
so the media plane - negotiation, lifecycle, authorization, RTP fan-out and browser playback - can be
verified without an encoder, GStreamer or a GPU.

| Property | Value |
| --- | --- |
| Size | 87,409 bytes |
| MD5 | `423855ff7fdc390ab42cc05ef755fb86` |
| Format | `<uint16 BE length><RTP packet>` repeated, as produced by GStreamer `rtpstreampay` |
| Contents | 100 packets, 30 frames, ~1.93 s, 320x240 at 15 fps |
| Codec | H.264 Constrained Baseline 3.1, `packetization-mode=1`, payload type 96, SSRC 1 |
| Keyframes | 2, each preceded by SPS and PPS so a viewer can join at either |
| Packet size | 1200 bytes maximum, matching the payloader MTU |

### How it was produced

Generated once on Jetson Orin NX (JetPack 7.2, L4T R39.2.0, GStreamer 1.24.2) with:

```bash
gst-launch-1.0 -q videotestsrc num-buffers=30 pattern=smpte is-live=false \
  ! video/x-raw,format=I420,width=320,height=240,framerate=15/1 \
  ! videoconvert \
  ! openh264enc bitrate=150000 gop-size=15 complexity=low \
  ! video/x-h264,profile=constrained-baseline \
  ! h264parse config-interval=-1 \
  ! rtph264pay pt=96 config-interval=-1 mtu=1200 ssrc=1 timestamp-offset=0 seqnum-offset=0 \
  ! rtpstreampay \
  ! filesink location=fixture.rtp
```

`openh264` was chosen over `x264` so no GPL tool appears in the procedure (see its licensing note in
[CONTRIBUTING.md](../../../CONTRIBUTING.md#license-and-dependency-rules)), and because
a software encoder is deterministic: the same command produced byte-identical output on two hosts,
which keeps the fixture reproducible.

The recording holds a synthetic test pattern only. It contains no camera data and no ROS payloads.

### Notes for readers

The fixture backend rewrites sequence numbers and timestamps on playback, so the values recorded here
are the source values, not what a viewer receives. The recording is replayed in a loop and its
geometry is fixed, which is why the fixture backend ignores a track's configured `input` geometry;
exercising ROS image validation and real encoding needs a hardware backend.
