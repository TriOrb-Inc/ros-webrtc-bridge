import { randomUUID } from 'node:crypto';
import { parseBridgeConfig, parseVideoConfig, PROFILE_IDC } from '../config/index.js';
import { MediaService, timerSchedule } from '../media/index.js';
import { TopicRosAdapter } from '../ros/adapter.js';
import { CommandGuard } from '../session/command-guard.js';
import { SessionRouter } from '../router/index.js';
import { WebRtcEndpoint } from '../transport/endpoint.js';
import { createSignalingHandler } from '../signaling/handler.js';
import { createRegistry, inspectConfig } from './registry.js';
import { positiveLimit } from '../session/validation.js';
import type { VideoBinding } from '../config/types.js';
import type { AppFactories, AppSettings } from './types.js';
export type { AppFactories, AppSettings } from './types.js';

/** Assemble ROS and HTTPS. Inputs: configuration and I/O factories. Returns a closeable app; partial failures release all resources. */
export async function startApp(settings: AppSettings, factories: AppFactories) {
  const preliminary = inspectConfig(settings.configSource, settings.maxConfigBytes);
  for (const value of [settings.timeoutMs, settings.maxSdpBytes, settings.requestTimeoutMs, ...Object.values(settings.routerLimits)]) positiveLimit(value);
  // Validate credentials before native initialization; check the same authentication boundary when creating the handler.
  if (typeof settings.credential !== 'string' || settings.credential.length < 32) throw new Error('invalid_credential');
  const backend = await factories.initialize();
  let adapter: TopicRosAdapter | undefined;
  let guard: CommandGuard | undefined;
  let media: MediaService | undefined;
  let server: { close(): Promise<void> } | undefined;
  // Count peers before negotiation starts, reserving capacity so concurrent offers cannot exceed the limit.
  const peers = new Set<WebRtcEndpoint>();
  let closing: Promise<void> | undefined;
  let stopped = false;
  /** Revoke sessions first and close the ROS context last. No input; returns an idempotent completion Promise. */
  function close(): Promise<void> {
    if (closing) return closing;
    stopped = true;
    closing = (async () => {
      const results = await Promise.allSettled([...peers].map(peer => peer.close()));
      guard?.close();
      // Stop encoders after the peers that were watching them, so no source is restarted on the way out.
      await media?.close();
      // A failed close must not skip cleanup of remaining resources.
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
    const videoScopes = new Set(settings.videoScopes ?? []);
    const videoConfig = parseVideoConfig(settings.configSource, config.topics, settings.maxConfigBytes);
    if (videoConfig !== undefined) {
      media = new MediaService({ config: videoConfig, backends: factories.videoBackends ?? {}, clock: factories.clock,
        schedule: factories.schedule ?? timerSchedule, onError: factories.onError });
      // Prove every configured backend can encode before the listener opens, so an unusable
      // deployment fails at startup instead of when the first viewer arrives.
      await media.probe();
    }
    // Unspecified video scopes deny by default, exactly like publish scopes.
    const watchable = (binding: VideoBinding): boolean => videoScopes.has(binding.access.subscribeScope);
    // Permit only the explicit allowlists granted to the single Bearer credential; unspecified publish scopes deny by default.
    const allowed = (binding: typeof config.topics[number], operation: 'subscribe' | 'publish') => operation === 'subscribe'
      ? subscriptions.has(binding.publicName) : binding.access !== undefined && scopes.has(binding.access.publishScope);
    guard = new CommandGuard({ clock: factories.clock, maxSessions: config.limits.maxPeers,
      maxHandles: settings.routerLimits.maxHandles * config.limits.maxPeers, leaseMs: 250,
      authorize: identity => !stopped && config.topics.some(topic => topic.rosTopic === identity.topic && allowed(topic, 'publish')) });
    adapter = new TopicRosAdapter(registry, backend, factories.onError);
    adapter.start();
    // Create peers only through the handler so authentication failures allocate no ICE/DTLS resources.
    const handler = createSignalingHandler({ ...settings, maxBodyBytes: settings.maxSdpBytes, maxPending: config.limits.maxPeers,
      accept: async offer => {
        if (stopped || peers.size >= config.limits.maxPeers) throw new Error('peer_limit');
        const peer = factories.makePeer();
        const service = media;
        const endpoint = new WebRtcEndpoint({ peer, maxMessageBytes: config.limits.maxMessageBytes,
          maxBufferedBytes: config.limits.maxChannelBufferedBytes, maxSdpBytes: settings.maxSdpBytes, timeoutMs: settings.timeoutMs,
          onError: factories.onError, onClosed: () => { peers.delete(endpoint); },
          video: service && { maxSlots: service.maxSlots, addSlot: offered => factories.makeVideoSlot!(peer, offered) },
          // Apply the remote receive limit to the router envelope limit as well.
          makeRouter: (send, maxMessageBytes, onClosed, slots) => new SessionRouter({ config: { ...config, limits: { ...config.limits, maxMessageBytes } },
            bindings: registry, guard: guard!, ros: adapter!, epoch: randomUUID(), clock: factories.clock, send,
            authorize: allowed, limits: settings.routerLimits, onClosed,
            video: service && { slots, access: {
              maxSlots: service.maxSlots,
              /** List tracks this credential may watch. No input; returns catalog entries. */
              catalog: () => service.catalog(watchable),
              /** Check watch permission. Input: track name; returns whether the scope was granted. */
              authorize: (track: string) => videoConfig!.tracks.some(binding => binding.name === track && watchable(binding)),
              /** Report what profile a track produces. Input: track name; returns its profile_idc. */
              profileIdc: (track: string) => PROFILE_IDC[videoConfig!.tracks.find(binding => binding.name === track)!.encoder.profile],
              /** Start delivering to a viewer. Inputs: track name and viewer; returns void. */
              attach: (track, viewer) => service.attach(track, viewer),
              /** Stop delivering to a viewer. Inputs: track name and viewer; returns void. */
              detach: (track, viewer) => service.detach(track, viewer),
              /** Forward a decoder's keyframe request. Input: track name; returns void. */
              requestKeyframe: (track: string) => service.requestKeyframe(track),
            } } }) });
        peers.add(endpoint);
        return endpoint.answer(offer);
      },
    });
    server = await factories.listen(handler);
    // Diagnostics stay internal: the unauthenticated health endpoint must not describe the host.
    return { config, registry, close, peerCount: () => peers.size, videoDiagnostics: () => media?.diagnostics ?? [] };
  } catch (error) { await close(); throw error; }
}
