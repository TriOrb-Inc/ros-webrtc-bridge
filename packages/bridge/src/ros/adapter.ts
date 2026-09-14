import type { RosAdapter, RosBackend, RosRegistration } from './types.js';
export type { RosAdapter, RosBackend, RosRegistration } from './types.js';

/** Fix entities at startup and lend only listeners to sessions. Inputs: registry, backend; output: adapter. */
export class TopicRosAdapter implements RosAdapter {
  private readonly registrations = new Map<string, RosRegistration>();
  private readonly listeners = new Map<string, Set<(native: unknown) => void>>();
  private readonly publishers = new Map<string, { publish(native: unknown): void }>();
  // Closing is irreversible. Discard the entire context after partial startup failure rather than reusing it.
  private state: 'new' | 'running' | 'closed' = 'new';

  /** Own validated configuration and the backend. Inputs: [{binding,codec}],backend,onError; output: a new adapter. */
  constructor(registry: readonly RosRegistration[], private readonly backend: RosBackend, private readonly onError: (error: unknown) => void) {
    for (const entry of registry) {
      if (this.registrations.has(entry.binding.publicName)) throw new Error('duplicate_ros_registration');
      this.registrations.set(entry.binding.publicName, entry);
      this.listeners.set(entry.binding.publicName, new Set());
    }
  }

  /** Create fixed entities and start spinning. No input; returns void. Partial failures clean up and rethrow. */
  start(): void {
    if (this.state !== 'new') throw new Error('ros_adapter_not_new');
    const subscriptions = new Map<string, string[]>();
    try {
      for (const [name, entry] of this.registrations) {
        const binding = entry.binding;
        // Share native entities by output name, type, and QoS; never share across directions.
        const key = entityKey(entry);
        if (binding.direction === 'web_to_ros') {
          if (!this.publishers.has(key)) this.publishers.set(key, this.backend.createPublisher(binding.rosType, binding.rosTopic, binding.rosQos));
        } else {
          // Receive ROS samples from startup regardless of listener count. No history cache is kept here.
          const existing = subscriptions.get(key);
          if (existing) existing.push(name);
          else {
            const aliases = [name];
            subscriptions.set(key, aliases);
            this.backend.createSubscription(binding.rosType, binding.rosTopic, binding.rosQos, (native) => {
              for (const alias of aliases) this.receive(alias, native);
            });
          }
        }
      }
      this.state = 'running';
      this.backend.spin();
    } catch (error) {
      // Expose cleanup errors together with the original startup failure for diagnosis.
      try { this.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'ros_start_cleanup_failed'); }
      throw error;
    }
  }

  /** Add a logical listener to a ROS-to-Web binding. Inputs: '/out',callback; returns an idempotent unsubscribe function. */
  subscribe(publicName: string, callback: (native: unknown) => void): () => void {
    this.registration(publicName, 'ros_to_web');
    const listeners = this.listeners.get(publicName)!;
    listeners.add(callback);
    // Keep the shared subscription alive so other sessions and the entity count are unaffected.
    return () => { listeners.delete(callback); };
  }

  /** Revalidate native values and publish synchronously. Inputs: '/in',{data:'hello'}; returns void. ROS failures propagate. */
  publish(publicName: string, native: unknown): void {
    const entry = this.registration(publicName, 'web_to_ros');
    const binding = entry.binding;
    const key = entityKey(entry);
    // A codec round trip creates an independent native tree. Command nonfinite-value policy belongs to the registry codec.
    const normalized = entry.codec.decode(entry.codec.encode(native));
    this.publishers.get(key)!.publish(normalized);
  }

  /** Release process-owned context and listeners. No input; returns void. Safe to call repeatedly. */
  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    // Disable callbacks after closure before native teardown.
    for (const listeners of this.listeners.values()) listeners.clear();
    this.listeners.clear();
    this.publishers.clear();
    this.backend.close();
  }

  /** Validate direction, existence, and lifetime at the boundary. Inputs: '/out','ros_to_web'; returns registration information. */
  private registration(name: string, direction: string): RosRegistration {
    if (this.state !== 'running') throw new Error('ros_adapter_not_running');
    const entry = this.registrations.get(name);
    if (!entry || entry.binding.direction !== direction) throw new Error('ros_binding_denied');
    return entry;
  }

  /** Validate external ROS input and copy it for each listener. Inputs: '/out',{data:'x'}; returns void. */
  private receive(name: string, native: unknown): void {
    if (this.state !== 'running') return;
    try {
      const codec = this.registrations.get(name)!.codec;
      const wire = codec.encode(native);
      const listeners = this.listeners.get(name)!;
      // Notify listeners separately so one failure cannot stop delivery to other peers.
      for (const callback of [...listeners]) {
        if (!listeners.has(callback)) continue;
        try { callback(codec.decode(wire)); } catch (error) { this.onError(error); }
      }
    } catch (error) { this.onError(error); }
  }
}

/** Build entity-sharing keys from semantic QoS. Input: registration; output: JSON key with fixed field order. */
function entityKey(entry: RosRegistration): string {
  const { rosTopic, rosType, rosQos } = entry.binding;
  return JSON.stringify([rosTopic, rosType, rosQos.history, rosQos.depth, rosQos.reliability, rosQos.durability]);
}
