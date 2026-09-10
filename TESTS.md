# テスト方針

状態: Unit・結合試験、実ROS、実Chromium、direct / TURN UDPの接続試験を実装しています。Humble/Jazzyのarm64で検証済みです。PRのCIを実装しています。amd64、通信障害・性能測定等は未完了で、全ゲートの達成とは扱いません。現在の実行手順と範囲は§11に記載します。

共通開発規約とカバレッジ必須条件の正本は [CONTRIBUTING.md](CONTRIBUTING.md)、製品の契約は [docs/design.md](docs/design.md)、セキュリティ境界は [SECURITY.md](SECURITY.md) とします。本書は、それらをどの環境・観測・合格条件で検証するかを定めます。仕様を変更する場合は関連文書も同時に更新します。

## 1. 目的と保証範囲

優先順位は、未許可・失効済みcommandのROS publish防止、型とprotocolの互換性、有限な資源使用、接続性、性能の順です。コードの行数より、故障した場合の利用者への影響に応じて試験を厚くします。

- Topic Pub/Sub、設定、codec、adapter、session、SDK、signaling、transportを対象とします。
- Service、Action、Parameters、MediaTrack、ROS-to-ROS循環中継は初期版の試験対象外です。
- mockの成功は実ROSのQoS、native callback、DDS discovery、ブラウザ相互接続、NAT越えの証拠にはしません。
- `published_to_ros`はROS publish API成功だけを確認します。controller受信・処理完了、exactly-once、ロボットの停止時間は保証しません。
- command gateとwatchdogの実機試験は、対象controllerを含むシステムの検証として別に記録します。bridge単体の合格で代用しません。

## 2. 層ごとの役割

| 層 | 主な対象・方法 | 合格の観測 |
| --- | --- | --- |
| Unit | config/schema/codec、認可、lease、sequence、queue。clockと外部I/Oを注入 | 正常・異常・境界で、値・状態遷移・副作用回数が契約どおり |
| Contract | mock/実ROS adapter共通interface、wire protocol、SDK、catalog、エラー | 同じfixtureと期待値が各実装に適合。major/schema不一致を明示拒否 |
| 実ROS integration | rclnodejs、独立ROS node、QoS、entity寿命、独自message型 | ROS graphと実受信内容を観測。mockに置換しない |
| Browser E2E | 実browser、SDK、実PeerConnection、signaling、実ROS | 両方向の通信と再接続、認可、channel設定を境界越しに確認 |
| Network fault | 実transport、TURN、遅延・loss・帯域・切断の注入 | 選択ICE経路、drop、queue、失効後publish、復帰を観測 |
| Release / 性能 | 配布artifact、新規環境、長時間負荷、対応matrix | installから起動まで再現し、全必須ゲートと決定済みbudgetを満たす |

Unitは高速に多数の順序・境界を探索し、E2Eは主要な利用者経路と境界の接続を確認します。全組合せをE2Eへ重複実装しません。ただし認可・期限・資源解放はUnitだけで完了させません。

runnerはNode.js 22の`node:test`、coverageは`c8 12.0.0`を採用しています。TypeScript 5.9.3でsource mapを生成し、未importファイルと未実行分岐を含めて検査します。browser自動化は`playwright-core 1.63.0`を採用し、Chromium 153.0.8010.12で実WebRTCを検証しています。

## 3. Fixtureと独立した期待値

現在は`tests/unit/`、`tests/contracts/`、`tests/coverage/`、`tests/ros/`、`tests/browser/`、`tests/connection/`を使用します。network障害と性能専用directoryは後続の配置案です。

```text
packages/*/src/<module>/       # 実装と内部API文書
tests/unit/<module>/           # config / codec / session
tests/contracts/              # module結合。SDKは後続
tests/coverage/               # 計測設定の独立校正
tests/fixtures/               # 手で確認したwire値、config、型定義
tests/ros/                    # 独立ROS publisher/subscriberとintegration
tests/browser/                # browserから実ROSまでのE2E
tests/connection/             # Docker隔離・direct/TURN matrixと後始末
tests/network/                # TURN・障害注入・再接続
tests/performance/            # 固定workloadと集計
```

