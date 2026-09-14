# Contributing

このファイルは、このリポジトリで作業する人間とエージェントの共通ルールです。コード変更、文書更新、依存追加、検証作業では、以下の規約を守ってください。共通規約に加え、ROS 2 / WebRTC DataChannel Bridge 固有の設計原則を定めます。

## Base Standard

- 共通規約の正本はこの `CONTRIBUTING.md` とします。
- `AGENTS.md` はエージェント向け補足です。
- 特定パッケージやディレクトリだけのローカル規約は、そのディレクトリの `AGENTS.md` や `README` に近接配置してください。
- 規約が衝突する場合は、より具体的なもの（対象ディレクトリの `AGENTS.md` / `README`）を、より一般的なもの（この `CONTRIBUTING.md`）より優先してください。

## Development Workflow

1. 変更に着手する前に、影響を受けるパッケージ、設定、文書、インターフェース、運用手順を整理してください。
2. 非自明な変更では、実装前に作業の分割方針、依存関係、主なリスク、必要な検証を明確にしてください。
3. 不具合修正や仕様追加では、可能であれば先に失敗する再現テストや期待動作の確認手段を用意してください。
4. 振る舞い、設定、API、UI などの外部インターフェースが変わる変更では、関連する `README` や `docs/` も同じ変更で更新してください。
5. 仕様や構想を書く文書では、「現状」と「目標」を曖昧に混ぜず、区別して記載してください。
6. 利用者・開発者に必要な採用理由、制約、注意点は、PR コメントだけで閉じず、公開文書やコードコメントへ残してください。移植経緯、調査ログ、作業上の覚書は `.runtime/` へ保存してください。
7. 探索、評価、チューニング対象のハイパーパラメータ（しきい値、重み、上限件数、guard 条件など）は、原則として config file または環境変数から実行時に上書きできるようにしてください。実験のたびに source 定数を書き換える運用は禁止し、既定値を source に残す場合でも override 手段と適用優先順位を文書へ残してください。

## Project-Specific Principles

このリポジトリは、設定駆動で ROS 2 Topic の Pub/Sub を WebRTC DataChannel に橋渡しする OSS です。現状は実ROSとブラウザを接続するPoC段階です。[設計検討書](docs/design.md)を読み、実装・検証した範囲、未実装機能、未実施の実機・性能検証を区別してください。

- Topic ごとの個別実装を増やす前に、宣言的な設定だけで機能追加できるか検討してください。設定の正本は `bridge.yaml` とし、設定 schema と公開 catalog を整合させる設計です。
- ROS adapter、型 schema / codec、session / 認可 / queue、WebRTC transport、signaling の責務を分離してください。
- mock adapter でもテストできる構成を維持し、rclnodejs adapter と mock adapter の公開 interface に差分を作らないでください。
- ROS QoS と DataChannel の配送設定は独立して検証してください。DataChannel の reliable 設定だけで ROS 側の欠落を回復できると扱わないでください。
- Topic、型、方向の権限は default deny とし、設定外の Topic や client 指定の任意 ROS 型を公開しないでください。
- ROS 型 schema に従い送受信の両方向で検証・変換し、通常の string を数値に推測変換しないでください。任意コード実行を許す mapping DSL は導入しないでください。
- peer ごとの queue、payload、送信 buffer、rate に上限を設け、ROS callback を WebRTC の送信待ちで block しないでください。
- 再接続時は新しい session / epoch とし、古い command を再送しないでください。command の lease / sequence / 所有権 / 型は ROS publish 直前にも検証してください。
- bridge の command 検証と controller 側の watchdog / 期限検証は別の責務です。publish の ack を controller での処理完了や exactly-once の保証として扱わないでください。
- 初期スコープは Topic Pub/Sub です。Service、Action、Parameters、MediaTrack 等を追加する場合は、先に設計と対象範囲を更新してください。
- 設定、DataChannel protocol、公開 schema、SDK の外部契約を変更する場合は、対応する設計文書、存在する schema / 設定例 / SDK 文書を同じ変更で更新してください。未作成の成果物は、実装時に追加してください。
- WebRTC transport は permissive license の `werift` を優先評価します。`node-datachannel` / `libdatachannel` は MPL-2.0 のため、後述のコピーレフト依存禁止方針では採用しません。依存の採用 version と推移的依存も確認してください。

