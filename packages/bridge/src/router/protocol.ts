import { identifier } from '../session/validation.js';
import type { Channel, Wire } from './types.js';

export const CONTROL: Channel = 'ros.control.v1';

/** Check a channel label. Example: ros.control.v1; returns whether it is supported. */
export function isChannel(value: string): value is Channel {
  return value === CONTROL || value === 'ros.reliable.v1' || value === 'ros.realtime.v1';
}

/** Map delivery settings to a channel label. Example: realtime returns ros.realtime.v1. */
export function dataChannel(delivery: 'reliable' | 'realtime'): Channel {
  return delivery === 'reliable' ? 'ros.reliable.v1' : 'ros.realtime.v1';
}

/** Validate a UTF-8 envelope at the boundary. Inputs: bytes and byte limit; returns a wire object. */
export function parseWire(bytes: Uint8Array, maxBytes: number): Wire {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new Error('message_size');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_envelope');
  const wire = value as Wire;
  // Reject unknown versions and invalid identifier types before dispatch.
  if (wire.v !== 1 || typeof wire.op !== 'string') throw new Error('invalid_protocol');
  return wire;
}

/** Get a required identifier. Inputs: envelope and field key, e.g. ({id:'r1'},'id'); returns a validated string. */
export function textField(wire: Wire, key: string): string {
  const value = wire[key];
  identifier(value as string);
  return value as string;
}

/** Reject unknown fields per operation. Inputs: wire envelope and allowed fields, e.g. (wire,['id']); returns void. */
export function fields(wire: Wire, fields: readonly string[]): void {
  const allowed = new Set(['v', 'op', ...fields]);
  if (Object.keys(wire).some((key) => !allowed.has(key))) throw new Error('unknown_field');
}

/** Encode output as UTF-8 and measure size including the envelope. Inputs: response and byte limit; returns bytes. */
export function encodeWire(wire: Wire, maxBytes: number): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(wire));
  if (bytes.byteLength > maxBytes) throw new Error('message_size');
  return bytes;
}
