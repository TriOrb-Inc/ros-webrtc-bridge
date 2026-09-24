"""GStreamer media worker: one configured video source, one process.

Raw frames never enter the bridge process. This worker owns the ROS subscription, frame validation
and the encoder; the bridge owns signalling, authorization and lifecycle. The two speak a small
versioned contract, so a different worker implementation is a drop-in replacement:

  stdin   NDJSON control, one message per line, from the bridge
  stdout  NDJSON events, one message per line, to the bridge
  stderr  human-readable diagnostics, relayed to the bridge log
  fd 3    RTP, RFC 4571 framed as <uint16 big-endian length><packet>

The event channel is a private duplicate of stdout taken before anything else runs, because the
channel belongs to the contract and not to whatever the process happens to load: L4T encoder
elements print progress on stdout, and one such line reaching the bridge fails the source.

Everything specific to an encoder - element names, properties, bitrate units - lives in BACKENDS.
Adding one is a new entry there and nothing else.

Usage: media_worker.py --track <name>
"""

import argparse
import json
import os
import struct
import sys
import threading

# Claim the event channel and point stdout at diagnostics before importing anything that could
# write to it. Nothing below this line can reach the bridge except through emit().
CONTROL = os.fdopen(os.dup(1), 'w')
os.dup2(2, 1)

import gi  # noqa: E402

gi.require_version('Gst', '1.0')
from gi.repository import GLib, Gst  # noqa: E402

CONTRACT_VERSION = 1
MAX_LINE_BYTES = 8192
# Jetson NVENC rejects very small frames, so probe at a size every encoder accepts.
PROBE_WIDTH, PROBE_HEIGHT, PROBE_FRAMES = 320, 240, 10

# ROS image encodings this worker accepts, with their GStreamer format and bytes per pixel. The set
# is deliberately small: each entry needs a verified conversion path.
ENCODINGS = {'rgb8': ('RGB', 3), 'bgr8': ('BGR', 3), 'mono8': ('GRAY8', 1)}

# H.264 profile_idc values, used to check what the encoder really produced rather than what it was
# asked for.
PROFILE_IDC = {'constrained_baseline': 66, 'main': 77, 'high': 100}

# nvv4l2h264enc names profiles by its own enumeration. Configuration advertises all three for this
# backend, so the chain has to select one: leaving it at the element default made a `main` or `high`
# track fail the probe that checks the encoder produced what was asked for.
L4T_PROFILE = {'constrained_baseline': 0, 'main': 2, 'high': 4}


def l4t_v4l2(spec):
    """Build the L4T V4L2 encoder chain.

    @param spec: Validated track specification, e.g. {'encoder': {'bitrate': 4000000, ...}}.
    @returns: GStreamer chain description. Bitrate is in bits per second for this element.
    """
    encoder = spec['encoder']
    # Only properties present on every platform carrying this element are set unconditionally;
    # maxperf-enable for instance exists on Orin but not on Thor.
    return ('videoconvert ! video/x-raw,format=I420 ! nvvidconv ! video/x-raw(memory:NVMM),format=I420 '
            f'! nvv4l2h264enc bitrate={encoder["bitrate"]} iframeinterval={encoder["keyframe_interval"]} '
            f'idrinterval={encoder["keyframe_interval"]} profile={L4T_PROFILE[encoder["profile"]]} '
            'insert-sps-pps=true')


def openh264(spec):
    """Build the software encoder chain.

    @param spec: Validated track specification.
    @returns: GStreamer chain description. Bitrate is in bits per second for this element.
    """
    encoder = spec['encoder']
    return ('videoconvert ! video/x-raw,format=I420 '
            f'! openh264enc bitrate={encoder["bitrate"]} gop-size={encoder["keyframe_interval"]} complexity=low')


BACKENDS = {'l4t_v4l2': l4t_v4l2, 'openh264': openh264}


def emit(**message):
    """Send one NDJSON event to the bridge.

    @param message: Event fields, e.g. op='started', ssrc=1.
    @returns: None. Output is flushed so the bridge never waits on a buffer.
    """
    CONTROL.write(json.dumps({'v': CONTRACT_VERSION, **message}) + '\n')
    CONTROL.flush()


