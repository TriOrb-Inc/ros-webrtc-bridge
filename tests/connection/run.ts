import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:https';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyBrowserConnection } from '../browser/connection.js';
import { connectionFailure, parseContainerState, type ContainerState } from './diagnostics.js';
import { command, parseTimeoutMs } from './process.js';

/** HTTPS readinessをdeadlineまで待つ。入力URL/timeout、出力なし。例: /health=200 → 正常終了。 */
async function healthy(url: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const ready = await new Promise<boolean>(resolve => {
      const req = request(`${url}/health`, { rejectUnauthorized: false, timeout: 1000 }, response => {
        response.resume(); resolve(response.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
    if (ready) return;
    await delay(100);
  }
  throw new Error('gateway readiness timeout');
}

type RmwImplementation = 'rmw_fastrtps_cpp' | 'rmw_cyclonedds_cpp';

/** 1 distro/RMWの専用networkでinstalled GatewayとROS/browserを接続する。入力matrix、出力匿名結果。 */
async function verify(distro: 'humble' | 'jazzy', relay: boolean, rmw: RmwImplementation) {
  const directory = await mkdtemp(resolve('.runtime', `connection-${distro}-`));
  const input = join(directory, 'inputs');
  await mkdir(input, { mode: 0o700 });
  const suffix = randomBytes(5).toString('hex');
  // credential・鍵・TURN設定は一時mountに限定し、成否を問わず削除する。
  const credential = randomBytes(32).toString('hex');
  const network = `bridge-test-${suffix}`;
  const gateway = `bridge-gateway-${suffix}`, peer = `bridge-peer-${suffix}`, turn = `bridge-turn-${suffix}`;
  const owned: string[] = [];
  let networkCreated = false;
  const run = (name: string, executable: string, args: string[], extra = {}) => command(name, executable, args, { directory, ...extra });
  const heartbeat = setInterval(() => console.log(`connection test: ${distro} verification running`), 4000);
  try {
    // image buildはnetwork外で実施し、試験graphは外部へ出られない専用networkに置く。
    const image = `ros-webrtc-bridge-test:${distro}-${rmw.replace('rmw_', '').replace('_cpp', '')}`;
    const base = distro === 'humble' ? 'ros:humble-ros-base-jammy' : 'ros:jazzy-ros-base-noble';
    const platform = process.env.CONNECTION_PLATFORM;
    if (platform !== undefined) assert.ok(platform === 'linux/amd64' || platform === 'linux/arm64');
    const platformArgs = platform === undefined ? [] : ['--platform', platform];
    const buildTimeoutMs = parseTimeoutMs(process.env.CONNECTION_BUILD_TIMEOUT_MS, 1200000, 60000, 1800000);
    await run('build', 'docker', ['build', ...platformArgs, '-f', 'tests/ros/Dockerfile', '--build-arg', `ROS_IMAGE=${base}`,
      '--build-arg', `BRIDGE_RMW_IMPLEMENTATION=${rmw}`, '-t', image, '.'], { timeoutMs: buildTimeoutMs });
    await run('certificate', 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(input, 'key.pem'), '-out', join(input, 'cert.pem')]);
    await chmod(join(input, 'key.pem'), 0o600);
    networkCreated = true;
    await run('network', 'docker', ['network', 'create', '--internal', '--label', `ros-webrtc-test=${suffix}`, network]);
    // DDS discoveryはこのnetwork内、domain/namespaceも試験専用にする。
    const rosArgs = ['--network', network, '--label', `ros-webrtc-test=${suffix}`, '--env', 'ROS_DOMAIN_ID=73',
      '--env', 'ROS_TEST_TIMEOUT_SECONDS=360', '--env', `RMW_IMPLEMENTATION=${rmw}`];
    owned.push(peer);
    await run('peer-start', 'docker', ['run', ...platformArgs, '--init', '-d', '--name', peer, ...rosArgs, image]);
    owned.push(gateway);
    await run('gateway-start', 'docker', ['run', ...platformArgs, '--init', '-d', '--name', gateway, ...rosArgs,
      '-v', `${input}:/run/bridge:ro`, '--env', 'BRIDGE_CREDENTIAL',
      '--env', 'BRIDGE_CONFIG=/bridge/tests/ros/connection-custom.yaml', '--env', 'BRIDGE_TLS_KEY=/run/bridge/key.pem',
      '--env', 'BRIDGE_TLS_CERT=/run/bridge/cert.pem', '--env', 'BRIDGE_HOST=0.0.0.0', '--env', 'BRIDGE_PORT=7443',
      '--env', 'BRIDGE_SUBSCRIBE_TOPICS=/output,/observed,/custom_output', '--env', 'BRIDGE_PUBLISH_SCOPES=integration',
      image, 'bash', '-lc', 'source /opt/ros/${ROS_DISTRO}/setup.bash && source /bridge/test_interfaces/install/setup.bash && source /bridge/package_workspace/install/setup.bash && exec ros2 run ros_webrtc_bridge ros_webrtc_bridge'],
      { env: { BRIDGE_CREDENTIAL: credential } });
    const address = await run('gateway-address', 'docker', ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', gateway]);
    const url = `https://${address}:7443`;
    await healthy(url, 30000);
    const peerRmw = await run('rmw-identifier-peer', 'docker', ['exec', peer, 'bash', '-lc',
      'source /opt/ros/${ROS_DISTRO}/setup.bash && source /bridge/test_interfaces/install/setup.bash && python3 -c "from rclpy.utilities import get_rmw_implementation_identifier; print(get_rmw_implementation_identifier())"']);
    assert.equal(peerRmw, rmw, 'peer RMW differs from the requested implementation');
    const packagePrefix = await run('package-prefix', 'docker', ['exec', gateway, 'bash', '-lc',
      'source /opt/ros/${ROS_DISTRO}/setup.bash && source /bridge/package_workspace/install/setup.bash && ros2 pkg prefix ros_webrtc_bridge']);
    assert.ok(packagePrefix.startsWith('/bridge/package_workspace/install/'), 'gateway package must resolve from the install prefix');
    // Gatewayと同じinstall treeのrclnodejs addonを別contextで初期化し、要求RMWが実際にloadされることを確認する。
    const gatewayRmw = await run('rmw-identifier-gateway', 'docker', ['exec', gateway, 'bash', '-lc',
      'source /opt/ros/${ROS_DISTRO}/setup.bash && source /bridge/test_interfaces/install/setup.bash && source /bridge/package_workspace/install/setup.bash && node --input-type=module --eval \'import rclnodejs from "/bridge/package_workspace/install/ros_webrtc_bridge/lib/ros_webrtc_bridge/node_modules/rclnodejs/index.js"; await rclnodejs.init(); const node = rclnodejs.createNode("ros_webrtc_bridge_rmw_probe"); console.log(node.getRMWImplementationIdentifier()); node.destroy(); rclnodejs.shutdown();\'']);
    assert.equal(gatewayRmw, rmw, 'Gateway rclnodejs RMW differs from the requested implementation');
    const nodeArchitecture = await run('node-architecture', 'docker', ['exec', gateway, 'node', '-p', 'process.arch']);
    const platformArchitecture = platform === 'linux/amd64' ? 'x64'
      : platform === 'linux/arm64' ? 'arm64' : undefined;
    const expectedArchitecture = process.env.CONNECTION_EXPECTED_ARCH ?? platformArchitecture ?? process.arch;
    assert.ok(expectedArchitecture === 'x64' || expectedArchitecture === 'arm64', 'unsupported expected Node architecture');
    assert.equal(nodeArchitecture, expectedArchitecture, 'container Node architecture differs from expectation');
    const reports: unknown[] = [];
    try {
      // まずdirect経路で独立ROS nodeとの全利用経路を確認する。
      reports.push(await verifyBrowserConnection({ url, credential }));
      if (relay) {
        const turnUser = randomBytes(12).toString('hex'), turnCredential = randomBytes(32).toString('hex');
        await writeFile(join(input, 'turn.conf'), ['listening-port=3478', 'fingerprint', 'lt-cred-mech', 'realm=bridge-test',
          `user=${turnUser}:${turnCredential}`, 'no-cli', 'no-tls', 'no-dtls', 'no-multicast-peers', 'allow-loopback-peers',
          'min-port=49160', 'max-port=49200', 'no-stdout-log', 'log-file=/dev/null', ''].join('\n'), { mode: 0o600 });
        owned.push(turn);
        await run('turn-start', 'docker', ['run', '--init', '-d', '--user', '0:0', '--name', turn, '--network', network,
          '--label', `ros-webrtc-test=${suffix}`, '-v', `${input}:/run/bridge:ro`, 'coturn/coturn:4.6.3', '-c', '/run/bridge/turn.conf']);
        const address = await run('turn-address', 'docker', ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', turn]);
        // fallbackを許さず選択candidateがrelayであることをbrowser helper内でassertする。
        reports.push(await verifyBrowserConnection({ url, credential, relayOnly: true,
          iceServers: [{ urls: `turn:${address}:3478?transport=udp`, username: turnUser, credential: turnCredential }] }));
      }
    } catch (error) {
      // containerの限定状態と固定失敗分類だけを公開可能な結果へ残し、生logや接続情報は含めない。
      let gatewayState: ContainerState = { available: false };
      try {
        const state = await run('gateway-state', 'docker', ['inspect', '--format',
          '{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}', gateway]);
        gatewayState = parseContainerState(state);
      } catch { /* cleanupを続け、診断取得失敗で元の接続失敗を置き換えない。 */ }
      await writeFile(join(directory, 'result.json'), JSON.stringify({ distro, status: 'FAIL',
        failure: connectionFailure(error), gateway: gatewayState }, null, 2)).catch(() => {});
      throw error;
    }
    const imageInfo = await run('image', 'docker', ['image', 'inspect', image, '--format', '{{.Architecture}} {{.Id}}']);
    const imageArchitecture = imageInfo.split(/\s+/, 1)[0];
    const expectedImageArchitecture = expectedArchitecture === 'x64' ? 'amd64' : 'arm64';
    assert.equal(imageArchitecture, expectedImageArchitecture, 'Docker image architecture differs from expectation');
    const result = { distro, requestedRmw: rmw, peerRmw, gatewayRmw, nodeArchitecture,
      imageArchitecture, installedPackage: true, image: imageInfo, reports };
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(`connection test: ${distro} PASS`);
    return result;
  } finally {
    // 診断にSDP/credentialを出さないgatewayのログだけを取得する。
    const cleanupErrors: unknown[] = [];
    for (const name of owned.reverse()) {
      try {
        const existing = await run(`${name}-exists`, 'docker', ['ps', '-aq', '--filter', `name=^${name}$`, '--filter', `label=ros-webrtc-test=${suffix}`]);
        if (!existing) continue;
        await run(`${name}-logs`, 'docker', ['logs', name]).catch(() => {});
        await run(`${name}-remove`, 'docker', ['rm', '-f', name]);
      } catch (error) { cleanupErrors.push(error); }
    }
    // 一つのcleanup失敗で他containerや秘密ファイルの後始末を飛ばさない。
    if (networkCreated) {
      try {
        const existing = await run('network-exists', 'docker', ['network', 'ls', '-q', '--filter', `name=^${network}$`, '--filter', `label=ros-webrtc-test=${suffix}`]);
        if (existing) await run('network-remove', 'docker', ['network', 'rm', network]);
      } catch (error) { cleanupErrors.push(error); }
    }
    try { await rm(input, { recursive: true, force: true }); } finally { clearInterval(heartbeat); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'connection cleanup failed');
  }
}

/** 指定matrixを実行する。環境DISTROS/TURN/RMW、出力は匿名集計JSONと終了code。 */
async function main(): Promise<void> {
  await mkdir('.runtime', { recursive: true });
  const distros = (process.env.CONNECTION_DISTROS ?? 'humble,jazzy').split(',');
  assert.ok(distros.length > 0 && distros.every(value => value === 'humble' || value === 'jazzy'));
  const relay = process.env.CONNECTION_TURN !== '0';
  const rmw = process.env.CONNECTION_RMW_IMPLEMENTATION ?? 'rmw_fastrtps_cpp';
  assert.ok(rmw === 'rmw_fastrtps_cpp' || rmw === 'rmw_cyclonedds_cpp');
  // pulling中も進捗とtimeoutを管理する。TURNは独立したBSDライセンスの試験サービス。
  if (relay) await command('turn-pull', 'docker', ['pull', 'coturn/coturn:4.6.3'], { directory: resolve('.runtime'), timeoutMs: 180000 });
  const results = [];
  for (const distro of distros) results.push(await verify(distro as 'humble' | 'jazzy', relay, rmw));
  await writeFile('.runtime/connection-results.json', JSON.stringify(results, null, 2));
}

await main().catch(error => { console.error(error instanceof Error ? error.message : 'connection test failed'); process.exitCode = 1; });
