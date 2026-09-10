import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
