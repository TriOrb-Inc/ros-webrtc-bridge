"""性能試験用の独立ROS echo peer。payloadを解釈せずStringを往復する。"""

import os
import time

import rclpy
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from std_msgs.msg import String


class PerformancePeer(Node):
    """実DDS上のStringをechoする。入力: namespace。出力: ROS node。"""

    def __init__(self, namespace):
        """有限depthのpublisher/subscriptionを作る。入力例: '/bridge_performance'。"""
        super().__init__('performance_peer', namespace=namespace)
        qos = QoSProfile(history=HistoryPolicy.KEEP_LAST, depth=256,
                         reliability=ReliabilityPolicy.RELIABLE,
                         durability=DurabilityPolicy.VOLATILE)
        # bridgeとcodecを共有せず、受信したROS Stringだけをそのまま返す。
        self.publisher = self.create_publisher(String, 'output', qos)
        self.subscription = self.create_subscription(String, 'input', self.on_message, qos)
        self.received = 0
        self.create_timer(4.0, self.status)
        print('performance ROS peer ready', flush=True)

    def on_message(self, message):
        """Stringをechoする。入力例: data='opaque'。出力: outputへ同じ値。"""
        self.received += 1
        self.publisher.publish(message)

    def status(self):
        """5秒以内に匿名進捗を出す。入力: timer。出力: 累積受信数。"""
        print(f'performance peer active: received={self.received}', flush=True)


def main():
    """単調deadlineまでspinする。入力: PERFORMANCE_PEER_TIMEOUT_SECONDS。出力: 終了。"""
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
