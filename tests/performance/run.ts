import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { runBrowserPerformance } from './browser.js';
import { loadPerformanceConfig } from './config.js';
import { evaluateGates } from './gates.js';
import { absent, command, containerState, healthy } from './process.js';
import { ResourceSampler } from './resources.js';
import type { BrowserRunReport, ContainerState, ResourceReport } from './types.js';

/** stage名を固定allowlistへ正規化する。入力: 内部stage、出力: 匿名分類。 */
function failureStage(stage: string): string {
  const allowed = new Set(['configuration', 'temporary_files', 'network', 'peer_start', 'gateway_start', 'readiness',
    'installed_package', 'environment', 'resources', 'browser', 'gateway_state']);
  return allowed.has(stage) ? stage : 'orchestration';
}


/** containerを有限時間で削除し、残存を確認する。入力: 所有名配列、出力: 全解放ならtrue。 */
async function removeContainers(names: readonly string[]): Promise<boolean> {
  let clean = true;
  for (const name of [...names].reverse()) {
    try { await command('docker', ['rm', '-f', name], 10000); }
    catch { /* 既に終了・削除済みかを下で区別する。 */ }
    if (!(await absent(name, 'container'))) clean = false;
  }
  return clean;
}

/** 1回のperformance/soak profileを専用Docker networkで実行し、匿名JSONを保存する。 */
async function main(): Promise<void> {
  let stage = 'configuration';
  const config = await loadPerformanceConfig();
  const image = process.env.PERFORMANCE_IMAGE ?? 'ros-webrtc-bridge-test:jazzy-fastrtps';
  const rmw = process.env.PERFORMANCE_RMW_IMPLEMENTATION ?? 'rmw_fastrtps_cpp';
  if (!/^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,255}$/.test(image)) throw new Error('invalid_performance_image');
  if (rmw !== 'rmw_fastrtps_cpp' && rmw !== 'rmw_cyclonedds_cpp') throw new Error('invalid_performance_rmw');
  await mkdir('.runtime', { recursive: true });
  const suffix = randomBytes(6).toString('hex');
  const resultPath = resolve('.runtime', `performance-${config.mode}-${Date.now()}-${suffix}.json`);
  const network = `bridge-performance-${suffix}`, gatewayName = `bridge-performance-gateway-${suffix}`;
  const peerName = `bridge-performance-peer-${suffix}`;
  const owned: string[] = [];
  let temporary = '', networkCreated = false, samplerStarted = false, samplerStopped = false;
  let sampler: ResourceSampler | undefined, browser: BrowserRunReport | undefined, resources: ResourceReport | undefined;
  let gateway: ContainerState = { available: false }, peer: ContainerState = { available: false };
  let installedPackage = false;
  let failure: string | undefined, cleanup = false;
  let rosDistro = 'unknown', containerNode = 'unknown', transport = 'unknown';
  const expires = performance.now() + config.timing.overallTimeoutSeconds * 1000;
  /** 共通単調deadlineの残りを返す。入力なし、出力: ms。 */
  const remaining = (): number => {
    const milliseconds = expires - performance.now();
    if (milliseconds <= 0) throw new Error('overall_timeout');
    return milliseconds;
  };
  const heartbeat = setInterval(() => console.log(`performance harness active: ${stage}`), config.timing.heartbeatSeconds * 1000);
  try {
    stage = 'temporary_files';
    temporary = await mkdtemp(join(tmpdir(), 'ros-webrtc-performance-'));
    await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(temporary, 'key.pem'), '-out', join(temporary, 'cert.pem')],
    Math.min(30000, remaining()));
    await chmod(join(temporary, 'key.pem'), 0o600);
    const credential = randomBytes(32).toString('hex');
    const performanceDirectory = resolve('tests/performance');
    stage = 'network';
    await command('docker', ['network', 'create', '--internal', '--label', `ros-webrtc-performance=${suffix}`, network],
      Math.min(30000, remaining()));
    networkCreated = true;
    const common = ['--network', network, '--label', `ros-webrtc-performance=${suffix}`, '--env', 'ROS_DOMAIN_ID=74',
      '--env', `RMW_IMPLEMENTATION=${rmw}`, '-v', `${performanceDirectory}:/run/performance:ro`];
    stage = 'peer_start';
    owned.push(peerName);
    const peerTimeout = String(Math.min(86400, Math.ceil(config.timing.overallTimeoutSeconds + 30)));
    await command('docker', ['run', '--init', '-d', '--name', peerName, ...common,
      '--env', `PERFORMANCE_PEER_TIMEOUT_SECONDS=${peerTimeout}`, image, 'bash', '-lc',
      'source /opt/ros/${ROS_DISTRO}/setup.bash && exec python3 /run/performance/peer.py'], Math.min(30000, remaining()));
    stage = 'gateway_start';
    owned.push(gatewayName);
    await command('docker', ['run', '--init', '-d', '--name', gatewayName, ...common, '-v', `${temporary}:/run/secrets:ro`,
      '--env', 'BRIDGE_CREDENTIAL', '--env', 'BRIDGE_CONFIG=/run/performance/bridge.yaml', '--env', 'BRIDGE_TLS_KEY=/run/secrets/key.pem',
      '--env', 'BRIDGE_TLS_CERT=/run/secrets/cert.pem', '--env', 'BRIDGE_HOST=0.0.0.0', '--env', 'BRIDGE_PORT=7443',
      '--env', 'BRIDGE_SUBSCRIBE_TOPICS=/performance/output', '--env', 'BRIDGE_PUBLISH_SCOPES=performance', image,
      'bash', '-lc', 'source /opt/ros/${ROS_DISTRO}/setup.bash && source /bridge/package_workspace/install/setup.bash && exec ros2 run ros_webrtc_bridge ros_webrtc_bridge'],
    Math.min(30000, remaining()), { ...process.env, BRIDGE_CREDENTIAL: credential });
    const address = await command('docker', ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', gatewayName],
      Math.min(5000, remaining()));
    stage = 'readiness';
    const url = `https://${address}:7443`;
    await healthy(url, Math.min(30000, remaining()));
    stage = 'installed_package';
    const prefix = await command('docker', ['exec', gatewayName, 'bash', '-lc',
      'source /opt/ros/${ROS_DISTRO}/setup.bash && source /bridge/package_workspace/install/setup.bash && ros2 pkg prefix ros_webrtc_bridge'],
    Math.min(10000, remaining()));
    if (!prefix.startsWith('/bridge/package_workspace/install/')) throw new Error('package_not_installed');
    installedPackage = true;
    stage = 'environment';
    [rosDistro, containerNode, transport] = await Promise.all([
      command('docker', ['exec', gatewayName, 'printenv', 'ROS_DISTRO'], Math.min(5000, remaining())),
      command('docker', ['exec', gatewayName, 'node', '--version'], Math.min(5000, remaining())),
      command('docker', ['exec', gatewayName, 'node', '-p',
        "require('/bridge/package_workspace/install/ros_webrtc_bridge/lib/ros_webrtc_bridge/vendor/werift-datachannel/package.json').version"],
      Math.min(5000, remaining())),
    ]);
    stage = 'resources';
    sampler = new ResourceSampler();
    sampler.start(gatewayName, config.timing.resourceSampleSeconds * 1000);
    samplerStarted = true;
    stage = 'browser';
    browser = await runBrowserPerformance({ ...config.workload, url, credential, timeoutMs: remaining() });
    stage = 'resources';
    resources = await sampler.stop();
    samplerStopped = true;
    stage = 'gateway_state';
    [gateway, peer] = await Promise.all([containerState(gatewayName), containerState(peerName)]);
  } catch {
    failure = failureStage(stage);
  } finally {
    // resource停止、状態保存、全所有object削除を個別に続け、primary failureを隠さない。
    if (samplerStarted && !samplerStopped && sampler !== undefined) {
      try { resources = await sampler.stop(); } catch { failure ??= 'resources'; }
    }
    if (!gateway.available) gateway = await containerState(gatewayName);
    if (!peer.available) peer = await containerState(peerName);
    const containersClean = await removeContainers(owned);
    let networkClean = !networkCreated;
    if (networkCreated) {
      try { await command('docker', ['network', 'rm', network], 10000); } catch { /* 残存確認へ進む。 */ }
      networkClean = await absent(network, 'network');
    }
    let temporaryClean = true;
    if (temporary !== '') {
      try { await rm(temporary, { recursive: true, force: true }); } catch { temporaryClean = false; }
    }
    cleanup = containersClean && networkClean && temporaryClean;
    clearInterval(heartbeat);
  }
  const evaluated = evaluateGates(config, browser, resources, gateway, peer, cleanup);
  const passed = failure === undefined && Object.values(evaluated).every(gate => gate.pass);
  // 保存値は固定環境属性と集計値だけに限定し、URL/SDP/credential/payload/container名/image名を含めない。
  const result = { schemaVersion: 1, status: passed ? 'PASS' : 'FAIL', failure: failure ?? null,
    gatePolicy: 'shared-runner-regression-and-invariant-not-absolute-performance-guarantee',
    budgetPolicy: { invariants: 'safety', provisional: 'initial-loose-poc-not-release-budget' },
    config, protocol: { path: 'direct', messageType: 'std_msgs/msg/String', dataChannel: 'reliable',
      rosQos: { reliability: 'reliable', durability: 'volatile', history: 'keep_last', depth: 256 } },
    environment: { host: { platform: platform(), release: release(), architecture: process.arch, cpuModel: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length, memoryMiB: Math.round(totalmem() / 1048576), node: process.version },
    container: { rosDistro, rmw, node: containerNode, transport, browser: browser?.browserVersion ?? 'unknown', installedPackage } },
    metrics: browser?.scenario ?? null, resources: resources ?? null, processState: { gateway, peer }, cleanup, gates: evaluated };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(`performance harness ${result.status}: anonymous result written to ${resultPath}`);
  if (!passed) process.exitCode = 1;
}

await main().catch(async () => {
  // 設定読込前の失敗も生値を表示せず、固定messageだけで終了する。
  console.error('performance harness failed before result initialization');
  process.exitCode = 1;
});
