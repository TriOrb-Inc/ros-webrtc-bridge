import { randomUUID } from 'node:crypto';
import { parseBridgeConfig } from '../config/index.js';
import { TopicRosAdapter } from '../ros/adapter.js';
import { CommandGuard } from '../session/command-guard.js';
import { SessionRouter } from '../router/index.js';
import { WebRtcEndpoint } from '../transport/endpoint.js';
import { createSignalingHandler } from '../signaling/handler.js';
import { createRegistry, inspectConfig } from './registry.js';
import { positiveLimit } from '../session/validation.js';
import type { AppFactories, AppSettings } from './types.js';
export type { AppFactories, AppSettings } from './types.js';

/** ROSとHTTPSを組み立てる。入力: 設定とI/O factory。出力: close可能なapp。部分失敗も全資源を解放する。 */
export async function startApp(settings: AppSettings, factories: AppFactories) {
  const preliminary = inspectConfig(settings.configSource, settings.maxConfigBytes);
  for (const value of [settings.timeoutMs, settings.maxSdpBytes, settings.requestTimeoutMs, ...Object.values(settings.routerLimits)]) positiveLimit(value);
  // credential検証はnative init前。handler生成時にも同じ認証境界を確認する。
  if (typeof settings.credential !== 'string' || settings.credential.length < 32) throw new Error('invalid_credential');
  const backend = await factories.initialize();
  let adapter: TopicRosAdapter | undefined;
  let guard: CommandGuard | undefined;
  let server: { close(): Promise<void> } | undefined;
  // peerは交渉開始前から数え、同時offerで上限を超えないよう予約する。
  const peers = new Set<WebRtcEndpoint>();
  let closing: Promise<void> | undefined;
  let stopped = false;
  /** sessionから先に撤回し、最後にROS contextを閉じる。入力なし、出力idempotent完了Promise。 */
  function close(): Promise<void> {
    if (closing) return closing;
    stopped = true;
    closing = (async () => {
      const results = await Promise.allSettled([...peers].map(peer => peer.close()));
      guard?.close();
      // 一つのclose失敗で残りのcleanupを省略しない。
      try { if (adapter) adapter.close(); else backend.close(); } catch { factories.onError(); }
      try { await server?.close(); } catch { factories.onError(); }
      if (results.some(result => result.status === 'rejected')) factories.onError();
    })();
    return closing;
  }
  try {
    const config = parseBridgeConfig(settings.configSource, { availableTypes: preliminary.topics.map(topic => topic.rosType),
      maxConfigBytes: settings.maxConfigBytes, resolveTopic: name => backend.resolveTopic(name) });
    const registry = createRegistry(config, type => backend.describe(type));
    const subscriptions = new Set(settings.subscribeTopics);
    const scopes = new Set(settings.publishScopes);
    // 単一Bearerに付与された明示allowlistのみ許可し、publish scope未指定はdefault denyとする。
    const allowed = (binding: typeof config.topics[number], operation: 'subscribe' | 'publish') => operation === 'subscribe'
      ? subscriptions.has(binding.publicName) : binding.access !== undefined && scopes.has(binding.access.publishScope);
    guard = new CommandGuard({ clock: factories.clock, maxSessions: config.limits.maxPeers,
      maxHandles: settings.routerLimits.maxHandles * config.limits.maxPeers, leaseMs: 250,
      authorize: identity => !stopped && config.topics.some(topic => topic.rosTopic === identity.topic && allowed(topic, 'publish')) });
    adapter = new TopicRosAdapter(registry, backend, factories.onError);
    adapter.start();
    // handlerからのみpeerを生成するため、認証失敗時はICE/DTLS資源を割り当てない。
    const handler = createSignalingHandler({ ...settings, maxBodyBytes: settings.maxSdpBytes, maxPending: config.limits.maxPeers,
      accept: async offer => {
        if (stopped || peers.size >= config.limits.maxPeers) throw new Error('peer_limit');
        const endpoint = new WebRtcEndpoint({ peer: factories.makePeer(), maxMessageBytes: config.limits.maxMessageBytes,
          maxBufferedBytes: config.limits.maxChannelBufferedBytes, maxSdpBytes: settings.maxSdpBytes, timeoutMs: settings.timeoutMs,
          onError: factories.onError, onClosed: () => { peers.delete(endpoint); },
          // remoteの受信上限をrouterのenvelope上限にも反映する。
          makeRouter: (send, maxMessageBytes, onClosed) => new SessionRouter({ config: { ...config, limits: { ...config.limits, maxMessageBytes } },
            bindings: registry, guard: guard!, ros: adapter!, epoch: randomUUID(), clock: factories.clock, send,
            authorize: allowed, limits: settings.routerLimits, onClosed }) });
        peers.add(endpoint);
        return endpoint.answer(offer);
      },
    });
    server = await factories.listen(handler);
    return { config, registry, close, peerCount: () => peers.size };
  } catch (error) { await close(); throw error; }
}
