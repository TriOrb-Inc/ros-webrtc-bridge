# ROS JSON codecモジュール

## 目的・対象範囲

`ros-json-v1`のfield変換を、ROSやWebRTCに依存せず検証するためのモジュールです。`createCodec(descriptor, options)`が`encode(native: unknown)`と`decode(wire: unknown)`を返します。不正入力はpayloadを含まない`TypeError`で拒否します。

## 現状

呼び出し側が明示した`Field` descriptorでboolean、string、8/16/32/64bit整数、float32/64、uint8列、固定長・bounded配列、nested objectを変換します。descriptorは信頼できる開発者・型生成器が構築する内部APIです。長さ・整数width・深さ等の不変条件はfactoryで検証し、snapshotによって生成後の変更から隔離します。外部から任意のdescriptorを受け付けるAPIやJSON Schema validatorではありません。

ROSの型ロード・rclnodejs値の正規化は隣接`ros`、schema hashは`app`、wire envelopeは`router`、接続は`transport`が担当します。codecはこれらをimportしません。ブラウザSDKは未実装で、Nodeの`Buffer`を使う本codecをブラウザ対応済みとは扱いません。

```typescript
import { createCodec } from './index.js';

const codec = createCodec({ kind: 'object', fields: {
  counter: { kind: 'integer', bits: 64, signed: false },
  label: { kind: 'string', maxLength: 12 },
} });
codec.encode({ counter: 42n, label: '00123' }); // {counter:'42', label:'00123'}
codec.decode({ counter: '42', label: '00123' }); // {counter:42n, label:'00123'}
```

## 実装上の判断

- 64bit整数のnative値は`bigint`、wire値はcanonical decimal stringです。先頭`+`、先頭ゼロ、`-0`、空白、指数表記を拒否します。通常のstringは推論変換しません。
- 有限float32はIEEE 754 binary32へ丸め、丸めによるoverflowを拒否します。float64は有限numberをそのまま保持します。非有限floatのwire値は`"NaN"`、`"Infinity"`、`"-Infinity"`だけを受け付けます。JSON parse後の非有限numberも拒否します。commandの両方向変換では必ず`allowNonFinite: false`を渡します。
- stringの`maxLength`はUTF-8 byte数です。孤立surrogateを拒否し、多byte文字をUTF-16 code unit数で数えません。uint8列はnative側`Uint8Array`（Node `Buffer`を含む）、wire側はpadding付き標準base64です。URL-safe表現、空白、非canonical padding bitを拒否します。
- 配列の`length`は完全一致、`maxLength`は上限です。objectは全field必須で未知fieldを拒否します。class instance、symbol、非列挙property、getter/setter、配列hole・追加propertyを暗黙に無視しません。adapterはplain objectを渡す必要があります。
- 出力の配列・object・byte列は入力と独立して生成します。`__proto__`もown propertyとして扱い、prototypeの書き換えを起こしません。内部APIへ悪意あるProxy等の実行可能オブジェクトを注入することは対象外です。

| option | 既定値 | 単位・適用範囲 |
| --- | --- | --- |
| `maxDepth` | 32 | rootを0としたdescriptor/payloadの深さ |
| `maxNodes` | 32768 | descriptorまたは1回の変換で訪問するfield数。containerも1として数える |
| `maxArrayLength` | 4096 | 各通常配列の要素数 |
| `maxStringBytes` | 16384 | 各stringのUTF-8 bytes |
| `maxByteLength` | 16384 | 各uint8列の復号後bytes。復号前にも対応するbase64長を検査 |
| `allowNonFinite` | true | telemetry向け。commandにはfalseを指定 |

すべて`createCodec`の第2引数で上書きできます。数値上限は正のsafe integerです。schemaの長さ制約は0も許容します。schema上限とcodec上限の両方を満たす値だけを受理します。最大深さなどの設定値は呼び出し側で用途に合わせて制限し、巨大な上限によるメモリ・stack使用を許可しないでください。これらは個々のtreeの変換上限であり、envelope込みのUTF-8 byte上限やprocess全体のメモリ上限の代わりにはなりません。

## 目標・関連

Humble/Jazzyの独立nodeとのString/Twist契約を接続試験で検証しています。全ROS型・全bounded型のnative互換性は別途評価が必要です。schema IDの正規化・hash契約は`app`のREADMEを参照してください。

[設計書 §8](../../../../docs/design.md#8-ros型とserialization)と[テスト方針](../../../../TESTS.md)が上位仕様です。`tests/unit/codec/`はTYPE-01の単体範囲、descriptor検証、SEC-01のtree上限を扱います。encode/decodeは独立したgolden期待値で検証し、実ROS・browserでの互換性は別途確認します。
