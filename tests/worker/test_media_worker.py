"""Exercise raw row alignment and the actual OpenH264 pipeline with GStreamer installed."""
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest

# The worker reserves stdout for its private protocol. Restore it for the test runner.
stdout_fd = os.dup(1)
spec = importlib.util.spec_from_file_location(
    'media_worker', Path(__file__).resolve().parents[2] / 'worker/media_worker.py')
worker = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(worker)
finally:
    os.dup2(stdout_fd, 1)
    os.close(stdout_fd)
worker.Gst.init(None)


def track(width=591, height=480):
    """Return the deployment's packed BGR input and even H.264 output contract."""
    return {
        'input': {'encoding': 'bgr8', 'width': width, 'height': height, 'framerate': 15},
        'output': {'width': (width + 1) & ~1, 'height': (height + 1) & ~1},
        'encoder': {'backend': 'openh264', 'bitrate': 1000000,
                    'keyframe_interval': 15, 'profile': 'constrained_baseline'},
    }


class Source:
    """Capture the appsrc buffer without starting the pipeline."""
    data = None

    def get_property(self, name):
        return 1 if name == 'max-buffers' else 0

    def emit(self, _signal, buffer):
        self.data = buffer.extract_dup(0, buffer.get_size())
        return worker.Gst.FlowReturn.OK


class MediaWorkerTest(unittest.TestCase):
    def test_packed_and_padded_ros_rows_match_gstreamer_stride(self):
        encoder = worker.Encoder(track(3, 2), lambda _packet: None)
        source = Source()
        encoder.source = source
        rows = [bytes(range(9)), bytes(range(9, 18))]
        expected = b''.join(row + bytes(3) for row in rows)
        try:
            for step in (9, 11, 12):
                with self.subTest(step=step):
                    # The source padding is not image content; preserve valid existing GST padding.
                    padding = bytes(step - 9)
                    message = SimpleNamespace(encoding='bgr8', width=3, height=2,
                                              is_bigendian=0, step=step,
                                              data=b''.join(row + padding for row in rows))
                    self.assertTrue(encoder.push(message))
                    self.assertEqual(source.data, expected)
        finally:
            encoder.stop()

    def test_overlay_geometry_produces_h264_parameter_set(self):
        result = worker.probe(track())
        self.assertEqual(result['profile_idc'], 66)
        self.assertLessEqual(result['level_idc'], 31)


if __name__ == '__main__':
    unittest.main()