## Local Checks

Node.js 22（22.12以上、検証版22.22.2）を使用します。依存はlockfileで固定しています。

```bash
npm ci --ignore-scripts
npm run prepare:transport
npm run build
npm run typecheck
npm run test:packaging:contract
npm run test:performance
```

buildは前回の`.runtime/build/`を削除してTypeScriptとsource mapを再生成します。`node_modules/`はnpm標準の解決先のためrootに置き、Gitから除外します。lintは未整備です。PR作成・再オープン・PRブランチへの追加pushで[CI](.github/workflows/ci.yml)を実行します。testコマンドと保証範囲は [TESTS.md](TESTS.md#11-実装順序と完了条件)を参照してください。

実行時依存は`yaml 2.9.0`（ISC）、`rclnodejs 2.2.0`（Apache-2.0）、HTTP文書用`swagger-ui-dist 5.32.15`（Apache-2.0）、[werift coreのlocal package](vendor/werift-datachannel/README.md)（MIT）です。`swagger-ui-dist`の推移依存`@scarf/scarf 1.4.0`もApache-2.0であり、標準の`npm ci --ignore-scripts`でinstall時telemetryを実行しない。Swagger UIは配布済みCSS/JavaScriptだけを読み込み、この補助packageをruntimeでimportしない。rclnodejsのinstall・型生成はROS環境で明示実行し、ROS不要のUnitではnativeをロードしません。[ref-napiの通知補完](vendor/rclnodejs-notices/README.md)も配布時に保持してください。

ROS package外装を変更する場合は、対象distroをsourceした環境で`npm rebuild rclnodejs --foreground-scripts`を実行した後、`colcon build`、`colcon test`、install済みの`ros2 run` / `ros2 launch`を確認します。Humble/Jazzyを隔離検証する`npm run test:packaging`の前提、CMake option、動的ROS interface依存は[ROS package化](docs/ros-packaging.md)を参照してください。

通常の`npm run prepare:transport`は同梱済みcoreだけを検証し、networkへ接続しません。上流artifactの再取得とprepared tree更新は依存更新を担当するmaintainerだけが`npm run refresh:transport`で明示実行し、license、notice、個別hash、依存閉包、patch前後hashを同じ変更でレビューしてください。性能・soakの設定値と上書き方法は[性能harness](tests/performance/README.md)を参照してください。

開発依存は`typescript 5.9.3`（Apache-2.0）、`@types/node 22.20.2`（MIT）、`c8 12.0.0`（ISC）、`playwright-core 1.63.0`（Apache-2.0）です。lockfileの推移依存はMIT、ISC、BSD、Apache-2.0、0BSD、Unlicense、[BlueOak-1.0.0](https://blueoakcouncil.org/license/1.0.0)等のpermissive licenseです。依存を配布物へ含める場合は各licenseの通知を同梱してください。

CIの外部Actionsは`actions/checkout`と`actions/setup-node`を使用し、versionとcommit SHAをworkflow内で固定します。本体MITとbundle内のpermissive licenseを確認した版を使い、更新時も推移依存・通知を再確認してください。

文書変更ではリンク先、記載したファイル・コマンドの実在、用語、設計との整合性を確認してください。Git 管理下では次の差分確認も実施してください。

```bash
git diff --check
git diff --stat
```

新規ファイルは未追跡のままだと `git diff` に出ないため、`git status --short` とファイル内容も確認してください。文書のみの変更は実行テストおよびコードカバレッジ測定の対象外です。

実装を追加する変更で、採用した構成に対応する build / lint コマンドをこの節へ、テストコマンドと環境条件を [TESTS.md](TESTS.md) へ記載してください。実 ROS、ブラウザ、TURN、通信障害を含む実施結果と未実施項目を報告してください。

## Temporary Files

- 開発・検証・デバッグのために生成する一時ファイル（実験用の出力、ログ、ビルド中間物、スクラッチ、検証用の生成物など）は、理由がない限りリポジトリ直下の `.runtime/` ディレクトリへ格納してください。
- `.runtime/` は version control 対象外とし、`.gitignore` で除外します。コミットすべき成果物を `.runtime/` に置かないでください。
- 公開する必要のない作業メモ、参照リポジトリの調査記録、移植元commit、作業経緯も `.runtime/` 配下で管理してください。READMEや公開仕様へ作業日誌を混在させないでください。
- `.runtime/` 自体はGitで配布されません。新しいcheckoutでは必要に応じて `mkdir -p .runtime` で作成してください。公開文書はその内容に依存させないでください。
- `.runtime/` 以外の場所に一時ファイルを置く必要がある場合（ツールが出力先を固定している等）は、その理由を PR や関連文書に残し、必要に応じて `.gitignore` へ追記してください。

## File Size Limits

- **1,000行超**: ファイル分割を推奨。
- **2,000行超**: ファイル分割を強く推奨。
- **4,000行超**: 余程の事情がない限りファイル分割必須。
- 判定は、コメントのみの行と空行を除いた実効行数で行う。inline comment 付きの code 行は code 行として数える。

## Directory Layout Limits

### Program file count per directory

対象は `.rs` / `.cpp` / `.hpp` / `.h` / `.cc` / `.cxx` / `.py` / `.ts` / `.tsx` 等の program source file。docs (`.md`)、subdirectory、設定 file (`Cargo.toml`, `CMakeLists.txt`, `package.json` 等) は count に含めません。

- **7 file 以上**: subdirectory 分類を推奨。関連する module を parent name の subdirectory にまとめる。
- **13 file 以上**: subdirectory 分類を強く推奨。
- **25 file 以上**: 余程の事情がない限り subdirectory 分類必須。

### Subdirectory の使い方

- parent module を分割する場合は **parent 名の subdirectory** を作り、sub-module を配下に集約する。
  - Rust 例: `foo.rs` の分割 → `foo/bar.rs`, `foo/baz.rs`（Option A: parent `.rs` + subdirectory）、または `foo/mod.rs`（Option B）
  - C++ 例: `foo.cpp` の分割 → `foo/bar.cpp`, `foo/baz.cpp`
- **package の source root (`src/`) への flat 配置は避ける**。
- sidecar `.md` は対応する source と同一 directory に隣接配置する。subdirectory 内でも同様に扱う。

## Implementation Quality Rules

- 関数とファイルは、責務が追いやすい大きさに保ち、長大化した場合は分割を検討してください。
- 深いネストを増やしすぎず、早期 return やヘルパー関数抽出で読みやすさを保ってください。
- 外部入力や失敗しうる処理では、異常時の扱いを明確にし、無言で失敗を握りつぶさないでください。
- 使う側が誤解しやすい前提、単位、タイミング制約、所有権の扱いは、コード上で読み取れる形にしてください。

## Standard Output Rules

- この節の標準出力規約は、常駐 process、CLI、utility、test、評価 script、検証 script を含む、リポジトリ内の全プログラムを対象としてください。
- 既存の program / script へ本節の規約を適用する改修は、その file に機能修正、bug 修正、refactor、検証追加など何らかの変更を加えるタイミングで同時に行ってください。標準出力規約だけを理由に repo 全体へ一括改修を入れることは必須ではありません。
- 実行開始後は、標準出力へ少なくとも `5` 秒に `1` 回は進捗または状態を示す message を出力してください。
- `5` 秒以内に標準出力を出せない工程が原理的に存在する場合は、その工程へ入る直前に、処理内容、無出力になりうる理由、予想待機時間を注記として標準出力へ出してください。
- 前項の注記なしに `10` 秒以上標準出力が止まった場合は、異常として扱ってください。監視側の wrapper だけに頼らず、可能な限り program 自身が timeout または stuck と判断して error 終了できる構造にしてください。
- 外部 command 待ち、service 応答待ち、polling loop、長時間の初期化などの待機は細かい timeout 付きの待機へ分解し、各区間の状態を標準出力へ出してください。
- 待機工程を分割できる場合は、無期限待ちを禁止します。各待機へ timeout を組み込み、timeout 超過時は原因が追える message を標準出力へ出したうえで error 終了してください。

## Input Validation And Security Rules

- ファイル入力、環境変数、ネットワーク越しの値、UI 入力、外部ライブラリから受け取る値は、境界で妥当性を確認してください。
- `nullptr`、範囲外の値、列挙値の不整合、存在しない path、空文字、異常に大きな payload などは、必要に応じて明示的に弾いてください。
- user-facing な error では過剰な内部情報を漏らさず、開発者向け log には原因追跡に必要な文脈を残してください。
- API key、token、password、秘密鍵などの secret をハードコードしないでください。設定が必要な場合は環境変数や安全な設定手段を使ってください。

## Comment Rules

- コメントは十分に書いてください。関数の説明コメントは必須です。
- 関数の説明には、少なくとも機能概要、引数、戻り値、期待される入力例、期待される出力例を含めてください。
- 各処理ブロックには、その目的や意図を説明するコメントを付けてください。
- コメントでは、コードを見れば分かる内容の言い換えだけでなく、なぜその処理が必要か、前提条件、失敗時の扱い、単位や所有権などの背景を優先して説明してください。
- 処理的に意味のある行が、説明コメントなしで 5 行以上連続することを禁止します。
- program file 内の説明コメント、doc comment、docstring、JSDoc は原則として日本語で記述してください。
- ただし、`SPDX-License-Identifier`、外部仕様の正式名、識別子、protocol 名、型名、API 名、log message に埋め込む固定英語句など、日本語化するとかえって誤解を招くものは必要最小限で英語を残して構いません。

## Testing Rules

共通の品質基準は本節を正本とし、テストの層、受け入れ条件、測定方法、CI / release gate は [TESTS.md](TESTS.md) を正本とします。機能の仕様は [docs/design.md](docs/design.md) へ記載し、テスト文書だけで仕様を変更しないでください。

- 使用言語と既存構成に合わせて、適切な自動テスト基盤を選んでください。
- 新規実装や修正では、可能な限り関数単位または機能単位で正常系、異常系、境界値を含むテストパターンを用意してください。
- 不具合修正では、可能な限り再現条件を固定できるテストや検証手順を追加してください。
- 先に期待動作を明確にできる変更では、テストを先に書く進め方を推奨します。
- 実装コードの合格基準として、`C0` カバレッジおよび `C1` カバレッジは `100%` を必須としてください。文書のみの変更は対象外です。実装時に測定ツール、対象範囲、除外理由を明記し、未計測を達成済みとして扱わないでください。
- `MC/DC` カバレッジは、このリポジトリでは評価不要とします。

## License And Dependency Rules

- `GPL`、`LGPL`、`AGPL`、`MPL-2.0` などのコピーレフトライセンス依存は導入しないでください。直接依存だけでなく、推移的依存と配布物も確認してください。
- 新規依存は、原則として `Apache-2.0`、`MIT`、`BSD` などの permissive license を選んでください。
- ライセンスが不明な依存は導入せず、確認が取れるまで保留にしてください。
- 新しい依存を追加する場合は、選定理由、ライセンス、セキュリティ面や運用面への影響を PR や関連文書で説明できる状態にしてください。

## Documentation

- 日本語で文書、PR 本文、説明文、レビューコメントを書く場合、用語集（`docs/terminology.md` 等）があれば、まず参照し推奨表現を優先してください。
- `C++`、`Rust`、`TypeScript` の program file で、`Rust` / `TypeScript` は単体 300 行以上、`C++` は同一ディレクトリ同名 stem の `cpp` / `hpp` / `h` / `cc` / `cxx` 合算 300 行以上の場合、同じ場所に隣接する sidecar `*.md` を必須としてください。
- sidecar `*.md` には、少なくとも `目的`、`対象範囲`、`現状`、`実装上の判断`、`目標`、`関連` を記載し、source 単体では追いにくい責務とモジュール境界を説明してください。
- 既存の sidecar `*.md` を持つ program file を更新した場合は、同じ変更で対応する `*.md` も更新してください。
- sidecar `*.md` に図を含める場合は、1 file 内で完結できる `mermaid`、HTML 埋め込み `svg`、HTML 埋め込み base64 のみを使用してください。
- 仕様や構想を書く Markdown では、「現状」と「目標」を曖昧に混ぜずに区別してください。
- 外部インターフェースや UI の仕様を変更した場合は、関連する README も合わせて更新してください。
- 公開仕様の理解・保守に必要な設計上の前提、制約、運用上の注意は、既存の `docs/` や関連 `README` へ残してください。調査過程や作業経緯は `.runtime/` に分離してください。
- GitHub Pull Request を作成または更新する場合、特に明示がない限り、PR の概要本文は日本語で記載してください。
- 新しいトップレベル文書やディレクトリを追加する前に、既存の配置先で表現できないかを確認してください。
