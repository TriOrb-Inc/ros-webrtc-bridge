import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// Run from the root and place all calibration artifacts in an isolated Git-ignored directory.
const root = process.cwd();
const childTimeout = Number(process.env.COVERAGE_CALIBRATION_TIMEOUT_MS ?? 30000);
const c8 = join(root, 'node_modules/c8/bin/c8.js');
const tsc = join(root, 'node_modules/typescript/bin/tsc');

/** Run a child with a deadline. Inputs: cwd/name/Node arguments/environment; returns exit code. Successful tsc returns 0. */
async function run(cwd: string, name: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<number> {
  console.log(`coverage calibration: ${name}`);
  const heartbeat = setInterval(() => console.log(`coverage calibration: ${name} running`), 5000);
  const env: NodeJS.ProcessEnv = { ...process.env, CALIBRATION_MODE: 'full', ...extra };
  // Inheriting the parent test's internal state makes child node:test detect recursive execution and skip.
  delete env.NODE_TEST_CONTEXT;
  // Keep parent coverage out; record V8 data only for explicitly selected jobs.
  if (extra.NODE_V8_COVERAGE === undefined) delete env.NODE_V8_COVERAGE;
  try {
    return await new Promise<number>((accept, reject) => {
      execFile(process.execPath, args, { cwd, env, timeout: childTimeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        // Distinguish timeouts and signals from the expected coverage-failure exit code 1.
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

/** Read c8 summaries after source mapping. Input: report directory; returns per-source results, e.g. branch.ts at 50% branch coverage. */
async function summary(directory: string): Promise<Record<string, Metrics>> {
  return JSON.parse(await readFile(join(directory, 'coverage-summary.json'), 'utf8')) as Record<string, Metrics>;
}

test('coverage calibration: source maps, unimported files, branch gates, and merging two jobs', { timeout: childTimeout * 12 }, async () => {
  assert.ok(Number.isSafeInteger(childTimeout) && childTimeout > 0, 'positive child timeout required');
  await mkdir(join(root, '.runtime'), { recursive: true });
  const cwd = await mkdtemp(join(root, '.runtime/coverage-calibration-'));
  console.log(`coverage calibration artifacts: ${cwd}`);
  // Copy the actual configuration. Do not weaken include/exclude rules or thresholds specifically for calibration.
  await copyFile(join(root, '.c8rc.json'), join(cwd, '.c8rc.json'));
  await copyFile(join(root, 'tsconfig.json'), join(cwd, 'tsconfig.json'));
  const config = JSON.parse(await readFile(join(cwd, '.c8rc.json'), 'utf8'));
  const tsconfig = JSON.parse(await readFile(join(cwd, 'tsconfig.json'), 'utf8'));
  // The test must also fail if required denominator or per-file settings are removed.
  assert.equal(config.all, true);
  assert.equal(config['check-coverage'], true);
  assert.equal(config['per-file'], true);
  // Require statement and branch thresholds separately, preventing success based only on line coverage.
  assert.equal(config.statements, 100);
  assert.equal(config.branches, 100);
  // Match source placement to the actual include rules to verify unimported-file detection with the real configuration.
  const source = join(cwd, 'packages/bridge/src/calibration');
  await mkdir(source, { recursive: true });
  await mkdir(join(cwd, 'tests'), { recursive: true });
  await writeFile(join(cwd, 'package.json'), '{"private":true,"type":"module"}\n');
  // Use a same-line ternary to create a fixture with 100% statement coverage but incomplete branch coverage.
  await writeFile(join(source, 'branch.ts'), '/** Return the sign for coverage calibration. */\nexport function sign(value: number): number { return value > 0 ? 1 : -1; }\n');
  await writeFile(join(source, 'types.d.ts'), '/** Pure type declarations are excluded from the runtime denominator. */\nexport interface Marker { value: number }\n');
  await writeFile(join(cwd, 'tests/driver.ts'), [
    "import assert from 'node:assert/strict';", "import { test } from 'node:test';",
    "import { sign } from '../packages/bridge/src/calibration/branch.js';",
    '// Each job exercises one or both branches with independent expectations.',
    "test('sign fixture', () => {",
    "  if (process.env.CALIBRATION_MODE !== 'negative') assert.equal(sign(1), 1);",
    "  if (process.env.CALIBRATION_MODE !== 'positive') assert.equal(sign(-1), -1);",
    '});', '',
  ].join('\n'));
  // Follow the root outDir without modifying the main project's build output.
  const output = resolve(cwd, tsconfig.compilerOptions.outDir);
  assert.ok(output.startsWith(`${cwd}/`), 'isolated outDir required');
  const driver = join(output, 'tests/driver.js');
  assert.equal(await run(cwd, 'compile', [tsc, '-p', 'tsconfig.json']), 0);

  // 1. Both branches yield 100%; verify aggregation keys use original TypeScript rather than JavaScript.
  const full = join(cwd, 'reports/full');
  assert.equal(await run(cwd, 'full', [c8, '--reports-dir', full, 'node', '--test', driver]), 0);
  const covered = await summary(full);
  assert.equal(covered[join(source, 'branch.ts')]!.statements.pct, 100);
  assert.equal(covered[join(source, 'branch.ts')]!.branches.pct, 100);
  assert.deepEqual(Object.keys(covered).sort(), ['total', join(source, 'branch.ts')].sort());

  // 2. A child fails on missing branch coverage even with 100% statement coverage.
  const partial = join(cwd, 'reports/partial');
  assert.equal(await run(cwd, 'partial', [c8, '--reports-dir', partial, 'node', '--test', driver], { CALIBRATION_MODE: 'positive' }), 1);
  const incomplete = (await summary(partial))[join(source, 'branch.ts')]!;
  assert.equal(incomplete.statements.pct, 100);
  assert.ok(incomplete.branches.pct < 100);

  // 3. Runtime TypeScript not imported by tests enters the denominator at 0% and fails the required gate.
  const orphan = join(source, 'unimported.ts');
  await writeFile(orphan, '/** Fixture for detecting unimported code. */\nexport function unused(): number { return 7; }\n');
  assert.equal(await run(cwd, 'compile-orphan', [tsc, '-p', 'tsconfig.json']), 0);
  const missing = join(cwd, 'reports/unimported');
  assert.equal(await run(cwd, 'unimported', [c8, '--reports-dir', missing, 'node', '--test', driver]), 1);
  assert.equal((await summary(missing))[orphan]!.statements.pct, 0);
  // Remove the unimported fixture before merge tests and run both jobs with the same source/build.
  await rm(orphan);
  await rm(output, { recursive: true, force: true });
  assert.equal(await run(cwd, 'compile-merge', [tsc, '-p', 'tsconfig.json']), 0);

  // 4. Merge records from separate processes and V8 directories with c8 to reach 100% for both branches.
  const mergedRaw = join(cwd, 'v8/merged');
  await mkdir(mergedRaw, { recursive: true });
  for (const mode of ['positive', 'negative']) {
    const raw = join(cwd, `v8/${mode}`);
    assert.equal(await run(cwd, `job-${mode}`, ['--test', driver], { CALIBRATION_MODE: mode, NODE_V8_COVERAGE: raw }), 0);
    // Verify raw data exists for each job and place it in the merge input with collision-free names.
    const files = (await readdir(raw)).filter(name => name.endsWith('.json'));
    assert.ok(files.length > 0);
    for (const name of files) await copyFile(join(raw, name), join(mergedRaw, `${mode}-${name}`));
  }
  const merged = join(cwd, 'reports/merged');
  assert.equal(await run(cwd, 'merge', [c8, 'report', '--temp-directory', mergedRaw, '--reports-dir', merged]), 0);
  assert.equal((await summary(merged))[join(source, 'branch.ts')]!.branches.pct, 100);
});
