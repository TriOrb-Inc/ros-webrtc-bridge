"""Independent ROS echo peer for performance tests. Round-trips Strings without interpreting payloads."""

import os
import time

import rclpy
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from std_msgs.msg import String


class PerformancePeer(Node):
    """Echo Strings over real DDS. Input: namespace; returns a ROS node."""

    def __init__(self, namespace):
        """Create bounded-depth publishers and subscriptions. Example input: '/bridge_performance'."""
        super().__init__('performance_peer', namespace=namespace)
        qos = QoSProfile(history=HistoryPolicy.KEEP_LAST, depth=256,
                         reliability=ReliabilityPolicy.RELIABLE,
                         durability=DurabilityPolicy.VOLATILE)
        # Echo only the received ROS String; share no bridge or codec implementation.
        self.publisher = self.create_publisher(String, 'output', qos)
        self.subscription = self.create_subscription(String, 'input', self.on_message, qos)
        self.received = 0
        self.create_timer(4.0, self.status)
        print('performance ROS peer ready', flush=True)

    def on_message(self, message):
        """Echo a String. Example input: data='opaque'; output: the same value on output."""
        self.received += 1
        self.publisher.publish(message)

    def status(self):
        """Report anonymized progress within five seconds. Input: timer; output: cumulative receive count."""
        print(f'performance peer active: received={self.received}', flush=True)


def main():
    """Spin until the monotonic deadline. Input: PERFORMANCE_PEER_TIMEOUT_SECONDS; output: termination."""
    timeout_seconds = float(os.environ.get('PERFORMANCE_PEER_TIMEOUT_SECONDS', '4000'))
    if not 1 <= timeout_seconds <= 86400:
        raise ValueError('PERFORMANCE_PEER_TIMEOUT_SECONDS must be within [1, 86400]')
    rclpy.init()
    node = PerformancePeer('/bridge_performance')
    deadline = time.monotonic() + timeout_seconds
    try:
        while rclpy.ok() and time.monotonic() < deadline:
            rclpy.spin_once(node, timeout_sec=0.25)
    except ExternalShutdownException:
        print('performance peer shutdown requested', flush=True)
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
