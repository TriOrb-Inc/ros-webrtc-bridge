/** 設定エラー。入力値を含めず、設定内の位置だけを返す。 */
export class ConfigError extends Error {
  /** エラーを構築する。引数は位置と理由、戻り値はError。例: ('topics', 'object required')。 */
  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'ConfigError';
  }
}

/** mapと許可keyを検証する。例: ({version: 1}, ['version'], '$') → 同じmap。不正値は例外。 */
export function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  // YAMLのmap以外やprototypeを介した値を設定として扱わない。
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(path, 'object required');
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new ConfigError(`${path}.${key}`, 'unknown field');
  }
  return value as Record<string, unknown>;
}

/** 文字列を検証する。例: ('/odom', /^\//, 'topic') → '/odom'。不一致は例外。 */
export function string(value: unknown, pattern: RegExp, path: string): string {
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) throw new ConfigError(path, 'invalid string');
  return value;
}

/** 正の有限数を検証する。例: (5, 'depth', true) → 5。整数指定時は安全整数に限定。 */
export function positive(value: unknown, path: string, integer: boolean): number {
  // InfinityやNaNも容量・期限・rateの無制限化につながるため拒否する。
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(path, 'positive finite number required');
  }
  if (integer && !Number.isSafeInteger(value)) throw new ConfigError(path, 'safe integer required');
  return value;
}

/** 列挙値を検証する。例: ('latest', ['latest','fifo'], 'policy') → 'latest'。不一致は例外。 */
export function choice<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new ConfigError(path, 'unsupported value');
  return value as T;
}

/** booleanを検証する。例: (true, 'exclusive_writer') → true。文字列は受理しない。 */
export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ConfigError(path, 'boolean required');
  return value;
}

/** 絶対ROS名を検証する。引数は入力と位置。例: ('/robot/odom','topic') → '/robot/odom'。 */
export function topicName(value: unknown, path: string): string {
  const name = string(value, /^(?:\/[A-Za-z_][A-Za-z0-9_]*)+$/, path);
  // ROS完全名の上限に揃え、remap後にnative生成だけが失敗する設定を避ける。
  if (name.length > 247) throw new ConfigError(path, 'topic name too long');
  return name;
}
