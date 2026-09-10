import { identifier } from '../session/validation.js';
import type { Channel, Wire } from './types.js';

export const CONTROL: Channel = 'ros.control.v1';

/** channelを照合する。入力例: ros.control.v1、出力例: true。@param value label @returns 対応可否 */
export function isChannel(value: string): value is Channel {
  return value === CONTROL || value === 'ros.reliable.v1' || value === 'ros.realtime.v1';
}

/** 配送設定をchannelへ写像する。入力例: realtime、出力例: ros.realtime.v1。@param delivery 配送 @returns label */
export function dataChannel(delivery: 'reliable' | 'realtime'): Channel {
  return delivery === 'reliable' ? 'ros.reliable.v1' : 'ros.realtime.v1';
}

/** UTF-8 envelopeを境界検証する。入力例: JSON bytes、出力例: object。@param bytes 入力 @param maxBytes byte上限 @returns wire */
export function parseWire(bytes: Uint8Array, maxBytes: number): Wire {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new Error('message_size');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_envelope');
  const wire = value as Wire;
  // 未知versionと識別子の型をdispatchより前に拒否する。
  if (wire.v !== 1 || typeof wire.op !== 'string') throw new Error('invalid_protocol');
  return wire;
}

/** 必須識別子を取得する。入力例: ({id:'r1'},'id')、出力例: r1。@param wire envelope @param key field @returns 検証済みstring */
export function textField(wire: Wire, key: string): string {
  const value = wire[key];
  identifier(value as string);
  return value as string;
}

/** operationごとの未知fieldを拒否する。入力例: (wire,['id'])、出力例: void。@param wire envelope @param fields 許可field @returns なし */
export function fields(wire: Wire, fields: readonly string[]): void {
  const allowed = new Set(['v', 'op', ...fields]);
  if (Object.keys(wire).some((key) => !allowed.has(key))) throw new Error('unknown_field');
}

/** 出力をUTF-8化しenvelope込みサイズを測定する。入力例: {v:1,op:'ack'}、出力例: bytes。@param wire response @param maxBytes 上限 @returns bytes */
export function encodeWire(wire: Wire, maxBytes: number): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(wire));
  if (bytes.byteLength > maxBytes) throw new Error('message_size');
  return bytes;
}
