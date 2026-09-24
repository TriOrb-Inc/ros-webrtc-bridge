"""Independent rclpy image source. Publishes verifiable sensor_msgs/Image frames for the video plane.

Each frame carries its own number in the first pixels, so a consumer can prove which frame it
received rather than only that bytes arrived. The pattern is synthetic: no camera is involved and
nothing here shares the bridge's own conversion code.
"""

import os
import sys
import time

import rclpy
from rclpy.node import Node
from rclpy.executors import ExternalShutdownException
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from rclpy.utilities import get_rmw_implementation_identifier
from sensor_msgs.msg import Image

# Kept small so a frame stays cheap to build in Python; the bridge bounds geometry by configuration.
WIDTH = int(os.environ.get('VIDEO_PEER_WIDTH', '320'))
HEIGHT = int(os.environ.get('VIDEO_PEER_HEIGHT', '240'))
FRAMERATE = float(os.environ.get('VIDEO_PEER_FRAMERATE', '15'))
ENCODING = os.environ.get('VIDEO_PEER_ENCODING', 'rgb8')
BYTES_PER_PIXEL = {'rgb8': 3, 'bgr8': 3, 'mono8': 1}


class VideoPeer(Node):
    """Publish synthetic images. Input: namespace; returns a node publishing at the configured rate."""

    def __init__(self, namespace):
        """Create the image publisher. Example input: '/bridge_test'; returns a VideoPeer instance."""
        super().__init__('independent_video_peer', namespace=namespace)
        if ENCODING not in BYTES_PER_PIXEL:
            raise ValueError(f'unsupported VIDEO_PEER_ENCODING: {ENCODING}')
        self.step = WIDTH * BYTES_PER_PIXEL[ENCODING]
        # Live video: best effort and volatile, so a late subscriber gets current frames rather than
        # a replay of history.
        qos = QoSProfile(history=HistoryPolicy.KEEP_LAST, depth=1,
                         reliability=ReliabilityPolicy.BEST_EFFORT,
                         durability=DurabilityPolicy.VOLATILE)
        self.images = self.create_publisher(Image, 'image_raw', qos)
        self.frame = 0
        self.create_timer(1.0 / FRAMERATE, self.publish_frame)
        self.create_timer(4.0, self.status)
        print(f'independent ROS video peer ready: {WIDTH}x{HEIGHT} {ENCODING} at {FRAMERATE} fps, '
              f'rmw={get_rmw_implementation_identifier()}', flush=True)

    def publish_frame(self):
        """Publish one numbered frame. No input; returns None. The frame number is encoded in pixel 0."""
        message = Image()
        message.header.stamp = self.get_clock().now().to_msg()
        message.header.frame_id = 'video_peer'
        message.width = WIDTH
        message.height = HEIGHT
        message.encoding = ENCODING
        message.is_bigendian = 0
        message.step = self.step
        # A gradient keeps the encoder honest - a flat frame compresses to almost nothing - and the
        # first bytes carry the frame counter so a receiver can identify the frame it decoded.
        row = bytes((column + self.frame) % 256 for column in range(self.step))
        payload = bytearray(row * HEIGHT)
        payload[0] = self.frame % 256
        payload[1] = (self.frame // 256) % 256
        message.data = bytes(payload)
        self.images.publish(message)
        self.frame += 1

    def status(self):
        """Report progress at least every five seconds. No input; returns None."""
        print(f'independent ROS video peer published {self.frame} frames', flush=True)


def main():
    """Run until the configured deadline. No arguments; returns the process exit code."""
    rclpy.init()
    node = VideoPeer(os.environ.get('ROS_TEST_NAMESPACE', '/bridge_test'))
    deadline = time.monotonic() + float(os.environ.get('ROS_TEST_TIMEOUT_SECONDS', '360'))
    try:
        while time.monotonic() < deadline:
            rclpy.spin_once(node, timeout_sec=0.1)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
    return 0


if __name__ == '__main__':
    sys.exit(main())
