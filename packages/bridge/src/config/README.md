# 起動設定モジュール

`parseBridgeConfig(yaml, options)`で[設定例](../../../../examples/bridge.yaml)を読み、凍結した`BridgeConfig`を返します。エラー時は位置と理由を含む`ConfigError`を投げ、設定を部分的に返しません。ROS entityを生成する処理は含みません。

`options.availableTypes`は型loaderが確認済みの`package/msg/Message`名の配列で、呼出側が明示します。CLIでは`app`と`ros`がbinding生成済み型を確認してregistryを構築し、`router`が認可済みcatalogを返します。ROS graphにpublisherがまだ存在しないことは拒否理由にしません。設定JSON Schemaの配布は未実装です。

`topics`のkeyがWeb公開名です。`ros_topic`省略時はkeyをROS接続先にし、明示時は別名として扱います。`options.resolveTopic`にROS adapterのremap・正規化処理を注入し、その出力を`rosTopic`として返します。省略時は名前をそのまま使います。Web名はremapで変更しません。

試作のWeb名・ROS名は、ASCIIの英字またはunderscoreで始まるsegmentを`/`で連結した絶対名、最大247文字に限定します。相対名、`~`、置換式は対象外です。ROS adapterはnative entity生成前にも対象RMWの検証を行う必要があります。

| 項目 | 契約 |
| --- | --- |
| YAML | 1.2 core、単一文書。重複key、alias、独自tag、未知fieldを拒否 |
| `maxConfigBytes` | `options`で上書き。既定1048576 UTF-8 bytes |
| `maxTopics` | `options`で上書き。既定256、少なくとも1 binding必須 |
| `limits` | 4項目すべて必須。正の安全整数。単一message上限は16384以下、peer queueとchannel bufferに収容可能 |
| `ros_qos` | 全項目必須。`keep_last`と正の`depth`を使用。DDS reliabilityとDC配送は独立 |
| 配送 | `realtime`は`latest / max_messages: 1`、`reliable`は有限件数の`fifo` |
| `max_rate_hz` | 必須。正の有限数、小数も可。rate制御自体は上位層が実装 |
| `command_guard` | 指定時は`required: true`、正整数`lease_ms`、Web→ROS、volatile、排他writerが必須 |
| 同一ROS出力 | remap後の名前で比較。型・QoS・access・guard・rate・配送・queueが異なるaliasを拒否 |

認可情報を省略してもpublish権限は付与しません。認証policy、process全体容量、transport合意上限、native callbackの滞留、実際のrate制御は上位層の責務です。設定を検証できることと、設定された制限を実行時にすべて強制できることは別です。

[設計書](../../../../docs/design.md)と[テスト方針](../../../../TESTS.md)を参照してください。
