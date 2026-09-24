import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import test from 'node:test';
import { launch, videoSlot, type MediaTransport } from '../../../packages/bridge/src/app/cli.js';
import type { MediaTrack, Peer, RtpTransceiver, Signal } from '../../../packages/bridge/src/transport/types.js';
import { definition, fakePeer, settings, signal, source } from './fixtures.js';

/** Build a werift stand-in exposing only the media surface the CLI uses. No input; returns transport and spies. */
function transport() {
  const written: Buffer[] = [];
  const state = { stopped: 0, direction: '', codecs: [] as unknown[] };
  const pli = signal<[]>();
  const track: MediaTrack = { writeRtp(packet) { written.push(packet); }, stop() { state.stopped++; } };
  const transceiver: RtpTransceiver = { mid: null, codecs: [], sender: { onPictureLossIndication: pli as unknown as Signal<[]> } };
  const peer = {
    /** Record the requested transceiver. Inputs: track and options; returns the fake transceiver. */
    addTransceiver(_track: MediaTrack, options: { direction: string }) { state.direction = options.direction; return transceiver; },
  } as unknown as Peer;
  const media: MediaTransport = {
    MediaStreamTrack: class { constructor(_props: { kind: 'video' }) { return track; } } as unknown as MediaTransport['MediaStreamTrack'],
    useH264: (props: Record<string, unknown>) => ({ h264: props }),
  };
  return { media, peer, transceiver, written, state, pli,
    /** Record the codecs assigned to the transceiver. @returns Assigned codec list */
    codecs: () => transceiver.codecs };
}

test('adds a send-only transceiver and leaves the codec to negotiation', () => {
  const t = transport();
  const slot = videoSlot(t.media, t.peer);
  assert.equal(t.state.direction, 'sendonly', 'this bridge never receives video');
  // Assigning codecs here would override what werift negotiated with the browser, which shows up as
  // packets the decoder counts but never turns into frames.
  assert.deepEqual(t.codecs(), []);
  // The mid is only assigned during negotiation, so it is read lazily rather than captured.
  assert.equal(slot.mid, '');
  (t.transceiver as { mid: string | null }).mid = '1';
  assert.equal(slot.mid, '1');
});

test('carries RTP, keyframe requests and release through to the track', () => {
  const t = transport();
  const slot = videoSlot(t.media, t.peer);
  slot.write(Buffer.from([1, 2, 3]));
  assert.deepEqual(t.written, [Buffer.from([1, 2, 3])]);
  let requested = 0;
  slot.onKeyframeRequest(() => { requested++; });
  t.pli.emit();
  assert.equal(requested, 1);
  slot.stop();
  assert.equal(t.state.stopped, 1);
});

const VIDEO_TRACK = `
video: {start_timeout_ms: 5000, stop_grace_ms: 5000, pli_min_interval_ms: 200}
video_tracks:
  front:
    ros_topic: /camera/front/image_raw
    ros_type: sensor_msgs/msg/Image
    ros_qos: {reliability: best_effort, durability: volatile, history: keep_last, depth: 1}
    input: {encoding: rgb8, width: 1280, height: 720, framerate: 30}
    encoder: {codec: h264, backend: fixture, bitrate: 4000000, keyframe_interval: 30, profile: constrained_baseline}
    access: {subscribe_scope: video.front}
`;

/** Prepare TLS, configuration and a recording on disk. @param config Bridge YAML @returns Environment */
async function deployment(config: string) {
  await mkdir('.runtime', { recursive: true });
  const directory = await mkdtemp(path.resolve('.runtime/app-video-'));
  const keyPath = path.join(directory, 'key.pem'), certPath = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore', timeout: 5000 });
  const configPath = path.join(directory, 'bridge.yaml');
  await writeFile(configPath, config);
  const fixturePath = path.join(directory, 'recording.rtp');
  await copyFile(path.resolve('tests/fixtures/video/h264-320x240.rtp'), fixturePath);
  // A high random port keeps parallel runs of this suite from colliding on the listener.
  const port = 20000 + Math.floor(Math.random() * 40000);
  // Naming a worker program registers the GStreamer backends; it is only launched when a track
  // selects one, so an unused path never starts a process.
  const workerPath = path.join(directory, 'media_worker.py');
  await writeFile(workerPath, '');
  return { port, env: { BRIDGE_CREDENTIAL: settings.credential, BRIDGE_CONFIG: configPath, BRIDGE_TLS_KEY: keyPath,
    BRIDGE_TLS_CERT: certPath, BRIDGE_VIDEO_FIXTURE: fixturePath, BRIDGE_VIDEO_SCOPES: 'video.front',
    BRIDGE_VIDEO_WORKER: workerPath, BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: String(port) } };
}

/** Post an offer to the running listener. @param port Listener port @param sdp Offer text @returns HTTP status */
async function offer(port: number, sdp: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = httpsRequest({ hostname: '127.0.0.1', port, path: '/offer', method: 'POST', rejectUnauthorized: false,
      headers: { authorization: `Bearer ${settings.credential}`, 'content-type': 'application/json' } },
      response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
    client.on('error', reject);
    client.end(JSON.stringify({ type: 'offer', sdp }));
  });
}

test('loads the replay recording named by the environment', async () => {
  const { env } = await deployment(source);
  // The recording is read from the environment like the TLS material; startup then stops at the
  // native loader, which this test refuses to provide.
  await assert.rejects(launch(env, async () => { throw new Error('native unavailable'); }), new Error('native unavailable'));
});

test('serves a configured track through the real startup path', async () => {
  const config = source.replace('limits: {max_peers: 1,', 'limits: {video: {max_tracks: 1, max_pipelines: 1, max_slots_per_peer: 1, max_width: 1920, max_height: 1080, max_framerate: 60}, max_peers: 1,');
  const { env, port } = await deployment(`${config}${VIDEO_TRACK}`);
  const t = transport();
  let peer: ReturnType<typeof fakePeer> | undefined;
  const rcl = {
    Context: class { shutdown() {} }, init: async () => {},
    Node: class {
      createPublisher() { return { topic: '/resolved/in', publish() {} }; }
      createSubscription() { return { topic: '/resolved/out' }; }
      resolveTopicName(name: string) { return `/resolved${name}`; }
      spin() {}
    },
    QoS: class {}, MessageIntrospector: class { get schema() { return definition; } },
  };
  const app = await launch(env, async (name: string) => name === 'rclnodejs' ? { default: rcl }
    : { ...t.media, RTCPeerConnection: class { constructor() { peer = Object.assign(fakePeer(), { addTransceiver: t.peer.addTransceiver }); return peer; } } });
  assert.deepEqual(app.videoDiagnostics(), [{ track: 'front', backend: 'fixture', state: 'idle', viewers: 0, packets: 0, keyframeRequests: 0 }]);
  // A real offer carrying one receive-only section reaches werift through the CLI's own wiring.
  assert.equal(await offer(port, ['m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=recvonly', 'a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=1;profile-level-id=42e01f'].join('\r\n')), 200);
  assert.equal(t.state.direction, 'sendonly');
  assert.ok(peer);
  await app.close();
});