- `std_msgs/String`、`nav_msgs/Odometry`、`geometry_msgs/Twist`と、nested・bounded・固定長・64bit値を含む独自ROS interfaceを用意します。各fixtureは完全なROS messageとし、設計の省略例を流用しません。
- codecはROS型定義とwire仕様から独立に作成・レビューしたgolden vectorで、encodeとdecodeを別々に検証します。同じcodec同士の往復だけでは、対称な誤変換を検出できません。
- 実ROSの対向nodeは別processのrclpyまたはrclcppで作成し、bridgeのcodecを共有しません。ROS→WebはROS側の期待値から、Web→ROSは独立nodeの受信値から判定します。
- 文字列`"00123"`、整数の最小・最大と範囲外、空配列、UTF-8多byte、base64不正・復号後過大、非有限float、Time/Duration、欠落・未知fieldを含めます。
- schema hashは固定vectorで検証し、codec version・field変更で変化し、正規化上等価な入力では変化しないことを確認します。
- property-based試験を追加する場合もgolden vectorを残し、乱数seedと最小再現入力を保存します。snapshot更新は仕様差分のレビューを伴います。

## 4. 要件と受け入れ条件

以下は初期版の必須条件です。IDをtest名またはmetadataに含め、実装時に実行先へ対応付けます。未実装の行は「未実装」、環境不足は「未実施」と報告し、合格へ数えません。

| ID | 場面・注入する条件 | 合格条件 | 主な層 |
| --- | --- | --- | --- |
| CFG-01 | 不正Topic名、未導入/未対応型、矛盾QoS、正値必須の上限0/負値、command設定衝突 | 起動時に原因付きで拒否。中途半端なcatalog/entityを残さない。ROS graphにまだpublisherがないだけでは設定を拒否しない | Unit、実ROS |
| CFG-02 | `ros_topic`省略・明示、Web公開名の別名設定、設定外Topicの存在 | 省略時は`topics`のkeyをROS Topic名とWeb公開名に使い、明示時はkeyをWeb公開名、`ros_topic`をROS接続先に使う。catalogとSDKで同じ公開名を使い、設定外Topicは公開しない | Unit、Contract、実ROS |
| TYPE-01 | 全fixtureを双方向変換、境界外・未知fieldを入力 | golden値と一致。不正入力はROS publishせず拒否 | Unit、Contract、実ROS |
| PRO-01 | major/schema不一致、未知op、不正channel label/配送設定 | 接続または操作を明示拒否。許可前のデータを処理しない | Contract、Browser |
| PRO-02 | dataとcontrolの順序を逆転、readyを遅延 | handler登録・ready前に配信しない。ready後の新規sampleだけを配信 | Contract、Browser |
| PRO-03 | unsubscribe直後の遅着、重複request、旧handle、seq逆順 | tombstoneで遅着破棄。副作用を重複させずcache上限を維持。handleを再利用しない | Unit、Contract |
| AUTH-01 | 他robot/session、未許可alias、方向/型違い、catalog取得 | default deny。権限外metadataを公開せずROS publish回数0 | Unit、Browser |
| AUTH-02 | queueへ入れた後、publish前にACL撤回/token失効 | publish直前の再検証で拒否。撤回処理完了後の新規ROS publish回数0 | Unit、実ROS、Browser |
| CMD-01 | lease期限の直前・一致・直後に受信/queueから取り出し | `now >= expires_at`で失効し、一致・直後はpublish回数0。直前は他条件を満たす場合だけ許可 | Unit、Contract |
| CMD-02 | 再arm、再接続、gateway再起動、旧epoch/lease/seq、切断中操作 | 新sessionに旧commandを再送しない。古い権限を再利用せず、SDKは新しい入力から生成 | Unit、Browser、実ROS |
| CMD-03 | remap後に同じROS Topicへ到達する別aliasで同時arm | 正規化した出力Topic単位でwriterが1 session。旧所有者と別handleのlease流用を拒否 | Unit、実ROS |
| ACK-01 | ROS publish成功/失敗、controller未起動 | API成功時だけpublished_to_ros。controller完了として表示・判定しない | Contract、実ROS |
| QOS-01 | best_effort/reliableとvolatile/transient_local、互換/不一致 | 互換時の受信と不一致診断を区別。DataChannel設定でDDS欠落を回復したと扱わない | 実ROS |
| QOS-02 | latched sample、遅延subscribe、複数publisher、ROS再起動 | DDS historyとWeb配信を区別。Gatewayがready処理前に受信したsampleを自動再生しない。ready後にDDSから受信したsampleはsource publish時刻と無関係に配信対象。snapshotは最後の1sampleと年齢だけで、tf_static全状態保証にしない | 実ROS、Browser |
| SIZE-01 | envelope込みUTF-8 byte数が上限-1/上限/上限+1、対応sensor型の上限内message | `min(設定上限, 16KiB, 合意上限)`まで受理し、超過は明示拒否。sensor用途だけを理由に拒否せず、文字数で数えず断片化しない | Unit、Browser |
| FLOW-01 | 1 peerを停止、他peerは継続。reliable/realtimeを飽和 | reliableはslow_consumer停止、realtimeは最新値へ集約しdrop記録。他peerの進行を維持 | Unit、Browser、負荷 |
| FLOW-02 | ROS高rate、送信待ち、control flood、cache増加 | stream/peer/process/channel bufferとcacheを計上し上限内。ROS callbackを送信待ちでblockせずnative滞留も観測 | 実ROS、負荷 |
| NET-01 | direct/relay-only、TURN UDP/TCP/TLS、UDP遮断 | 選択candidate pairから実経路を確認。対応宣言する経路は接続・双方向通信・切断復帰に成功 | Browser、Network |
| LIFE-01 | subscribe/接続を反復、途中で例外・process終了 | 共有ROS entity数は設定数で一定。handle/listener/timer/bufferを解放し無期限増加しない | Unit、実ROS、負荷 |
| SEC-01 | 深いJSON、過大SDP/ICE/schema、認証失敗、ログ出力 | 境界で上限・timeoutを適用。payload/認証情報/接続情報を既定logへ出さない | Unit、Browser |
| SYS-01 | browser background/suspend、gateway crash、DDS/controller遅着 | 対象controllerのwatchdog/gateが規定どおり停止・遅着拒否。別途定めたシステム条件でのみ合格 | 実機・システム |

