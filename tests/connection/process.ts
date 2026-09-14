import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Convert an optional environment value to finite positive milliseconds. Inputs: string/default/range; returns a timeout. */
export function parseTimeoutMs(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('timeout must be a positive integer in milliseconds');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`timeout must be between ${minimum} and ${maximum} milliseconds`);
  }
  return value;
}

/** Run an external stage with a finite deadline. Inputs: name/command/arguments/options; returns stdout. Never log arguments or environment values. */
export async function command(name: string, executable: string, args: string[], options: {
  directory: string; timeoutMs?: number; env?: NodeJS.ProcessEnv;
}): Promise<string> {
  console.log(`connection test: ${name}`);
  const heartbeat = setInterval(() => console.log(`connection test: ${name} running`), 4000);
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile(executable, args, { env: { ...process.env, ...options.env }, timeout: options.timeoutMs ?? 30000,
        maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        // Save only build output and normal diagnostics. Credentials are excluded from arguments and command output by design.
        writeFile(join(options.directory, `${name}.log`), stdout + stderr).then(() => {
          if (error) reject(new Error(`${name} failed; see local log`)); else resolve(stdout.trim());
        }, reject);
      });
    });
  } finally { clearInterval(heartbeat); }
}
