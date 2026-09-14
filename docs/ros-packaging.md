# ROS package化

## 目的と現状

このリポジトリはNode.js / TypeScriptアプリとしての直接実行に加え、ament package `ros_webrtc_bridge`としてbuild・install・起動できる。package versionは接続PoCを表す`0.0.0`であり、Debian/bloomによる公開releaseが完成したことは意味しない。

ROS packageの外装は次のfileで構成する。

- `package.xml`: package metadata、ament・Node・launch依存、動的ROS interface依存の責任境界。
- `CMakeLists.txt`: WebRTC transportとTypeScriptのbuild、CTest、runtime・依存・設定・launchのinstall。
- `scripts/ros_webrtc_bridge`: `ros2 run`からinstall済みES moduleを起動するwrapper。
- `launch/bridge.launch.py`: install済みconfigとentrypointを解決するlaunch file。
- `examples/*.yaml`: `share/ros_webrtc_bridge/examples`へinstallする設定例。

## buildとtest

Node.js 22とlockfileを使用する。rclnodejsのnative addonとmessage bindingは、対象ROS distroをsourceした環境で明示的に生成する。

```bash
source /opt/ros/<distro>/setup.bash
npm ci --ignore-scripts
npm rebuild rclnodejs --foreground-scripts
colcon build --packages-select ros_webrtc_bridge
colcon test --packages-select ros_webrtc_bridge
colcon test-result --verbose
```

colcon buildは`npm run prepare:transport`、`npm run build`の順で実行する。transport準備は選択・patch済みの同梱core 300 filesをhash・依存閉包・noticeと照合し、networkを使わずに生成する。upstream artifactのdownloadはmaintainerが明示実行する`vendor/werift-datachannel/refresh.mjs`だけに分離している。

隔離されたclean workspaceでCMakeにNode依存の準備も任せる場合は、事前にlockfileの全artifactをnpm cacheへ格納し、次を使用する。`ROS_WEBRTC_BRIDGE_RUN_NPM_INSTALL=ON`は`npm ci --ignore-scripts --offline --no-audit --no-fund`を実行し、cache不足時にnetworkへfallbackせず失敗する。

```bash
colcon build --packages-select ros_webrtc_bridge --cmake-args \
  -DROS_WEBRTC_BRIDGE_RUN_NPM_INSTALL=ON \
  -DROS_WEBRTC_BRIDGE_RUN_RCLNODEJS_REBUILD=ON
```

`ROS_WEBRTC_BRIDGE_INSTALL_NODE_MODULES`は既定`ON`で、buildに使ったrclnodejs native bindingを含む依存treeを通常fileとしてinstallする。依存内の補助scriptを`ros2 run`の公開実行名にしないため、source側の実行bitは引き継がない。release package側で同じmodule解決位置へruntime依存を供給する場合だけ`OFF`にできる。`ROS_WEBRTC_BRIDGE_RUN_NPM_TEST`は既定`ON`で、`colcon test`から既存のUnit/Contract/coverage判定とpackage静的契約を実行する。

## install layoutと起動

主なinstall先は次のとおり。

```text
lib/ros_webrtc_bridge/ros_webrtc_bridge
lib/ros_webrtc_bridge/dist/
lib/ros_webrtc_bridge/node_modules/
lib/ros_webrtc_bridge/vendor/
share/ros_webrtc_bridge/examples/
share/ros_webrtc_bridge/launch/
```

overlayをsourceし、秘密情報と権限をprocess environmentへ注入して起動する。値をshell historyへ残さない方法はdeployment環境で用意する。

```bash
source install/setup.bash
export BRIDGE_CONFIG="$(ros2 pkg prefix ros_webrtc_bridge)/share/ros_webrtc_bridge/examples/bridge.yaml"
export BRIDGE_CREDENTIAL="${DEPLOYMENT_BRIDGE_CREDENTIAL}"
export BRIDGE_TLS_KEY="${DEPLOYMENT_BRIDGE_TLS_KEY}"
export BRIDGE_TLS_CERT="${DEPLOYMENT_BRIDGE_TLS_CERT}"
export BRIDGE_SUBSCRIBE_TOPICS=/odom
export BRIDGE_PUBLISH_SCOPES=teleop
ros2 run ros_webrtc_bridge ros_webrtc_bridge
```

launchも同じ環境変数を継承する。secretをlaunch argumentへ渡さない。既定configはinstall済み`examples/bridge.yaml`、bind先はloopbackである。

```bash
ros2 launch ros_webrtc_bridge bridge.launch.py \
  config:=/absolute/path/to/bridge.yaml \
  host:=127.0.0.1 port:=7443 node_name:=ros_webrtc_gateway
```

ROS remap等は従来どおりJSON string arrayの`BRIDGE_ROS_ARGS`で渡す。wrapperへ追加したcommand-line argumentをROS引数として暗黙解釈しない。

## ROS interface依存

Gatewayが必要とするmessage packageは`bridge.yaml`の`ros_type`で決まるため、core packageだけでは列挙できない。設定を所有するdeployment packageが、利用する`std_msgs`、`geometry_msgs`、独自interface package等を`exec_depend`として宣言する。そのoverlayをsourceした状態で`npm rebuild rclnodejs --foreground-scripts`を実行し、bindingを生成する。

未導入またはbinding未生成の型は起動時の型解決で拒否する。型を部分的に公開したり、名前から型構造を推測するfallbackは行わない。同梱設定を使うpackage外装試験だけは、必要なinterface packageを`test_depend`として宣言する。

## 検証と未完了範囲

`npm run test:packaging`はHumbleまたはJazzy環境で隔離colcon workspaceを作り、discovery、offline build、CTest、install layout、`ros2 run`、`ros2 launch`、HTTPS health、秘密値の非同梱、未知interfaceのfail-fastを確認する。CIでは接続imageを`--network none`で起動する。接続E2Eでは同じcolcon install済みentrypointを使い、実Chromiumと独立rclpyの間で標準型と外部独自型を双方向に検証する。

この試験は独立rclpy、実Chromium、direct/TURN UDP試験を置き換えない。Debian/bloom公開は当面対象外である。ROS build farmそのものへは登録せず、GitHub Actionsのclean source・network遮断containerをbuild farm相当の再現試験とする。`node_modules`同梱はdistro・architecture固有のPoC方式であり、将来公開releaseを行う場合はruntime依存とlicense通知の作成方法を別途固定する。

transport自体のmaterializeは同梱local inputだけでoffline化済みである。一方、clean sourceからのNode依存導入には事前構築したnpm cacheが必要であり、ROS build farmへ依存artifactを供給する方式は未確定である。package外装smokeはroot/vendorの`node_modules`と`.runtime`、colconの`build` / `install` / `log`を除いたsourceを作り、CMake optionでoffline npm ci、rclnodejs rebuild、build/test/install/runを再構成する。事前構築したROS test imageを`docker run --network none`で起動してnetwork非依存を確認できる。