CMD-01は設計書のmonotonic clockによる期限境界を検証します。browserのwall clockでGatewayの期限判定を置き換えません。

拒否条件はエラー応答だけでなく、adapter spyのpublish回数0と独立ROS subscriberの両方で確認します。ROS側で「届かなかった」ことだけでは検出漏れの可能性があるため、matching済みobserver、試験前後の正常な対照sample、固有marker、観測windowを設定します。QoS不一致による未受信を拒否成功と判定しません。

認可・protocol・入力検証はSDKを通さないraw clientからも試験します。SDKが不正入力を防ぐことだけでGateway側の検証を証明しません。

## 5. 時刻・競合・障害の制御

- lease、request cache、rate、timeoutの境界はfake monotonic clockで試験します。tokenの絶対期限を扱うidentity validatorにはwall clockを別に注入し、期限判定を試験します。wall clockの前進・後退をlease判定へ影響させません。
- 受信時検証とpublish直前の間にbarrierを置き、ACL撤回、期限到達、切断、writer交代を意図的に発生させます。偶然の競合を待つ試験にしません。
- timerをfakeにしたUnitだけでは実event loopやbrowser throttlingを確認できないため、実timerのBrowser/実ROS試験を残します。
- 実timer試験は期限より十分内側/外側を使い、正確な境界一致はUnitで確認します。許容時間は測定環境に応じた設定値とし、期限切れcommandの受理を許容誤差へ含めません。
- 異なるchannelを意図的に遅延させるtransport harnessと実PeerConnectionの両方で、control/dataの順序に依存しないことを確認します。
- network障害は方向を明記し、loss 1%/5%、RTT 100/300ms、帯域制限、切断・復帰を設定化します。注入値と実測値を記録し、Unitのpacket破棄だけで実ネットワーク試験を代用しません。乱数seedだけではprocess schedulingやpacket順序まで再現できないため、適用方向と時系列も残します。
- TURNはrelay-onlyを強制する試験を含め、directへのfallbackを成功としません。接続成功だけではTURN利用の証拠にならないため選択candidate pairを収集します。

## 6. 環境の隔離と後始末

