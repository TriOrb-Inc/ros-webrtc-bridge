# ROS JSON codec module

## Purpose and scope

Validate `ros-json-v1` field conversion independently of ROS and WebRTC. `createCodec(descriptor, options)` returns `encode(native: unknown)` and `decode(wire: unknown)`. Invalid input throws a `TypeError` that does not include the payload.

## Current behavior

Explicit `Field` descriptors drive conversion of booleans, strings, 8/16/32/64-bit integers, float32/64, uint8 sequences, fixed/bounded arrays, and nested objects. Descriptors are internal APIs constructed by trusted developers or type generators. The factory validates length, integer-width, depth, and other invariants, then snapshots the descriptor to isolate subsequent changes. It is neither an API for accepting arbitrary external descriptors nor a JSON Schema validator.

The adjacent `ros` module handles ROS type loading and rclnodejs normalization, `app` handles schema hashes, `router` handles wire envelopes, and `transport` handles connections. The codec imports none of them. A browser SDK is unimplemented; this codec uses Node `Buffer` and is not claimed to support browsers.

```typescript
import { createCodec } from './index.js';

const codec = createCodec({ kind: 'object', fields: {
  counter: { kind: 'integer', bits: 64, signed: false },
  label: { kind: 'string', maxLength: 12 },
} });
codec.encode({ counter: 42n, label: '00123' }); // {counter:'42', label:'00123'}
codec.decode({ counter: '42', label: '00123' }); // {counter:42n, label:'00123'}
```

## Implementation decisions

- Native 64-bit integers are `bigint`; wire values are canonical decimal strings. Leading `+`, leading zeroes, `-0`, whitespace, and exponent notation are rejected. Ordinary strings are not inferred or converted.
- Finite float32 values are rounded to IEEE 754 binary32; overflow is rejected. Finite float64 numbers are preserved. Only `"NaN"`, `"Infinity"`, and `"-Infinity"` are accepted as non-finite wire values. Non-finite numbers resulting from JSON parsing are also rejected. Both command conversion directions must use `allowNonFinite: false`.
- String `maxLength` counts UTF-8 bytes. Lone surrogates are rejected; multibyte strings are not measured in UTF-16 code units. Native uint8 sequences are `Uint8Array` (including Node `Buffer`); wire values are padded standard base64. URL-safe encodings, whitespace, and noncanonical padding bits are rejected.
- Array `length` requires an exact match; `maxLength` sets an upper bound. All object fields are required and unknown fields are rejected. Class instances, symbols, non-enumerable properties, getters/setters, array holes, and extra array properties are not silently ignored. The adapter must supply plain objects.
- Output arrays, objects, and byte sequences are independent of the inputs. `__proto__` is treated as an own property without altering prototypes. Injecting executable objects such as malicious Proxies into this internal API is outside scope.

| Option | Default | Unit and scope |
| --- | --- | --- |
| `maxDepth` | 32 | Descriptor/payload depth, with the root at zero |
| `maxNodes` | 32768 | Fields visited in one descriptor or conversion; containers count as one |
| `maxArrayLength` | 4096 | Elements in each ordinary array |
| `maxStringBytes` | 16384 | UTF-8 bytes per string |
| `maxByteLength` | 16384 | Decoded bytes per uint8 sequence; the corresponding base64 length is also checked before decoding |
| `allowNonFinite` | true | For telemetry; set false for commands |

Override all options through the second argument to `createCodec`. Numeric limits must be positive safe integers; schema length constraints may be zero. Values must satisfy both schema and codec limits. Configure depth and similar limits for the application rather than permitting memory/stack exhaustion through oversized limits. These bound individual trees, not total envelope UTF-8 bytes or process-wide memory.

## Goals and related documentation

String/Twist contracts are verified by connection tests against independent Humble/Jazzy nodes. Native compatibility of all ROS and bounded types needs separate evaluation. See the `app` README for schema ID normalization and hashing.

The [design §8](../../../../docs/design.md#8-ros-types-and-serialization) and [test policy](../../../../TESTS.md) are the higher-level specifications. `tests/unit/codec/` covers TYPE-01 unit behavior, descriptor validation, and SEC-01 tree limits. Encode/decode are checked against independent golden values; real ROS/browser compatibility is verified separately.
