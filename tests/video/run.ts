import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'node:https';
import { chromium } from 'playwright-core';
import { browserVideoScenario } from '../browser/video-scenario.js';
import { browserVideoLoadScenario } from '../browser/video-load-scenario.js';
import { hardwareArgs, hardwareEvidence } from './hardware.js';
import { command, parseTimeoutMs } from '../connection/process.js';
import type { VideoLoadResult, VideoScenarioResult } from '../browser/types.js';

/**
 * Containerised video verification.
 *
 * Everything runs in Docker on one private network: an independent ROS 2 image publisher, the
 * colcon-installed bridge, and a real Chromium. The mock is a real rclpy node rather than an
 * in-process stub, so discovery, QoS and the installed `ros2 run` entry point are all exercised, and
 * the decoder is a real browser rather than an assertion about bytes.
 *
 * The browser lives in a container because the host may not be a platform Playwright supports, and
 * because a self-contained environment is reproducible. This process only drives it over CDP.
 *
 * `VIDEO_BACKEND` selects the encoder. The default `fixture` replays a recording, so the run needs
 * no GPU and no GStreamer; `l4t_v4l2` and `openh264` run the real media worker, and `l4t_v4l2`
 * additionally borrows the host's L4T plugins. `VIDEO_MODE=load` replaces the single-viewer
 * behavioural run with the multi-viewer and soak scenario.
 */

/** Encoder under test. `fixture` is the only one that runs without host GStreamer. */
export type Backend = 'fixture' | 'l4t_v4l2' | 'openh264';

/** Bounded positive integer from the environment. Inputs: name and default; returns the value. */
function count(env: string | undefined, fallback: number, maximum: number): number {
  if (env === undefined) return fallback;
  const value = Number(env);
  assert.ok(Number.isSafeInteger(value) && value >= 1 && value <= maximum, `invalid ${env}`);
  return value;
}

/**
 * Resident memory of one container, in MiB.
 * @param run Command runner. @param name Container name.
 * @returns Megabytes, e.g. `118.4`. Docker reports a human string, so the unit is parsed explicitly.
 */
async function residentMiB(run: (name: string, executable: string, args: string[]) => Promise<string>, name: string): Promise<number> {
  const raw = await run(`${name}-memory`, 'docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', name]);
  const match = /^\s*([0-9.]+)\s*([A-Za-z]+)/.exec(raw);
  if (match === null) throw new Error(`unreadable memory reading: ${raw}`);
  const scale: Record<string, number> = { B: 1 / 1048576, KIB: 1 / 1024, MIB: 1, GIB: 1024, KB: 1 / 1024, MB: 1, GB: 1024 };
  const unit = scale[match[2].toUpperCase()];
  if (unit === undefined) throw new Error(`unknown memory unit: ${match[2]}`);
  return Number(match[1]) * unit;
}

// A soak run cycles far more than a behavioural one, so it gets its own budget rather than the
// single-run timeout.
const loadTimeoutMs = parseTimeoutMs(process.env.VIDEO_LOAD_TIMEOUT_MS, 600000, 60000, 7200000);
const maxGrowthMiB = Number(process.env.VIDEO_MAX_GROWTH_MIB ?? 64);

// Supplies the browser binaries only. The server itself is this repository's pinned playwright-core,
// mounted in, so the client and server are the same version and the container needs no network.
const BROWSER_IMAGE = process.env.VIDEO_BROWSER_IMAGE ?? 'mcr.microsoft.com/playwright:v1.63.0-noble';

/** Wait for HTTPS readiness until a deadline. Inputs: URL and timeout; no return value. */
async function healthy(url: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const ready = await new Promise<boolean>(settle => {
      const probe = request(`${url}/health`, { rejectUnauthorized: false, timeout: 1000 }, response => {
        response.resume(); settle(response.statusCode === 200);
      });
      probe.on('error', () => settle(false));
      probe.on('timeout', () => { probe.destroy(); settle(false); });
      probe.end();
    });
    if (ready) return;
    await delay(100);
  }
  throw new Error('gateway readiness timeout');
}

