# 性能・長時間harness

このdirectoryのharnessは、既に `tests/ros/Dockerfile` で作成済みのDocker imageにあるcolcon install済みGatewayを、`ros2 run ros_webrtc_bridge ros_webrtc_bridge` で起動します。source treeのGatewayを直接起動しません。性能用の設定と独立rclpy echo peerだけをread-only mountします。

実Chromiumから reliable DataChannel、Gateway、実DDS、独立ROS peerを往復したString echoをblack-boxで測ります。ブラウザの同じ `performance.now()` で接続時間とRTTのp50/p95/p99/maxを計算するため、host/container間の時計同期を仮定しません。送信数、echo数、loss、reject、unexpected、失敗合計、実効throughputも記録します。Gateway container全体のCPUとRSSはhost側の `docker stats` で周期sampleします。

## 実行

Node.js 22、npm依存、Playwright Chromium、Docker、OpenSSL、および接続試験用imageが必要です。harnessはimageをbuild/pullせず、外向き通信のない専用Docker networkで実行します。既定imageは `ros-webrtc-bridge-test:jazzy-fastrtps` です。

```bash
npm ci --ignore-scripts
npm run prepare:transport
npx playwright-core install chromium
docker build -f tests/ros/Dockerfile \
  --build-arg ROS_IMAGE=ros:jazzy-ros-base-noble \
  --build-arg BRIDGE_RMW_IMPLEMENTATION=rmw_fastrtps_cpp \
  -t ros-webrtc-bridge-test:jazzy-fastrtps .
npm run build
node .runtime/build/tests/performance/run.js
```

長時間試験も同じharnessを使います。

```bash
PERFORMANCE_MODE=soak node .runtime/build/tests/performance/run.js
```

Docker container、network、Chromium、TLS鍵、一時credentialは各実行が所有し、成功・失敗のどちらでも有限時間で終了・削除します。秘密ファイルはOSの一時directoryに置き、`.runtime/`には匿名集計JSONだけをmode・時刻・random suffix別に保存します。JSONや標準出力にURL、container/image名、credential、SDP、ICE情報、生payload、生process logを残しません。

## 既定profile

正本は [`default.json`](default.json) です。`performance`は短いPR/手元測定、`soak`は1時間の長時間測定です。

| 値 | performance | soak |
| --- | ---: | ---: |
| peer数 | 1 | 1 |
| 各peerのrate | 10 msg/s | 10 msg/s |
| String data byte数 | 256 | 256 |
| warm-up | 3 s | 30 s |
| 計測時間 | 15 s | 3600 s |
| echo drain timeout | 10 s | 30 s |
| 全体deadline | 90 s | 3720 s |
| CPU/RSS sample間隔 | 1 s | 5 s |
| heartbeat | 4 s | 4 s |

`bridge.yaml`は最大4 peer、16 KiB message、reliable/volatile/keep-last depth 256、reliable DataChannel、direct接続を固定します。既定workloadは小〜中サイズのStringを対象にし、上限近傍・過負荷・TURNは別profile/configで意図を明示して実行します。

## 設定と環境変数

`PERFORMANCE_CONFIG`にJSONまたはYAMLを指定できます。文書は `version: 1` と `profiles` mapを持ち、選択profileの構造は `default.json` と同じです。未知field、範囲外、alias、全体deadline以下に収まらないwarm-up・計測・drainは開始前に拒否します。`PERFORMANCE_MODE`はprofile名を選びます。環境変数は選択後の値を上書きします。

| 環境変数 | 既定値 | 範囲・意味 |
| --- | --- | --- |
| `PERFORMANCE_CONFIG` | `tests/performance/default.json` | JSON/YAML設定path |
| `PERFORMANCE_MODE` | `performance` | profile名。`soak`も同梱 |
| `PERFORMANCE_IMAGE` | `ros-webrtc-bridge-test:jazzy-fastrtps` | colcon install済みimage |
| `PERFORMANCE_RMW_IMPLEMENTATION` | `rmw_fastrtps_cpp` | `rmw_fastrtps_cpp` / `rmw_cyclonedds_cpp` |
| `PERFORMANCE_PEERS` | profile値 | 1〜4 |
| `PERFORMANCE_RATE_HZ` | profile値 | 0.1〜500、各peer |
| `PERFORMANCE_PAYLOAD_BYTES` | profile値 | 64〜12000、ASCII String data byte数 |
| `PERFORMANCE_WARMUP_SECONDS` | profile値 | 0〜3600 |
| `PERFORMANCE_DURATION_SECONDS` | profile値 | 1〜86400 |
| `PERFORMANCE_DRAIN_TIMEOUT_SECONDS` | profile値 | 1〜300 |
| `PERFORMANCE_OVERALL_TIMEOUT_SECONDS` | profile値 | 10〜90000 |
| `PERFORMANCE_RESOURCE_SAMPLE_SECONDS` | profile値 | 0.25〜60 |
| `PERFORMANCE_HEARTBEAT_SECONDS` | profile値 | 1〜5 |
| `PERFORMANCE_MAX_LOSS` | 0 | safety invariant、非負整数 |
| `PERFORMANCE_MAX_REJECTS` | 0 | safety invariant、非負整数 |
| `PERFORMANCE_MAX_UNEXPECTED` | 0 | safety invariant、非負整数 |
| `PERFORMANCE_MAX_RSS_MIB` | 1024 | safety invariant |
| `PERFORMANCE_REQUIRE_NO_CRASH` | `1` | `0` / `1` |
| `PERFORMANCE_REQUIRE_NO_OOM` | `1` | `0` / `1` |
| `PERFORMANCE_REQUIRE_CLEANUP` | `1` | `0` / `1` |
| `PERFORMANCE_MAX_RTT_P99_MS` | 5000 | 暫定PoC budget |
| `PERFORMANCE_MAX_CONNECTION_P99_MS` | 30000 | 暫定PoC budget |
| `PERFORMANCE_MIN_THROUGHPUT_RATIO` | 0.5 | 実効throughput / 設定rate、0〜1 |
| `PERFORMANCE_MAX_RSS_GROWTH_MIB_PER_HOUR` | profile値（短時間16384、soak 512） | 暫定PoC budget、単調sampleの最小二乗傾き |

## gateの意味

`loss/reject/unexpected=0`、Gateway/peerのcrash・OOMなし、cleanup完了、RSS上限を安全invariantとして独立表示します。RSS傾きには2 sample以上かつ1秒以上の観測を必須とし、不足時は`null`と不合格を記録します。RTT、接続時間、throughput ratio、RSS傾きは、初期測定を始めるための意図的に緩い `provisional` PoC budgetです。M1開始前に同一workload・同一環境のbaselineから暫定値をレビューし、M2 release候補前に正式budgetへ更新します。

共有runnerの結果は回帰とinvariantのgateであり、絶対性能保証ではありません。CPU割当、他jobとの競合、architectureが違う結果を直接比較せず、単発の最良値を改善根拠にしません。JSONはCPU型/core数/RAM、OS、ROS/RMW、Node、Chromium、transport、workload、QoS、経路を併記します。

## 現在の未計測範囲

この初期harnessはdirect/reliable/String echoのCPU・RSS、接続時間、RTT、throughput、失敗を対象にします。event-loop遅延、native callback滞留、application queue byte数、DataChannel `bufferedAmount`、slow peerによる正常peerの劣化、control応答時間、反復接続後の資源増加、TURN、network impairment、大容量sensor/断片化はまだ計測しません。RSS傾きはcontainer全体の外部観測であり、native滞留の原因特定やleak証明には使えません。未計測項目をrelease合格として扱わないでください。
