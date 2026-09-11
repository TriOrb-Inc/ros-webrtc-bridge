# 起動と構成

`cli.main()` は環境設定、TLS、YAML を検証してから rclnodejs の専用 context、共有 ROS entity、command guard、peer ごとの router / WebRTC endpoint、HTTPS signaling を組み立てます。module の import だけでは起動しません。

```bash
node -e "import('./.runtime/build/packages/bridge/src/app/cli.js').then(m=>m.main())"
```

ROS 環境を source し、native addon と Werift core の生成を済ませて起動します。ROS の distro / domain / RMW は `ROS_DISTRO`、`ROS_DOMAIN_ID`、`RMW_IMPLEMENTATION` 等の標準環境を使います。CLI は `rclnodejs` を直接使用し、Python sidecar を必要としません。

ament/colconでinstallした場合は`ros2 run ros_webrtc_bridge ros_webrtc_bridge`、または`ros2 launch ros_webrtc_bridge bridge.launch.py`で同じ`cli.main()`を起動します。launch argumentは`config`、`host`、`port`、`node_name`だけです。credential、TLS鍵・証明書、Topic権限はlaunch argumentへ載せず、下記の環境変数から継承します。

| 環境変数 | 必須・既定値 | 用途 |
|---|---|---|
| `BRIDGE_CREDENTIAL` | 必須、32 文字以上 | 実行時に発行する単一 Bearer credential |
| `BRIDGE_CONFIG` | 必須 | bridge YAML の path |
| `BRIDGE_TLS_KEY` / `BRIDGE_TLS_CERT` | 必須 | PEM 秘密鍵 / 証明書の path |
| `BRIDGE_HOST` / `BRIDGE_PORT` | `127.0.0.1` / `7443` | HTTPS bind |
| `BRIDGE_SUBSCRIBE_TOPICS` | 空 | 読取りを許可する Web 公開名、comma 区切り |
| `BRIDGE_PUBLISH_SCOPES` | 空 | 許可する `access.publish_scope`、comma 区切り |
| `BRIDGE_NODE_NAME` | `ros_webrtc_gateway` | ROS node 名 |
| `BRIDGE_ROS_ARGS` | `[]` | ROS 引数の JSON string array。remap もここから渡す |
| `BRIDGE_SPIN_TIMEOUT_MS` | `10` | rclnodejs spin timeout |
| `BRIDGE_MAX_CONFIG_BYTES` | `1048576` | YAML 文書上限 |
| `BRIDGE_NEGOTIATION_TIMEOUT_MS` | `30000` | SDP / ICE / 3 DataChannel 確立と peer close の待機上限 |
| `BRIDGE_MAX_SDP_BYTES` | `262144` | signaling body と SDP の上限 |
| `BRIDGE_REQUEST_TIMEOUT_MS` | `10000` | HTTP body 読取り期限 |
| `BRIDGE_MAX_HANDLES` | `64` | peer ごとの stream / publisher handle 上限 |
| `BRIDGE_MAX_REQUESTS` | `64` | peer ごとの request cache / control queue 上限 |
| `BRIDGE_REQUEST_TTL_MS` | `30000` | request cache 寿命 |
| `BRIDGE_MAX_CONTROL_RATE_HZ` | `100` | peer ごとの control operation rate |

同時 peer、message bytes、queue、channel buffer は YAML の `limits` が正本です。guard の lease は binding の `command_guard.lease_ms` を使います。権限一覧が空ならその操作を許可しません。publish は明示した scope と binding の方向も照合します。単一 credential に対する固定権限の起動形態であり、JWT、多ユーザーごとの権限更新、credential 発行サービスは未実装です。

`BRIDGE_HOST` の未指定は loopback を選びます。明示した空文字は wildcard bind への意図しない拡大を防ぐため起動拒否します。

`GET /health` と認証付き `POST /offer` を提供します。gateway 自身の ICE servers は空で、host candidate を使用します。TURN はブラウザ側へ設定する検証構成です。SIGINT / SIGTERM では session を撤回し、peer、共有 ROS entity、HTTP socket を解放します。常駐中は 5 秒ごとに匿名の状態を表示します。

`registry.ts` は YAML の候補型を構文検証し、native loader で実在する型を全件解決して codec を構築します。schema ID は `sha256:` に、`{codec:'ros-json-v1',descriptor,allowNonFinite}` の canonical JSON を UTF-8 として hash した値を続けます。全 object key を JavaScript string の昇順に再帰整列し、array 順序は維持します。ROS type hash や公開 JSON Schema 文書とは別物です。command guard の有無による非有限値 policy の違いも ID に反映します。

unit は `tests/unit/app/` にあり、native facade と実 HTTPS socket で認証、所有権、lease 後の同期 publish、初期化・終了失敗を検証します。型の実在性、DDS、ブラウザ接続、TURN の成立は別途の接続試験が必要です。