/** Run the containerised scenario for one distro. Inputs: distro, backend and mode; returns anonymized results. */
async function verify(distro: 'humble' | 'jazzy', backend: Backend, mode: 'verify' | 'load') {
  const directory = await mkdtemp(resolve('.runtime', `video-${distro}-`));
  const input = join(directory, 'inputs');
  await mkdir(input, { mode: 0o700 });
  const suffix = randomBytes(5).toString('hex');
  // Credentials and TLS material live in a temporary mount and are deleted on success or failure.
  const credential = randomBytes(32).toString('hex');
  const network = `video-test-${suffix}`;
  const gateway = `video-gateway-${suffix}`, peer = `video-peer-${suffix}`, browserHost = `video-browser-${suffix}`;
  const owned: string[] = [];
  let networkCreated = false;
  const run = (name: string, executable: string, args: string[], extra = {}) => command(name, executable, args, { directory, ...extra });
  const heartbeat = setInterval(() => console.log(`video test: ${distro} verification running`), 4000);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const image = `ros-webrtc-bridge-test:${distro}-fastrtps`;
    const base = distro === 'humble' ? 'ros:humble-ros-base-jammy' : 'ros:jazzy-ros-base-noble';
    const platform = process.env.VIDEO_PLATFORM;
    if (platform !== undefined) assert.ok(platform === 'linux/amd64' || platform === 'linux/arm64');
    const platformArgs = platform === undefined ? [] : ['--platform', platform];
    await run('build', 'docker', ['build', ...platformArgs, '-f', 'tests/ros/Dockerfile', '--build-arg', `ROS_IMAGE=${base}`,
      '-t', image, '.'], { timeoutMs: parseTimeoutMs(process.env.VIDEO_BUILD_TIMEOUT_MS, 1200000, 60000, 1800000) });
    await run('certificate', 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(input, 'key.pem'), '-out', join(input, 'cert.pem')]);
    await chmod(join(input, 'key.pem'), 0o600);
    networkCreated = true;
    await run('network', 'docker', ['network', 'create', '--internal', '--label', `ros-webrtc-test=${suffix}`, network]);
    // Confine DDS discovery to this network and use a test-specific domain. An `--internal` bridge
    // does not carry the multicast that discovery defaults to, so the two containers name each other
    // and discover by unicast: the isolation is the point, and giving it up to reach the host graph
    // would be worse than configuring discovery.
    const rosArgs = ['--network', network, '--label', `ros-webrtc-test=${suffix}`, '--env', 'ROS_DOMAIN_ID=74',
      '--env', 'ROS_TEST_TIMEOUT_SECONDS=360', '--env', 'RMW_IMPLEMENTATION=rmw_fastrtps_cpp',
      '--env', 'ROS_AUTOMATIC_DISCOVERY_RANGE=SUBNET', '--env', `ROS_STATIC_PEERS=${peer};${gateway}`];

    // The independent publisher is a real ROS node: nothing here shares the bridge's own code.
    owned.push(peer);
    await run('peer-start', 'docker', ['run', ...platformArgs, '--init', '-d', '--name', peer, ...rosArgs, image,
      'bash', '-lc', 'source /opt/ros/${ROS_DISTRO}/setup.bash && source /bridge/test_interfaces/install/setup.bash && exec python3 /bridge/tests/ros/video_peer.py']);

    // The replay backend and the real encoders need different configuration and different wiring,
    // and only the L4T one needs anything from the host.
    const replay = backend === 'fixture';
    let configPath = '/bridge/tests/ros/connection-video.yaml';
    if (!replay) {
      // The committed hardware configuration names one backend. Substituting the requested one keeps
      // a single source of truth; without it a run asked for `openh264` would start NVENC and write
      // the result under an `openh264` evidence filename, which is worse than failing.
      const template = await readFile(resolve('tests/ros/hardware-video.yaml'), 'utf8');
      const configured = template.replace('backend: l4t_v4l2', `backend: ${backend}`);
      assert.ok(backend === 'l4t_v4l2' || configured !== template, 'hardware configuration no longer names a substitutable backend');
      await writeFile(join(input, 'video.yaml'), configured, { mode: 0o644 });
      configPath = '/run/bridge/video.yaml';
    }
    const encoderArgs = replay
      ? ['--env', 'BRIDGE_VIDEO_FIXTURE=/bridge/tests/fixtures/video/h264-320x240.rtp']
      : ['--env', 'BRIDGE_VIDEO_WORKER=/bridge/worker/media_worker.py',
        ...(backend === 'l4t_v4l2' ? hardwareArgs() : [])];

    owned.push(gateway);
    await run('gateway-start', 'docker', ['run', ...platformArgs, '--init', '-d', '--name', gateway, ...rosArgs,
      '-v', `${input}:/run/bridge:ro`, '--env', 'BRIDGE_CREDENTIAL',
      '--env', `BRIDGE_CONFIG=${configPath}`, '--env', 'BRIDGE_TLS_KEY=/run/bridge/key.pem',
      '--env', 'BRIDGE_TLS_CERT=/run/bridge/cert.pem', '--env', 'BRIDGE_HOST=0.0.0.0', '--env', 'BRIDGE_PORT=7443',
      '--env', 'BRIDGE_SUBSCRIBE_TOPICS=/output', '--env', 'BRIDGE_VIDEO_SCOPES=video.front,video.rear',
      ...encoderArgs,
      image, 'bash', '-lc', 'source /opt/ros/${ROS_DISTRO}/setup.bash && source /bridge/test_interfaces/install/setup.bash && source /bridge/package_workspace/install/setup.bash && exec ros2 run ros_webrtc_bridge ros_webrtc_bridge'],
      { env: { BRIDGE_CREDENTIAL: credential } });

    const address = await run('gateway-address', 'docker', ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', gateway]);
    const url = `https://${address}:7443`;
    // A real encoder is probed before the listener opens, so readiness legitimately takes longer
    // than the replay backend's.
    await healthy(url, replay ? 30000 : 120000);

    // Ask the gateway, not the publisher. Listing topics inside the container that publishes them
    // proves only that it can see itself, which would pass even if the two never discovered each
    // other. DDS discovery is not instantaneous, so poll within a bounded deadline.
    const discovered = Date.now() + 30000;
    let topics = '';
    for (let attempt = 1; !/\/bridge_test\/image_raw/.test(topics); attempt++) {
      assert.ok(Date.now() < discovered, `the gateway did not discover the mock image topic; last list: ${topics}`);
      if (attempt > 1) await delay(1000);
      topics = await run(`ros-topics-${attempt}`, 'docker', ['exec', gateway, 'bash', '-lc',
        'source /opt/ros/${ROS_DISTRO}/setup.bash && ros2 topic list']);
    }

    // Chromium runs inside the network so it reaches the gateway directly; this process only drives it.
    owned.push(browserHost);
    await run('browser-start', 'docker', ['run', ...platformArgs, '--init', '-d', '--name', browserHost,
      '--network', network, '--label', `ros-webrtc-test=${suffix}`,
      '-v', `${resolve('node_modules/playwright-core')}:/playwright-core:ro`,
      BROWSER_IMAGE, 'node', '/playwright-core/cli.js', 'run-server', '--port', '3000', '--host', '0.0.0.0']);
    // An internal network cannot publish ports, so reach the container by address as the gateway is.
    const browserAddress = await run('browser-address', 'docker', ['inspect', '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', browserHost]);
    // The server needs a moment to bind; connect within a bounded deadline rather than sleeping blindly.
    const ready = Date.now() + 60000;
    for (;;) {
      try { browser = await chromium.connect(`ws://${browserAddress}:3000/`, { timeout: 5000 }); break; }
      catch (error) {
        assert.ok(Date.now() < ready, `browser server did not accept a connection: ${(error as Error).message}`);
        await delay(1000);
      }
    }
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${url}/health`, { timeout: 15000 });
    // Only the replay configuration negotiates two tracks; the encoder configurations serve one.
    const slots = replay ? 2 : 1;
    const evidence = backend === 'l4t_v4l2' ? { host: await hardwareEvidence(run) } : {};
    const common = { distro, backend, mode, browserVersion: browser.version(), ...evidence };

    if (mode === 'load') {
      const workload = {
        url, credential, viewers: count(process.env.VIDEO_VIEWERS, 4, 8),
        cycles: count(process.env.VIDEO_CYCLES, 6, 200),
        holdMs: count(process.env.VIDEO_HOLD_MS, 1500, 60000), timeoutMs: loadTimeoutMs,
      };
      /** Run one phase and fail loudly. Input: phase name; returns its measurements. */
      const phase = async (name: 'viewers' | 'cycles') => {
        const result = await page.evaluate(browserVideoLoadScenario, { ...workload, phase: name }) as VideoLoadResult;
        if ('failure' in result) throw new Error(`video_load_failed:${name}:${result.failure}`);
        return result;
      };

      const watchers = await phase('viewers');
      // Baseline after the first phase, not before it: an encoder loads its libraries once, and
      // charging that to the cycles would report every hardware run as a leak. What the cycles must
      // show is that repeating the whole thing costs nothing more.
      const before = await residentMiB(run, gateway);
      const repeated = await phase('cycles');
      const after = await residentMiB(run, gateway);
      const growthMiB = Math.round((after - before) * 10) / 10;
      const cycleCount = 'cycles' in repeated ? repeated.cycles.count : 0;
      assert.ok(growthMiB <= maxGrowthMiB, `gateway grew ${growthMiB} MiB over ${cycleCount} cycles`);
      // Both phases carry an `assertions` key, so merge them rather than letting one spread win.
      const load = {
        viewers: 'viewers' in watchers ? watchers.viewers : undefined,
        cycles: 'cycles' in repeated ? repeated.cycles : undefined,
        assertions: { ...watchers.assertions, ...repeated.assertions },
      };
      console.log(`video test: ${distro}/${backend} LOAD PASS ${JSON.stringify({ ...load, growthMiB })}`);
      return { ...common, residentMiB: { before, after, growthMiB, budgetMiB: maxGrowthMiB }, ...load };
    }

    const report = await page.evaluate(browserVideoScenario, { url, credential, slots, timeoutMs: 90000 }) as VideoScenarioResult;
    if ('failure' in report) throw new Error(`video_e2e_failed:${report.failure}:${JSON.stringify(report.diagnostics ?? {})}`);
    assert.ok(report.framesDecoded > 0, 'browser must decode frames');
    console.log(`video test: ${distro}/${backend} PASS ${JSON.stringify(report)}`);
    return { ...common, ...report };
  } finally {
    const cleanupErrors: unknown[] = [];
    try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
    for (const name of owned.reverse()) {
      try {
        const existing = await run(`${name}-exists`, 'docker', ['ps', '-aq', '--filter', `name=^${name}$`, '--filter', `label=ros-webrtc-test=${suffix}`]);
        if (!existing) continue;
        await run(`${name}-logs`, 'docker', ['logs', name]).catch(() => {});
        await run(`${name}-remove`, 'docker', ['rm', '-f', name]);
      } catch (error) { cleanupErrors.push(error); }
    }
    if (networkCreated) {
      try {
        const existing = await run('network-exists', 'docker', ['network', 'ls', '-q', '--filter', `name=^${network}$`, '--filter', `label=ros-webrtc-test=${suffix}`]);
        if (existing) await run('network-remove', 'docker', ['network', 'rm', network]);
      } catch (error) { cleanupErrors.push(error); }
    }
    try { await rm(input, { recursive: true, force: true }); } finally { clearInterval(heartbeat); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'video cleanup failed');
  }
}

/** Run the selected distros. Inputs: VIDEO_DISTROS environment; outputs: aggregate JSON and exit code. */
async function main(): Promise<void> {
  await mkdir('.runtime', { recursive: true });
  const distros = (process.env.VIDEO_DISTROS ?? 'jazzy').split(',');
  assert.ok(distros.length > 0 && distros.every(value => value === 'humble' || value === 'jazzy'));
  const backend = (process.env.VIDEO_BACKEND ?? 'fixture') as Backend;
  assert.ok(['fixture', 'l4t_v4l2', 'openh264'].includes(backend), 'invalid VIDEO_BACKEND');
  const mode = (process.env.VIDEO_MODE ?? 'verify') as 'verify' | 'load';
  assert.ok(mode === 'verify' || mode === 'load', 'invalid VIDEO_MODE');
  const results = [];
  for (const distro of distros) results.push(await verify(distro as 'humble' | 'jazzy', backend, mode));
  const { writeFile } = await import('node:fs/promises');
  // One evidence file per backend and mode, so a hardware run does not overwrite the CI one.
  const suffix = backend === 'fixture' && mode === 'verify' ? '' : `-${backend}-${mode}`;
  await writeFile(`.runtime/video-results${suffix}.json`,
    JSON.stringify({ recordedAt: new Date().toISOString(), results }, null, 2));
}

await main().catch(error => { console.error(error instanceof Error ? error.message : 'video test failed'); process.exitCode = 1; });
