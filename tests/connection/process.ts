import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 任意の環境変数を有限の正整数millisecondsへ変換する。入力文字列/既定値/範囲、出力timeout。 */
export function parseTimeoutMs(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('timeout must be a positive integer in milliseconds');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`timeout must be between ${minimum} and ${maximum} milliseconds`);
  }
  return value;
}

/** 外部工程を有限時間で実行する。入力名/command/引数/options、出力stdout。引数や環境値はlogしない。 */
export async function command(name: string, executable: string, args: string[], options: {
  directory: string; timeoutMs?: number; env?: NodeJS.ProcessEnv;
}): Promise<string> {
  console.log(`connection test: ${name}`);
  const heartbeat = setInterval(() => console.log(`connection test: ${name} running`), 4000);
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile(executable, args, { env: { ...process.env, ...options.env }, timeout: options.timeoutMs ?? 30000,
        maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        // build/正常診断だけを保存する。credentialはargsやcommand出力へ含めない設計。
        writeFile(join(options.directory, `${name}.log`), stdout + stderr).then(() => {
          if (error) reject(new Error(`${name} failed; see local log`)); else resolve(stdout.trim());
        }, reject);
      });
    });
  } finally { clearInterval(heartbeat); }
}
