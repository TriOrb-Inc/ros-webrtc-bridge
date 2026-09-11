"""独立rclpy対向node。入力String/Twistを受け、検証可能な応答を別Topicへ返す。"""

import json
import os
import time

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node
from rclpy.executors import ExternalShutdownException
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from rclpy.utilities import get_rmw_implementation_identifier
from std_msgs.msg import String
from bridge_test_interfaces.msg import BridgeFrame


class Peer(Node):
    """ROS型を独立ライブラリで処理する。入力: namespace。出力: node。"""

    def __init__(self, namespace):
        """publisher/subscriptionを生成する。入力例: '/bridge_test'。出力: Peer instance。"""
        super().__init__('independent_peer', namespace=namespace)
        qos = QoSProfile(history=HistoryPolicy.KEEP_LAST, depth=10,
                         reliability=ReliabilityPolicy.RELIABLE,
                         durability=DurabilityPolicy.VOLATILE)
        # 応答経路とTwist観測経路を分け、bridgeのcodec実装は共有しない。
        self.echo = self.create_publisher(String, 'out', qos)
        self.observed = self.create_publisher(String, 'observed', qos)
        self.custom_echo = self.create_publisher(BridgeFrame, 'custom_out', qos)
        self.create_subscription(String, 'in', self.on_string, qos)
        self.create_subscription(Twist, 'cmd_vel', self.on_twist, qos)
        self.create_subscription(BridgeFrame, 'custom_in', self.on_custom, qos)
        self.create_timer(4.0, self.status)
        print(f'independent ROS peer ready: rmw={get_rmw_implementation_identifier()}', flush=True)

    def on_string(self, message):
        """Stringを独立にechoする。入力例: data='marker'。出力: /outへ同じString。"""
        self.echo.publish(String(data=message.data))

    def on_twist(self, message):
        """Twistをfield別に観測する。入力例: linear.x=1。出力: JSON String。"""
        # 単純なfield読み出しなのでgateway側の誤った型変換を共有しない。
        values = {'linear': {'x': message.linear.x, 'y': message.linear.y, 'z': message.linear.z},
                  'angular': {'x': message.angular.x, 'y': message.angular.y, 'z': message.angular.z}}
        self.observed.publish(String(data=json.dumps(values, allow_nan=False)))

    def on_custom(self, message):
        """外部BridgeFrameを独立にechoする。入力例: sequence最大値。出力: /custom_out。"""
        self.custom_echo.publish(message)

    def status(self):
        """進捗を5秒以内に出力する。入力: timer。出力: 対向subscription数。"""
        print(f'peer active: echo observers={self.echo.get_subscription_count()} '
              f'twist observers={self.observed.get_subscription_count()} '
              f'custom observers={self.custom_echo.get_subscription_count()}', flush=True)


def main():
    """期限付きでROS peerを実行する。入力: 環境変数。出力: 終了codeまたは例外。"""
    deadline_seconds = float(os.environ.get('ROS_TEST_TIMEOUT_SECONDS', '120'))
    if not 0 < deadline_seconds <= 3600:
        raise ValueError('ROS_TEST_TIMEOUT_SECONDS must be within (0, 3600]')
    rclpy.init()
    node = Peer(os.environ.get('ROS_TEST_NAMESPACE', '/bridge_test'))
    # 固定sleepでdiscoveryを仮定せず、gateway側が応答をdeadline付きで待つ。
    deadline = time.monotonic() + deadline_seconds
    try:
        while rclpy.ok() and time.monotonic() < deadline:
            rclpy.spin_once(node, timeout_sec=0.25)
        print('independent ROS peer deadline reached', flush=True)
    except ExternalShutdownException:
        # rclpyのSIGTERM handlerはcontextを先に終了する。正常teardownとして受け止める。
        print('independent ROS peer shutdown requested', flush=True)
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