class Encoder:
    """One GStreamer pipeline. Owns nothing ROS-specific so it can also run during a probe."""

    def __init__(self, spec, on_packet):
        """Build the pipeline for one track.

        @param spec: Validated track specification with input geometry and encoder selection.
        @param on_packet: Called with each complete RTP packet as bytes.
        @returns: An Encoder in the NULL state.
        """
        backend = spec['encoder']['backend']
        if backend not in BACKENDS:
            raise RuntimeError(f'no chain is implemented for backend {backend}')
        image = spec['input']
        gst_format, self.bytes_per_pixel = ENCODINGS[image['encoding']]
        self.encoding_name = image['encoding']
        self.width, self.height = image['width'], image['height']
        self.expected_step = self.width * self.bytes_per_pixel
        self.on_packet = on_packet
        self.frames_in = self.frames_invalid = self.frames_dropped = self.packets = 0
        # leaky-type=downstream drops the oldest frame rather than blocking the ROS callback: a late
        # frame is worth less than the next one.
        description = (
            f'appsrc name=src is-live=true do-timestamp=true format=time max-buffers=1 '
            f'leaky-type=downstream block=false '
            f'caps=video/x-raw,format={gst_format},width={self.width},height={self.height},'
            f'framerate={image["framerate"]}/1 '
            f'! {BACKENDS[backend](spec)} '
            # config-interval=-1 repeats SPS/PPS with every IDR so a viewer can join at any keyframe.
            f'! h264parse config-interval=-1 '
            f'! rtph264pay pt=96 config-interval=-1 mtu={spec.get("mtu", 1200)} '
            f'! appsink name=sink sync=false emit-signals=true max-buffers=16 drop=false')
        self.pipeline = Gst.parse_launch(description)
        self.source = self.pipeline.get_by_name('src')
        self.pipeline.get_by_name('sink').connect('new-sample', self._on_sample)
        self.failure = None
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect('message::error', self._on_error)

    def _on_error(self, _bus, message):
        """Record a pipeline error. @param message: GStreamer bus message. @returns: None."""
        error, _debug = message.parse_error()
        self.failure = error.message

    def _on_sample(self, sink):
        """Forward one encoded RTP packet. @param sink: appsink. @returns: Gst.FlowReturn.OK."""
        sample = sink.emit('pull-sample')
        if sample is None:
            return Gst.FlowReturn.OK
        buffer = sample.get_buffer()
        ok, info = buffer.map(Gst.MapFlags.READ)
        if ok:
            self.packets += 1
            self.on_packet(bytes(info.data))
            buffer.unmap(info)
        return Gst.FlowReturn.OK

    def start(self):
        """Set the pipeline playing. @returns: None. A refused state change raises."""
        if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise RuntimeError('pipeline refused to start')

    def stop(self):
        """Release the pipeline. @returns: None. Safe to call repeatedly."""
        self.pipeline.set_state(Gst.State.NULL)

    def request_keyframe(self):
        """Force an IDR, independently of the backend. @returns: None."""
        # A downstream force-key-unit event is the encoder-neutral way to ask; element-specific
        # properties would tie the bridge to one backend.
        event = Gst.Event.new_custom(Gst.EventType.CUSTOM_DOWNSTREAM,
                                     Gst.Structure.new_empty('GstForceKeyUnit'))
        self.source.send_event(event)

    def push(self, message):
        """Validate one ROS image and hand it to the encoder.

        @param message: sensor_msgs/msg/Image.
        @returns: True when the frame was accepted; False when it was rejected and counted.
        """
        self.frames_in += 1
        data = message.data
        # Reject rather than reinterpret: a frame whose geometry differs from the negotiated caps
        # would be silently misread as a different image.
        if (message.encoding != self.encoding_name or message.width != self.width
                or message.height != self.height or message.is_bigendian
                or message.step < self.expected_step or len(data) != message.step * message.height):
            self.frames_invalid += 1
            return False
        if message.step != self.expected_step:
            # Row padding: repack so the buffer matches the caps stride exactly.
            data = b''.join(bytes(data[row * message.step:row * message.step + self.expected_step])
                            for row in range(self.height))
        buffer = Gst.Buffer.new_wrapped(bytes(data))
        if self.source.emit('push-buffer', buffer) != Gst.FlowReturn.OK:
            self.frames_dropped += 1
            return False
        return True


def probe(spec):
    """Prove the selected backend can encode on this host.

    @param spec: Validated track specification.
    @returns: Dict describing what the encoder produced, e.g. {'profile_idc': 66, 'level_idc': 31}.
    Raises RuntimeError with an actionable reason when the backend cannot be used.
    """
    for name in ['appsrc', 'appsink', 'videoconvert', 'h264parse', 'rtph264pay']:
        if Gst.ElementFactory.find(name) is None:
            raise RuntimeError(f'required GStreamer element {name} was not found')
    # Probe at the configured geometry: an encoder can accept one size and refuse another.
    packets = []
    encoder = Encoder(spec, packets.append)
    try:
        encoder.start()
        image = spec['input']
        blank = bytes(image['width'] * ENCODINGS[image['encoding']][1] * image['height'])
        loop_deadline = GLib.get_monotonic_time() + spec.get('probe_timeout_ms', 5000) * 1000
        for _ in range(PROBE_FRAMES):
            encoder.source.emit('push-buffer', Gst.Buffer.new_wrapped(blank))
        while not packets and GLib.get_monotonic_time() < loop_deadline and encoder.failure is None:
            GLib.MainContext.default().iteration(False)
        if encoder.failure is not None:
            raise RuntimeError(encoder.failure)
        if not packets:
            raise RuntimeError(f'pipeline produced no encoded output within {spec.get("probe_timeout_ms", 5000)} ms')
        parameters = _first_parameter_set(packets)
        if parameters is None:
            raise RuntimeError('encoder produced no parameter set')
        profile_idc, profile_iop, level_idc = parameters
        wanted = PROFILE_IDC[spec['encoder']['profile']]
        if profile_idc != wanted:
            raise RuntimeError(f'encoder produced profile_idc={profile_idc} but '
                               f'{spec["encoder"]["profile"]} ({wanted}) was requested')
        return {'profile_idc': profile_idc, 'level_idc': level_idc,
                'profile_level_id': f'{profile_idc:02x}{profile_iop:02x}{level_idc:02x}'}
    finally:
        encoder.stop()


