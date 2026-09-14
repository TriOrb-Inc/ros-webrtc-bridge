# ROS package外装試験

## 目的

`ros_webrtc_bridge` のROS package外装を、npm moduleの単体試験や既存の接続試験とは別の層で検証します。対象はcolcon discovery/build/test、install layout、installed entrypoint、launch file、秘密値の非同梱、設定で決まるROS interface依存のfail-fastです。

## 実行範囲

`smoke.sh`はROS 2 HumbleまたはJazzy、OpenSSL、colcon、lockfileの全artifactを含むnpm cacheが準備済みのLinux環境で実行します。既存の`tests/ros/Dockerfile`から作るdistro別imageはonline build時にcacheを準備するため、container自体は`--network none`で実行できます。ROS graphは既定で`ROS_DOMAIN_ID=75`かつlocalhost限定にし、並列実行時は`PACKAGING_ROS_DOMAIN_ID`でjob固有値へ変更します。

```bash
source /opt/ros/${ROS_DISTRO}/setup.bash
bash tests/packaging/smoke.sh
```

network隔離を含む受け入れ確認は、先に通常のDocker buildでimageとnpm cacheを作った後に実行します。`npm ci --offline`はcache不足をnetwork accessへfallbackせず失敗します。

```bash
docker run --rm --init --network none \
  --env ROS_DOMAIN_ID=75 --env ROS_LOCALHOST_ONLY=1 \
  ros-webrtc-bridge-test:<distro> \
  bash -lc 'source "/opt/ros/${ROS_DISTRO}/setup.bash" && bash tests/packaging/smoke.sh'
```

試験は次を順番に確認します。

1. `package.xml`、ament依存、実行script、launch、同梱設定の静的契約。
2. rootとvendorの`node_modules` / `.runtime`、colconの`build` / `install` / `log`を含まないclean sourceの作成。
3. 隔離workspaceで、cache限定の`npm ci --offline`、rclnodejs rebuild、local transport materializeを含む`colcon build`と、`colcon test` / `colcon test-result`。
4. install済みament index、package metadata、launch、設定、`ros2 pkg executables`。
5. install済みの`ros2 run ros_webrtc_bridge ros_webrtc_bridge`からHTTPS healthがreadyになること。
6. install済みの`ros2 launch ros_webrtc_bridge bridge.launch.py`から同じhealthがreadyになること。
7. 未導入ROS interfaceを参照する一時設定が、起動完了やtimeoutにならずfail-fastすること。
8. package成果物と公開可能logに秘密鍵・実行時credentialが含まれないこと。

credentialと自己署名TLS鍵は`/tmp`の所有directoryへ実行時生成し、終了時に削除します。command引数、リポジトリ、CI artifactへ値を渡しません。診断logは`.runtime/packaging-<distro>-*`へ保存しますが、最後にcredential値との一致を検査します。

## CIへの組込み

Humble/Jazzyの既存ROS matrixで、接続試験が生成した各distro imageに対して本scriptを実行します。package外装試験の追加を理由に、既存の独立rclpy native試験、実Chromium direct/TURN UDP接続、Unit/ContractとC0/C1 100%を削除・skipしません。

`CMakeLists.txt`のCTestから`smoke.sh`を直接登録すると、script内の`colcon test`と再帰するため禁止します。CTestには既存のnpm試験を登録し、外装smokeはCIのROS jobから独立stepとして呼び出します。

## 合格の解釈

本試験の成功は、指定distroのsource checkoutからpackageをbuild/install/起動できることを示します。Debian/bloom配布やclean hostへのbinary installを保証しません。また、amd64、追加RMW、性能・長時間運用は接続・性能・CIの別試験層で判定し、本script単独の成功から対応済みとは扱いません。全体の実施状況と未検証範囲は`TESTS.md`で区別します。