実ROS jobはDockerで独立起動し、job専用network、衝突しない`ROS_DOMAIN_ID`とTopic namespaceを持たせます。domain番号は有効範囲から排他的に割り当て、並列jobで固定値を共有しません。hostや他jobのROS graphへ試験node・Topic・messageが混入しないことを確認します。domain分離だけをセキュリティ境界にせず、DDS discoveryもjobのnetwork内へ限定します。

- ROS node、bridge、signaling、TURNはjob所有のprocessとして起動します。discoveryとready状態を確認してからsampleを送ります。
- port、browser profile、作業領域、証明書をjob単位に分離します。必要なcredentialは実行時に生成・注入し、リポジトリやartifactへ保存しません。
- 待機には個別timeoutとjob全体のdeadlineを設けます。固定sleepだけで成功を判断しません。
- 成否を問わずfinallyでbrowser、PeerConnection、ROS entity、child process、port、network impairmentを解放します。残留process/handleも失敗として検出します。
- impairmentは専用namespace内へ適用し、開発端末や共有runnerのネットワークを変更しません。
- stdoutは共通規約の5秒以内の進捗出力に従います。分割できない無出力工程は、開始前に理由・見込み時間を記録します。
- ローカルの一時出力は`.runtime/`へ置きます。CI artifactはcredential/payload/SDP/ICE情報を除去し、保存期間をjob設定で定めます。

## 7. カバレッジ

