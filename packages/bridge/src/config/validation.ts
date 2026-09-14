/** Configuration error. Reports only the configuration location, without input values. */
export class ConfigError extends Error {
  /** Construct an error from location and reason. Returns Error. Example: ('topics', 'object required'). */
  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'ConfigError';
  }
}

/** Validate a map and allowed keys. Example: ({version: 1}, ['version'], '$') returns the map; invalid inputs throw. */
export function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  // Do not accept non-map YAML values or values inherited through prototypes as configuration.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(path, 'object required');
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new ConfigError(`${path}.${key}`, 'unknown field');
  }
  return value as Record<string, unknown>;
}

/** Validate a string. Example: ('/odom', /^\//, 'topic') returns '/odom'; mismatches throw. */
export function string(value: unknown, pattern: RegExp, path: string): string {
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) throw new ConfigError(path, 'invalid string');
  return value;
}

/** Validate a finite positive number. Example: (5, 'depth', true) returns 5. Integer mode requires safe integers. */
export function positive(value: unknown, path: string, integer: boolean): number {
  // Reject Infinity and NaN because they can make capacity, deadlines, or rates unbounded.
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(path, 'positive finite number required');
  }
  if (integer && !Number.isSafeInteger(value)) throw new ConfigError(path, 'safe integer required');
  return value;
}

/** Validate an enum. Example: ('latest', ['latest','fifo'], 'policy') returns 'latest'; mismatches throw. */
export function choice<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new ConfigError(path, 'unsupported value');
  return value as T;
}

/** Validate a boolean. Example: (true, 'exclusive_writer') returns true. Strings are not accepted. */
export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ConfigError(path, 'boolean required');
  return value;
}

/** Validate an absolute ROS name. Inputs: value and location. Example: ('/robot/odom','topic') returns '/robot/odom'. */
export function topicName(value: unknown, path: string): string {
  const name = string(value, /^(?:\/[A-Za-z_][A-Za-z0-9_]*)+$/, path);
  // Match the maximum fully qualified ROS name length to prevent failures only when creating native entities after remapping.
  if (name.length > 247) throw new ConfigError(path, 'topic name too long');
  return name;
}
