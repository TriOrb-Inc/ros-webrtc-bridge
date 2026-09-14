from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.substitutions import FindPackageShare


PACKAGE_NAME = "ros_webrtc_bridge"


def generate_launch_description():
    """インストール済みbridge用のLaunchDescriptionを構築する。

    引数は取らず、config、host、port、node_nameをlaunch argumentとして宣言する。
    戻り値はbridge processを含むLaunchDescription。入力例は
    ``ros2 launch ros_webrtc_bridge bridge.launch.py host:=0.0.0.0``、
    出力例は指定した環境設定で起動するbridge processである。
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

    # BRIDGE_CREDENTIAL、BRIDGE_TLS_KEY、BRIDGE_TLS_CERT と権限 allowlist は
    # ros2 launch を呼ぶ環境から継承する。secret や環境固有 path を既定値へ置かない。
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
