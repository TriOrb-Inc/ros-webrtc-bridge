from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.substitutions import FindPackageShare


PACKAGE_NAME = "ros_webrtc_bridge"


def generate_launch_description():
    """Build the LaunchDescription for the installed bridge.

    Takes no arguments; declares config, host, port, and node_name as launch arguments.
    Returns a LaunchDescription containing the bridge process. Example input:
    ``ros2 launch ros_webrtc_bridge bridge.launch.py host:=0.0.0.0``、
    The resulting bridge process starts with the specified environment settings.
    """
    package_share = FindPackageShare(PACKAGE_NAME)
    default_config = PathJoinSubstitution([package_share, "examples", "bridge.yaml"])
    installed_entrypoint = PathJoinSubstitution(
        [
            package_share,
            "..",
            "..",
            "lib",
            PACKAGE_NAME,
            "ros_webrtc_bridge",
        ]
    )

    # BRIDGE_CREDENTIAL, BRIDGE_TLS_KEY, BRIDGE_TLS_CERT, and permission allowlists
    # are inherited from the ros2 launch environment. Do not use secrets or deployment paths as defaults.
    return LaunchDescription(
        [
            DeclareLaunchArgument("config", default_value=default_config),
            DeclareLaunchArgument("host", default_value="127.0.0.1"),
            DeclareLaunchArgument("port", default_value="7443"),
            DeclareLaunchArgument("node_name", default_value="ros_webrtc_gateway"),
            ExecuteProcess(
                cmd=[installed_entrypoint],
                additional_env={
                    "BRIDGE_CONFIG": LaunchConfiguration("config"),
                    "BRIDGE_HOST": LaunchConfiguration("host"),
                    "BRIDGE_PORT": LaunchConfiguration("port"),
                    "BRIDGE_NODE_NAME": LaunchConfiguration("node_name"),
                },
                output="screen",
            ),
        ]
    )