def _first_parameter_set(packets):
    """Read the profile from the first SPS the encoder emitted.

    @param packets: RTP packets as bytes.
    @returns: (profile_idc, profile_iop, level_idc), or None when no SPS was produced.
    """
    for packet in packets:
        payload = packet[12:]
        if not payload:
            continue
        kind = payload[0] & 0x1F
        # A whole SPS carries its fields directly; a fragmented one carries them after the FU header.
        body = payload[1:] if kind == 7 else payload[2:] if kind == 28 and (payload[1] & 0x1F) == 7 else None
        if body is not None and len(body) >= 3:
            return body[0], body[1], body[2]
    return None


def run(track, spec, rtp):
    """Stream one ROS topic until the bridge asks to stop.

    @param track: Configured track name, used only in diagnostics.
    @param spec: Validated track specification.
    @param rtp: Writable binary stream for RFC 4571 framed packets.
    @returns: None.
    """
    import rclpy
    from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
    from sensor_msgs.msg import Image

    def write(packet):
        """Frame and forward one RTP packet. @param packet: bytes. @returns: None."""
        rtp.write(struct.pack('>H', len(packet)) + packet)
        rtp.flush()

    encoder = Encoder(spec, write)
    rclpy.init(args=spec.get('ros_args') or None)
    node = rclpy.create_node(f'ros_webrtc_video_{track}')
    qos = spec['ros_qos']
    profile = QoSProfile(
        history=HistoryPolicy.KEEP_LAST, depth=qos['depth'],
        reliability=ReliabilityPolicy.RELIABLE if qos['reliability'] == 'reliable' else ReliabilityPolicy.BEST_EFFORT,
        durability=DurabilityPolicy.VOLATILE)
    node.create_subscription(Image, spec['ros_topic'], encoder.push, profile)
    encoder.start()
    emit(op='started', track=track, payload_type=96)

    stopping = threading.Event()

    def control():
        """Apply bridge commands until the stream ends. @returns: None."""
        for line in sys.stdin:
            if len(line) > MAX_LINE_BYTES:
                emit(op='failed', track=track, cause='control line too long')
                break
            message = json.loads(line)
            if message.get('v') != CONTRACT_VERSION:
                emit(op='failed', track=track, cause='unsupported contract version')
                break
            if message['op'] == 'force_keyframe':
                encoder.request_keyframe()
            elif message['op'] in ('stop', 'shutdown'):
                break
        stopping.set()

    reader = threading.Thread(target=control, daemon=True)
    reader.start()
    reported = 0.0
    try:
        while not stopping.is_set():
            rclpy.spin_once(node, timeout_sec=0.1)
            # The bus watch is attached to the default GLib context, which nothing else here drives.
            # Without this the pipeline can fail asynchronously - the encoder losing its device, say -
            # and the worker would keep emitting healthy-looking stats over frozen video.
            while GLib.MainContext.default().iteration(False):
                pass
            if encoder.failure is not None:
                emit(op='failed', track=track, cause=encoder.failure)
                break
            now = GLib.get_monotonic_time() / 1e6
            # Report at least every second so the bridge can surface progress and detect a stall.
            if now - reported >= 1.0:
                reported = now
                emit(op='stats', track=track, frames_in=encoder.frames_in, frames_invalid=encoder.frames_invalid,
                     frames_dropped=encoder.frames_dropped, rtp_out=encoder.packets)
    finally:
        encoder.stop()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
        emit(op='stopped', track=track)


def main():
    """Read one command from the bridge and act on it. @returns: Process exit code."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--track', required=True)
    arguments = parser.parse_args()
    Gst.init(None)
    line = sys.stdin.readline()
    if not line:
        return 0
    request = json.loads(line)
    if request.get('v') != CONTRACT_VERSION:
        emit(op='probe_result', ok=False, cause='unsupported contract version')
        return 2
    spec = request['spec']
    try:
        if request['op'] == 'probe':
            emit(op='probe_result', ok=True, backend=spec['encoder']['backend'], **probe(spec))
            return 0
        if request['op'] == 'start':
            # fd 3 is inherited from the bridge; raw RTP never travels over a socket anyone else can reach.
            with os.fdopen(3, 'wb', buffering=0) as rtp:
                run(arguments.track, spec, rtp)
            return 0
        emit(op='failed', track=arguments.track, cause=f'unsupported operation {request["op"]}')
        return 2
    except Exception as error:  # noqa: BLE001 - every failure is reported to the bridge, never swallowed
        if request['op'] == 'probe':
            emit(op='probe_result', ok=False, backend=spec['encoder']['backend'], cause=str(error))
        else:
            emit(op='failed', track=arguments.track, cause=str(error))
        return 1


if __name__ == '__main__':
    sys.exit(main())