[共通規約](CONTRIBUTING.md#testing-rules)の **C0・C1とも100%必須** を継承します。C0はstatement、C1はbranchを対応指標とし、line率だけで代用しません。MC/DCは対象外です。

- 測定対象はbridge、SDK、signalingを含む自前の全runtime TypeScriptです。ROS adapter、起動処理、例外・終了経路を対象から外しません。現実装はbridgeのみで、`.c8rc.json`の対象は`packages/bridge/src/**/*.ts`です。新packageの追加と同時に対象を拡張してください。
- coverageのincludeで対象sourceを明示し、テストがimportしなかったファイルも0%として集計します。全体と各fileでC0/C1 100%を確認します。
- unit/contract/integration/browserの必要な計測結果を同じcommit・同じsourceに対応付けて統合します。Node/browser間の重複やsource mapの誤対応を確認します。
- M0で未実行branchを含む小さなfixtureを使い、TypeScriptへのsource map、未実行fileの検出、branch集計、複数jobのmergeを検証します。runnerの既定設定だけを信用しません。
- 外部依存、ROS/DDS/native library、生成物、型宣言、テスト/harnessはruntime TSの分母から除外します。除外一覧と理由をcoverage設定に記録し、生成元の自前runtime処理は除外しません。
- native/DDSはcoverage外でも実ROS試験が必要です。将来自前native codeを導入した場合は、その言語の測定方針を追加してから合格判定します。
- 外部境界のstubはUnitに利用できますが、stub実行による100%を実ROS/実transport対応の証拠にはしません。期待する副作用のassertionがない実行で数値だけを満たすことを禁止します。
- 到達不能codeは削除または設計を見直します。数値達成だけを目的としたignore、分母縮小、常時skipは認めません。必要な例外は共通規約の変更として先に合意・記録します。

カバレッジは受け入れ表の代替ではありません。100%でも要件が未検証なら合格とせず、実装追加PRでは未計測を達成済みとして扱いません。

## 8. CIと対応matrix

### 現在のPR workflow

[`.github/workflows/ci.yml`](.github/workflows/ci.yml)は`pull_request`の`opened`・`reopened`・`synchronize`で起動します。新しいcommitのpushは`synchronize`に対応します。base branch・変更pathによる絞り込みはせず、draft PRと文書だけの変更でも全jobを実行します。PR番号ごとのconcurrencyで古い実行をキャンセルし、最新変更を検証します。

- Unit job: Node 22.22.2、`npm ci --ignore-scripts`、transport生成、typecheck、Unit/Contractとファイル別C0/C1 100%、計測校正、実DataChannel試験。
- ROS job: Humble／Jazzyを別々のGitHub-hosted `ubuntu-24.04-arm` VMで実行。Dockerでdistroを分離し、独立native試験とChromiumのdirect / TURN UDPを検証。片方の失敗で他方の結果を省略しません。
- `contents: read`だけを付与し、checkout credentialを保持しません。CIで長期credentialを必要とせず、接続試験のcredential・TLS鍵はharnessが実行時生成します。PRのmerge commitをcheckoutしてbaseとの組合せを検証します。
- jobと長時間工程にtimeoutを設けます。通常終了・失敗時はharnessが資源を解放し、強制cancel時に残る資源はjob専用VMの破棄で回収します。

PRのChecksから各jobのログとJob Summaryを確認できます。coverage-summaryと匿名の接続結果をSummaryへ、credential生成前のDocker buildログをjobログへ明示したpathだけから出力します。`.runtime/`全体、秘密ファイル、Gateway/TURNのログは収集しません。結果生成前の失敗はSummaryに結果なしと表示し、jobログから診断します。生成済み結果だけでは全job成功と判定しません。

保存期間はリポジトリのActionsログ保持設定に従います。生coverageや接続結果のダウンロード用artifactは未実装です。必要な詳細結果は§11の同じコマンドで再現し、ローカル`.runtime/`から取得します。

このworkflowを含むPRから適用され、既存PRへ遡って自動追加されるものではありません。全PRへ共通適用するにはbase branchへmergeします。fork PRはGitHub側の実行承認設定、merge conflictがあるPRはGitHubの実行条件に従います。[PRイベントの条件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)

CIの自動実行と、失敗時にmergeを禁止するbranch protection / rulesetは別設定です。必須チェックの管理設定はこのworkflowでは変更しません。

### 後続のgateと対応目標

以下は現行PR workflowに追加する目標です。lint、障害注入、nightly、controller、releaseの全ゲートは未整備です。実装済み機能の必須jobが環境不足で動かなければ、その変更は未検証です。

| 実行契機 | 必須ゲート | 実行範囲 |
| --- | --- | --- |
| 実装PR | build/lint/typecheck、Unit/Contract、C0/C1 100%、Humble・Jazzy両基準環境の実ROSとChromium E2E | 関連する受入れID。runtime全体のcoverageが必要なjobは変更箇所にかかわらず実行 |
| 通信・認可・QoS・依存変更PR | 上記に加え、relay-only、該当競合/障害、影響する対応環境 | nightlyまで待たず、その変更のリスクを検証 |
| nightly | SYS-01以外のbridge受入れ条件、対応matrix、TURN経路、障害注入、反復解放、長時間負荷 | PRで絞った組合せを展開。失敗を翌日のrelease候補へ持ち越さない |
| controller併用例の実機試験 | SYS-01、controller固有のwatchdog/gate条件 | core nightlyとは別job。併用例のrelease前とcontroller契約変更時は必須 |
| release候補 | 候補commit・lockfile・配布artifactを固定した全必須試験、決定済み性能budget、clean install、依存/license確認 | 宣言する全環境・経路。artifactのhashを記録し、過去commitの成功を流用しない |

対応目標はROS 2 HumbleとJazzyです。PRとreleaseの基準環境はUbuntu 22.04 / ROS 2 Humble、およびUbuntu 24.04 / ROS 2 Jazzyの両方とし、Fast DDS / Linux amd64 / Chromiumを対応目標とします。現行PR CIは検証済みのarm64を基準とし、amd64は別途実測して追加します。各環境をDockerで再現し、Node、rclnodejs、RMW、transport、browserはM0で互換性を確認したversionへ固定します。現時点の対応済み宣言ではありません。

| 環境・軸 | 導入順序と昇格条件 |
| --- | --- |
| ROSなしmock / 固定Node version | M0から全PR。ROSなしで契約を再現 |
| Ubuntu 22.04 + Humble + Fast DDS + amd64 + Chromium | M0で双方向PoC、M1以降は基準PR job、release必須 |
| Ubuntu 24.04 + Jazzy + Fast DDS + amd64 + Chromium | M0で双方向PoC、M1以降は基準PR job、release必須 |
| Firefox / Playwright WebKit | M2までにBrowser E2Eを追加し対応範囲を明記。Playwrightのpatched Firefoxと製品版Firefox、WebKitと実Safariを区別。製品版対応は別途実機確認 |
| Linux arm64 | 現行PR CIの基準。Humble/Jazzyのbuild・実ROS・E2Eをnative runnerで実行。性能保証は別途評価 |
| Cyclone DDS / 追加ROS distro | 需要とrunner確保を条件に実ROS契約/QoS試験を追加。未実施のRMW/distroを対応表へ入れない |
| TURN UDP/TCP/TLS・UDP遮断 | M0はTURN成立を確認。M2は経路別結果を公開し、対応宣言した経路をrelease必須化 |

Humble・Jazzyの両基準環境は必須とし、追加軸の全直積は要求せず、基準環境から1軸ずつ変えるmatrixを使います。組合せ固有の不具合が出た場合はその組合せを追加します。M2の複数browser目標や候補CPUを絞る場合は、設計と対応表も変更します。

## 9. 性能・長時間試験

M0の測定から、M1開始前に暫定budget、M2 release候補の計測前に正式budgetを決めます。未確定の数値、未実行の経路をrelease合格として扱いません。閾値はconfigから変更可能にし、変更理由をレビューします。

- workloadは小〜中サイズのmessageを基準とし、message型/encode後byte数/rate、1・4 peer、配送方式、network条件、ROS QoSを固定します。サイズ上限近傍と過負荷も含めます。大容量sensorの転送性能や断片化は初期版の必須目標に加えません。
- CPU型・core数、RAM、OS、ROS/RMW、Node、browser、transport version、direct/relay、warm-up時間、計測時間、反復回数を結果に添えます。
- p50/p95/p99 latency、接続時間、CPU、RSS、event loop遅延、native callback滞留、queue byte数、bufferedAmount、drop/reject数を記録します。
- 片道latencyは時計同期と誤差を評価できる場合だけ使い、それ以外はRTTまたは同一clock内の区間時間で測定します。
- bounded queueのassertionとRSSの長時間傾向を分けます。GCによる変動を考慮し、application queueが上限内でもnative滞留が増えるなら不合格です。
- slow peerによる正常peerの劣化幅、control応答時間、最大RSS、反復接続後の資源増加、soak時間をbudgetへ含めます。
- baselineとの比較は同じworkload・環境で行います。単発の最良値や負荷条件の異なる値から性能向上を宣言しません。

## 10. 失敗・flaky・結果の扱い

最初の失敗を保存し、自動retryの成功で必須ゲートを緑にしません。retryは調査として別結果に記録します。seed、受入れID、commit、環境、timeout、期待値/実測値、機密情報を除いた診断を残します。

flaky testにはissue、担当、原因仮説、修正期限を付けます。隔離する場合もcoverageや必須受入れ条件から黙って外さず、同等の決定的な検証がなければ対応するreleaseゲートは未達です。認可・command期限・資源上限の失敗を許容済みとしてreleaseしません。

結果は「合格」「不合格」「skip」「未実装」「未実施」を区別します。skipにも理由を付け、必須条件の合格へ数えません。対応表、coverage対象と除外、受入れIDごとの結果、残るリスクを同じcommitに結び付けます。PR CIの結果保持と失敗時の確認手順は§8に記載します。

## 11. 実装順序と完了条件

1. **M0**: runner/計測の評価、独立ROS fixture、実browser双方向PoC、TURN、採用versionと基準環境の固定、暫定性能budgetを整備します。
2. **M1**: Unit/Contract、型vector、mock/実ROS adapter共通試験、基準E2E、coverage、queue/epoch、実装済み機能のPRゲートを有効化します。
3. **M2**: lease/ACL/再接続、複数browser、network障害、nightly負荷、artifact検証、controller併用例のシステム試験を追加し、初期版の必須IDを満たします。

各機能の実装PRで、その機能の正常・異常・境界試験と実行手順を追加します。「後の段階でテストする」を理由に実装済み機能の検証を省略しません。

現在のモジュール試作はROS不要で実行できます。Node.js 22（22.12以上、検証版22.22.2）、npm、lockfileの依存を使用します。build/typecheckの詳細は [CONTRIBUTING.md](CONTRIBUTING.md#local-checks)を参照してください。

```bash
npm ci --ignore-scripts
npm run prepare:transport
npm run typecheck
npm test
npm run test:coverage
npm run test:transport
```

`npm test`はbuild後、Unitとモジュール結合試験を実行し、自前runtime全ファイルそれぞれのstatement / branch / function / line 100%を必須とします。テストは個別10秒のtimeoutを持ち、通常は数秒以内に完了します。型宣言`.d.ts`、外部依存、生成JS、テスト/harnessは分母に含めません。weriftの生成物は外部実装として対象外ですが、`npm run test:transport`で固定patchを含む実DataChannel送受信を検証します。

`npm run test:coverage`は計測設定の校正です。隔離したTypeScript fixtureで、source map、未実行分岐、未importファイル、複数processの計測統合を確認します。意図的にcoverage不足にした子processの失敗をassertし、親testが成功すれば校正合格です。製品コードの閾値は下げません。子processのtimeoutは既定30秒で、`COVERAGE_CALIBRATION_TIMEOUT_MS`に正整数のmillisecondを指定して上書きできます。全体はその12倍で打ち切り、待機中は5秒ごとに進捗を出します。

| 現在の試験 | 対象IDの部分範囲 | 未検証の境界 |
| --- | --- | --- |
| `tests/unit/config/` | CFG-01/02、CMD-03の設定衝突 | native境界はROS試験 |
| `tests/unit/codec/` | TYPE-01、SEC-01のdescriptor/値/容量 | 全ROS型のnative互換性 |
| `tests/unit/session/`、`router/` | AUTH、CMD、FLOW、SIZE、LIFE、PROの状態・wire境界 | 負荷、native滞留、SDK |
| `tests/unit/ros/`、`app/` | descriptor、64bit/bytes、hash、起動/終了、実HTTPSと認証 | 多ユーザーidentity、全ROS型 |
| `tests/unit/transport/`、`signaling/` | 3channel属性、SDP/message容量、待機中取消、認証前拒否、peer解放 | 実ネットワーク障害 |
| `tests/contracts/module-flow.test.ts` | 設定→codec→guard→同期publish spy、codec→byte queue | 独立ROS観測は下記 |
| `tests/ros/native.test.ts` | String/Twist、連鎖remap、実entity・終了 | QoS不一致、全型、性能 |
| `tests/browser/`、`tests/connection/` | 実wire/String/Twist、CMD-01/02、ACK-01、NET-01 UDP、再接続 | TURN TCP/TLS、UDP遮断、長時間・controller |

Linux Docker hostで、次のコマンドにより両distroのdirect / TURN UDPを検証します。

```bash
npx playwright-core install chromium
npm run test:connection
```

環境の隔離、credential生成・削除、timeout、調査用のmatrix指定は[接続試験](tests/connection/README.md)、ROS単独試験は[ROS試験](tests/ros/README.md)を参照してください。検証済み構成はHumble/Ubuntu 22.04とJazzy/Ubuntu 24.04、Fast DDS、arm64、Node 22.22.2、rclnodejs 2.2.0の同梱prebuilt、Chromium 153.0.8010.12、coturn 4.6.3です。ブラウザSDKは未実装なのでraw clientを用います。

この範囲の成功は受け入れID全体の合格ではありません。QOS-01/02の不一致・latched履歴、NET-01のTCP/TLS・UDP遮断、SYS-01、性能・負荷、amd64は未検証または未実装です。ACK-01は実ROS observerまで確認しますが、controller完了を意味しません。§8の全必須ゲートとrelease条件の達成とは区別します。

buildは`.runtime/build/`、coverageは`.runtime/coverage/`へ出力します。`coverage-summary.json`でfile単位の割合、`coverage-final.json`と`lcov.info`でstatement/branch位置を確認できます。測定artifactと調査記録はGitへ含めません。ROS/browser/TURNの具体的な起動手順・timeout・後始末は、各harnessのREADMEを参照してください。

## 12. 採用評価の一次資料

- [Node.js test runner](https://nodejs.org/api/test.html): 採用runnerの実行・隔離・mock機能。
- [c8](https://github.com/bcoe/c8): `--all`による未load fileの計測とsource map対応。採用versionのinclude/excludeとthresholdを校正します。
- [Playwright browsers](https://playwright.dev/docs/browsers): 配布browserの種類と、製品版browserとの差を対応表へ反映します。
