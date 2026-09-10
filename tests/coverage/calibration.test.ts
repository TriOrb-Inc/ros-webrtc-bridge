import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// rootで実行し、校正の全生成物をGit除外された独立directoryへ置く。
const root = process.cwd();
const childTimeout = Number(process.env.COVERAGE_CALIBRATION_TIMEOUT_MS ?? 30000);
const c8 = join(root, 'node_modules/c8/bin/c8.js');
const tsc = join(root, 'node_modules/typescript/bin/tsc');

/** childを期限付きで実行する。引数はcwd/名前/Node引数/環境、戻り値はexit code。例: tsc成功 → 0。 */
async function run(cwd: string, name: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<number> {
  console.log(`coverage calibration: ${name}`);
  const heartbeat = setInterval(() => console.log(`coverage calibration: ${name} running`), 5000);
  const env: NodeJS.ProcessEnv = { ...process.env, CALIBRATION_MODE: 'full', ...extra };
  // 親testの内部状態を継承するとchildのnode:testが再帰実行と判定してskipする。
  delete env.NODE_TEST_CONTEXT;
  // 親のcoverageを混入させず、明示したjobだけV8データを記録する。
  if (extra.NODE_V8_COVERAGE === undefined) delete env.NODE_V8_COVERAGE;
  try {
    return await new Promise<number>((accept, reject) => {
      execFile(process.execPath, args, { cwd, env, timeout: childTimeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        // timeoutやsignalを、期待するcoverage未達のexit 1と混同しない。
        const result = error === null ? 0 : typeof error.code === 'number' && !error.killed && !error.signal ? error.code : undefined;
        writeFile(join(cwd, `${name}.log`), stdout + stderr).then(() => {
          if (result === undefined) reject(error);
          else accept(result);
        }, reject);
      });
    });
  } finally {
    clearInterval(heartbeat);
  }
}

interface Metrics { statements: { pct: number }; branches: { pct: number } }

/** c8のsource map後の集計を読む。引数はreport directory、戻り値はsource別結果。例: branch.tsの枝率50。 */
async function summary(directory: string): Promise<Record<string, Metrics>> {
  return JSON.parse(await readFile(join(directory, 'coverage-summary.json'), 'utf8')) as Record<string, Metrics>;
}

test('coverage calibration: source map、未import、branch gate、2job merge', { timeout: childTimeout * 12 }, async () => {
  assert.ok(Number.isSafeInteger(childTimeout) && childTimeout > 0, 'positive child timeout required');
  await mkdir(join(root, '.runtime'), { recursive: true });
  const cwd = await mkdtemp(join(root, '.runtime/coverage-calibration-'));
  console.log(`coverage calibration artifacts: ${cwd}`);
  // 実際の設定を複写する。include/excludeやthresholdを校正専用の緩い値へ変更しない。
  await copyFile(join(root, '.c8rc.json'), join(cwd, '.c8rc.json'));
  await copyFile(join(root, 'tsconfig.json'), join(cwd, 'tsconfig.json'));
  const config = JSON.parse(await readFile(join(cwd, '.c8rc.json'), 'utf8'));
  const tsconfig = JSON.parse(await readFile(join(cwd, 'tsconfig.json'), 'utf8'));
  // 必須分母・file単位の設定が外された場合も、この試験を成功させない。
  assert.equal(config.all, true);
  assert.equal(config['check-coverage'], true);
  assert.equal(config['per-file'], true);
  // statementとbranchの閾値を別々に必須化し、line率だけの合格を防ぐ。
  assert.equal(config.statements, 100);
  assert.equal(config.branches, 100);
  // sourceの配置も本体includeと同じにして、未import検出を実際の設定で確認する。
  const source = join(cwd, 'packages/bridge/src/calibration');
  await mkdir(source, { recursive: true });
  await mkdir(join(cwd, 'tests'), { recursive: true });
  await writeFile(join(cwd, 'package.json'), '{"private":true,"type":"module"}\n');
  // 同一行のternaryにより、statement 100%でもbranch未達になるfixtureを作る。
  await writeFile(join(source, 'branch.ts'), '/** 符号を返す校正fixture。 */\nexport function sign(value: number): number { return value > 0 ? 1 : -1; }\n');
  await writeFile(join(source, 'types.d.ts'), '/** 純型宣言はruntime分母へ含めない。 */\nexport interface Marker { value: number }\n');
  await writeFile(join(cwd, 'tests/driver.ts'), [
    "import assert from 'node:assert/strict';", "import { test } from 'node:test';",
    "import { sign } from '../packages/bridge/src/calibration/branch.js';",
    '// 各jobは独立の期待値で片側または両側を実行する。',
    "test('sign fixture', () => {",
    "  if (process.env.CALIBRATION_MODE !== 'negative') assert.equal(sign(1), 1);",
    "  if (process.env.CALIBRATION_MODE !== 'positive') assert.equal(sign(-1), -1);",
    '});', '',
  ].join('\n'));
  // rootのoutDirに追従し、root本体のbuild先は一切書き換えない。
  const output = resolve(cwd, tsconfig.compilerOptions.outDir);
  assert.ok(output.startsWith(`${cwd}/`), 'isolated outDir required');
  const driver = join(output, 'tests/driver.js');
  assert.equal(await run(cwd, 'compile', [tsc, '-p', 'tsconfig.json']), 0);

  // ① 両分岐が通れば100%。JSではなく元TSが集計keyとなることも検証する。
  const full = join(cwd, 'reports/full');
  assert.equal(await run(cwd, 'full', [c8, '--reports-dir', full, 'node', '--test', driver]), 0);
  const covered = await summary(full);
  assert.equal(covered[join(source, 'branch.ts')]!.statements.pct, 100);
  assert.equal(covered[join(source, 'branch.ts')]!.branches.pct, 100);
  assert.deepEqual(Object.keys(covered).sort(), ['total', join(source, 'branch.ts')].sort());

  // ② statementだけ100%でも片側branchの未達によりchildは失敗する。
  const partial = join(cwd, 'reports/partial');
  assert.equal(await run(cwd, 'partial', [c8, '--reports-dir', partial, 'node', '--test', driver], { CALIBRATION_MODE: 'positive' }), 1);
  const incomplete = (await summary(partial))[join(source, 'branch.ts')]!;
  assert.equal(incomplete.statements.pct, 100);
  assert.ok(incomplete.branches.pct < 100);

  // ③ テストから未importのruntime TSが0%で分母へ入り、必須gateを失敗させる。
  const orphan = join(source, 'unimported.ts');
  await writeFile(orphan, '/** 未import検出fixture。 */\nexport function unused(): number { return 7; }\n');
  assert.equal(await run(cwd, 'compile-orphan', [tsc, '-p', 'tsconfig.json']), 0);
  const missing = join(cwd, 'reports/unimported');
  assert.equal(await run(cwd, 'unimported', [c8, '--reports-dir', missing, 'node', '--test', driver]), 1);
  assert.equal((await summary(missing))[orphan]!.statements.pct, 0);
  // merge試験からは未import fixtureを取り除き、両jobを同じsource/buildで実行する。
  await rm(orphan);
  await rm(output, { recursive: true, force: true });
  assert.equal(await run(cwd, 'compile-merge', [tsc, '-p', 'tsconfig.json']), 0);

  // ④ 別process・別V8 directoryの記録を集め、c8でmergeすると両分岐100%になる。
  const mergedRaw = join(cwd, 'v8/merged');
  await mkdir(mergedRaw, { recursive: true });
  for (const mode of ['positive', 'negative']) {
    const raw = join(cwd, `v8/${mode}`);
    assert.equal(await run(cwd, `job-${mode}`, ['--test', driver], { CALIBRATION_MODE: mode, NODE_V8_COVERAGE: raw }), 0);
    // 各jobの生データが存在することを確認し、衝突しない名前でmerge入力へ置く。
    const files = (await readdir(raw)).filter(name => name.endsWith('.json'));
    assert.ok(files.length > 0);
    for (const name of files) await copyFile(join(raw, name), join(mergedRaw, `${mode}-${name}`));
  }
  const merged = join(cwd, 'reports/merged');
  assert.equal(await run(cwd, 'merge', [c8, 'report', '--temp-directory', mergedRaw, '--reports-dir', merged]), 0);
  assert.equal((await summary(merged))[join(source, 'branch.ts')]!.branches.pct, 100);
});
