import { createCodec, type Field } from '../codec/index.js';
import type { RosDefinition } from './types.js';

/** Generate a descriptor from rclnodejs type definitions. Inputs: 'std_msgs/msg/String',lookup; returns an object descriptor. */
export function descriptorFromRos(type: string, lookup: (type: string) => RosDefinition, maxDepth = 32): Field {
  if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) throw new TypeError('invalid_schema_depth');
  const active = new Set<string>();
  /** Resolve nested messages with bounded recursion. Inputs: type name,0; returns an object descriptor. */
  function message(name: string, depth: number): Field {
    if (depth > maxDepth || active.has(name)) throw new TypeError('recursive_ros_schema');
    active.add(name);
    const fields: Record<string, Field> = {};
    for (const field of lookup(name).fields) {
      if (Object.hasOwn(fields, field.name)) throw new TypeError('duplicate_ros_field');
      const info = field.type;
      // Convert explicit primitive/nested metadata from the type loader without inferring ROS types.
      let value = info.isPrimitiveType ? primitive(info.type, info.stringUpperBound) : message(`${info.pkgName}/msg/${info.type}`, depth + 1);
      if (info.isArray) {
        const bounds = info.isFixedSizeArray ? { length: info.arraySize! } : info.isUpperBound ? { maxLength: info.arraySize! } : {};
        value = info.type === 'uint8' ? { kind: 'bytes', ...bounds } : { kind: 'array', element: value, ...bounds };
      }
      Object.defineProperty(fields, field.name, { value, enumerable: true });
    }
    active.delete(name);
    return { kind: 'object', fields };
  }
  // Factory schema validation rejects invalid bounds and widths from the type generator before exposure.
  const descriptor = message(type, 0);
  createCodec(descriptor, { maxDepth });
  return descriptor;
}

/** Map ROS primitives exactly. Inputs: 'float64',null; returns {kind:'float',bits:64}. */
function primitive(type: string, upper: number | null): Field {
  if (type === 'bool') return { kind: 'boolean' };
  if (type === 'string') return upper === null ? { kind: 'string' } : { kind: 'string', maxLength: upper };
  if (type === 'float32' || type === 'float64') return { kind: 'float', bits: type === 'float32' ? 32 : 64 };
  // Expose only validated numeric types; do not guess mappings for byte, char, wstring, or similar types.
  const match = /^(u?)int(8|16|32|64)$/.exec(type);
  if (!match) throw new TypeError('unsupported_ros_primitive');
  return { kind: 'integer', signed: match[1] !== 'u', bits: Number(match[2]) as 8 | 16 | 32 | 64 };
}
