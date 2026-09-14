"""Independent rclpy peer. Receives String/Twist and returns verifiable responses on separate topics."""

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
    """Handle ROS types through an independent library. Input: namespace; returns a node."""

    def __init__(self, namespace):
        """Create publishers and subscriptions. Example input: '/bridge_test'; returns a Peer instance."""
        super().__init__('independent_peer', namespace=namespace)
        qos = QoSProfile(history=HistoryPolicy.KEEP_LAST, depth=10,
                         reliability=ReliabilityPolicy.RELIABLE,
                         durability=DurabilityPolicy.VOLATILE)
        # Separate response and Twist-observation paths; do not share the bridge codec implementation.
        self.echo = self.create_publisher(String, 'out', qos)
        self.observed = self.create_publisher(String, 'observed', qos)
        self.custom_echo = self.create_publisher(BridgeFrame, 'custom_out', qos)
        self.create_subscription(String, 'in', self.on_string, qos)
        self.create_subscription(Twist, 'cmd_vel', self.on_twist, qos)
        self.create_subscription(BridgeFrame, 'custom_in', self.on_custom, qos)
        self.create_timer(4.0, self.status)
        print(f'independent ROS peer ready: rmw={get_rmw_implementation_identifier()}', flush=True)

    def on_string(self, message):
        """Independently echo a String. Example input: data='marker'; output: the same String on /out."""
        self.echo.publish(String(data=message.data))

    def on_twist(self, message):
        """Observe Twist fields individually. Example: linear.x=1; output: JSON String."""
        # Simple field access avoids sharing incorrect Gateway type conversions.
        values = {'linear': {'x': message.linear.x, 'y': message.linear.y, 'z': message.linear.z},
                  'angular': {'x': message.angular.x, 'y': message.angular.y, 'z': message.angular.z}}
        self.observed.publish(String(data=json.dumps(values, allow_nan=False)))

    def on_custom(self, message):
        """Independently echo an external BridgeFrame. Example input: maximum sequence value; output: /custom_out."""
        self.custom_echo.publish(message)

    def status(self):
        """Report progress within five seconds. Input: timer; output: peer subscription count."""
        print(f'peer active: echo observers={self.echo.get_subscription_count()} '
              f'twist observers={self.observed.get_subscription_count()} '
              f'custom observers={self.custom_echo.get_subscription_count()}', flush=True)


def main():
    """Run the ROS peer with a deadline. Input: environment variables; output: exit code or exception."""
    deadline_seconds = float(os.environ.get('ROS_TEST_TIMEOUT_SECONDS', '120'))
    if not 0 < deadline_seconds <= 3600:
        raise ValueError('ROS_TEST_TIMEOUT_SECONDS must be within (0, 3600]')
    rclpy.init()
    node = Peer(os.environ.get('ROS_TEST_NAMESPACE', '/bridge_test'))
    # Do not assume discovery after a fixed sleep; the Gateway waits for responses with a deadline.
    deadline = time.monotonic() + deadline_seconds
    try:
        while rclpy.ok() and time.monotonic() < deadline:
            rclpy.spin_once(node, timeout_sec=0.25)
        print('independent ROS peer deadline reached', flush=True)
    except ExternalShutdownException:
        # The rclpy SIGTERM handler shuts down the context first. Treat this as normal teardown.
        print('independent ROS peer shutdown requested', flush=True)
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
