# 独立ROS試験

`Dockerfile`でROS distroごとの独立imageを作り、`native.test.ts`が別processのrclpy対向nodeと通信します。StringのUTF-8 echo、完全なTwistのfield値、native remap、正常teardownを確認します。bridgeのcodecをPythonへ共有しません。

Stringの送受信には`source→target`と`target→other`の2規則を指定し、設定の所有名とnative entityの実Topic名が一度解決した`target`で一致することを検証します。publisherとsubscriptionの両方で、誤って`other`へ再remapすると対向nodeと通信できない構成です。

```bash
docker build -f tests/ros/Dockerfile --build-arg ROS_IMAGE=ros:humble-ros-base-jammy -t ros-webrtc-bridge-test:humble .
docker build -f tests/ros/Dockerfile --build-arg ROS_IMAGE=ros:jazzy-ros-base-noble -t ros-webrtc-bridge-test:jazzy .
docker run --rm --network none -e ROS_LOCALHOST_ONLY=1 -e ROS_DOMAIN_ID=91 ros-webrtc-bridge-test:humble bash -lc 'source /opt/ros/humble/setup.bash && node --test /bridge/.runtime/build/tests/ros/native.test.js'
docker run --rm --network none -e ROS_LOCALHOST_ONLY=1 -e ROS_DOMAIN_ID=92 ros-webrtc-bridge-test:jazzy bash -lc 'source /opt/ros/jazzy/setup.bash && node --test /bridge/.runtime/build/tests/ros/native.test.js'
```

この実行例は外部network接続を持たないcontainer内で2processを動かすため、hostや他jobのROS graphへ混入しません。同じnetwork内で複数jobを起動する場合は、job固有networkと重複しないdomain番号を割り当てます。`ROS_LOCALHOST_ONLY`は両distroで共通利用できますが、Jazzyでは非推奨の通知が出ます。

Node 22.22.2とlockfileを使い、rclnodejsのinstall・型生成をROS環境内で実行します。対応するprebuilt native binaryがある場合はそれを利用し、ソースからnative addonをcompileしたという結果には数えません。

対向nodeは`ROS_TEST_NAMESPACE`（既定`/bridge_test`）配下のString `in`を`out`へechoし、Twist `cmd_vel`をString `observed`へJSON形式で通知します。`ROS_TEST_TIMEOUT_SECONDS`は既定120秒、最大3600秒です。native試験は対向node40秒、試験全体45秒、各応答15秒、終了待機2秒のdeadlineを持ちます。対向nodeは4秒ごとに状態を出し、試験はdiscoveryを固定sleepで成功扱いしません。

本試験の範囲はROS adapterと独立node間です。WebRTC・browser・TURN、QoS不一致、全ROS型、controllerのwatchdog、通信障害、CPU/RSS/latencyの性能評価は別の試験を必要とします。試験失敗・例外でもadapter contextと対向processを解放します。
