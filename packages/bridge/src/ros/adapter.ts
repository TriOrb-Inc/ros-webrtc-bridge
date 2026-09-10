import type { RosAdapter, RosBackend, RosRegistration } from './types.js';
export type { RosAdapter, RosBackend, RosRegistration } from './types.js';

/** entityを起動時に固定し、sessionにはlistenerだけを貸す。入力例: registry,backend。出力: adapter。 */
export class TopicRosAdapter implements RosAdapter {
  private readonly registrations = new Map<string, RosRegistration>();
  private readonly listeners = new Map<string, Set<(native: unknown) => void>>();
  private readonly publishers = new Map<string, { publish(native: unknown): void }>();
  // 閉鎖は一方向。起動途中の失敗も再利用せず全contextを破棄する。
  private state: 'new' | 'running' | 'closed' = 'new';

  /** 検証済み設定とbackendを所有する。入力: [{binding,codec}],backend,onError。出力: 新adapter。 */
  constructor(registry: readonly RosRegistration[], private readonly backend: RosBackend, private readonly onError: (error: unknown) => void) {
    for (const entry of registry) {
      if (this.registrations.has(entry.binding.publicName)) throw new Error('duplicate_ros_registration');
      this.registrations.set(entry.binding.publicName, entry);
      this.listeners.set(entry.binding.publicName, new Set());
    }
  }

  /** 固定entityを生成してspinを開始する。入力: なし。出力: void。途中失敗はcleanup後再throw。 */
  start(): void {
    if (this.state !== 'new') throw new Error('ros_adapter_not_new');
    const subscriptions = new Map<string, string[]>();
    try {
      for (const [name, entry] of this.registrations) {
        const binding = entry.binding;
        // native entityの共有keyは出力名・型・QoS。方向が異なるentityは共有しない。
        const key = entityKey(entry);
        if (binding.direction === 'web_to_ros') {
          if (!this.publishers.has(key)) this.publishers.set(key, this.backend.createPublisher(binding.rosType, binding.rosTopic, binding.rosQos));
        } else {
          // listener数と無関係に起動時からROSを受信する。履歴cacheはここには持たない。
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
      // cleanupの例外も隠さず、元の起動失敗と合わせて診断可能にする。
      try { this.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'ros_start_cleanup_failed'); }
      throw error;
    }
  }

  /** ROS→Web bindingへlogical listenerを追加する。入力: '/out',callback。出力: idempotent解除関数。 */
  subscribe(publicName: string, callback: (native: unknown) => void): () => void {
    this.registration(publicName, 'ros_to_web');
    const listeners = this.listeners.get(publicName)!;
    listeners.add(callback);
    // shared subscriptionは解除しないため他sessionの受信とentity数に影響しない。
    return () => { listeners.delete(callback); };
  }

  /** native値を再検証して同期publishする。入力: '/in',{data:'hello'}。出力: void。ROS失敗は伝播する。 */
  publish(publicName: string, native: unknown): void {
    const entry = this.registration(publicName, 'web_to_ros');
    const binding = entry.binding;
    const key = entityKey(entry);
    // codecの往復で独立したnative treeを生成する。command非有限policyはregistry codecへ設定する。
    const normalized = entry.codec.decode(entry.codec.encode(native));
    this.publishers.get(key)!.publish(normalized);
  }

  /** process所有のcontextとlistenerを解放する。入力: なし。出力: void。複数回呼んでも安全。 */
  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    // 閉鎖後callbackを無効にしてからnative teardownへ進む。
    for (const listeners of this.listeners.values()) listeners.clear();
    this.listeners.clear();
    this.publishers.clear();
    this.backend.close();
  }

  /** 方向・存在・寿命を境界検証する。入力: '/out','ros_to_web'。出力: 登録情報。 */
  private registration(name: string, direction: string): RosRegistration {
    if (this.state !== 'running') throw new Error('ros_adapter_not_running');
    const entry = this.registrations.get(name);
    if (!entry || entry.binding.direction !== direction) throw new Error('ros_binding_denied');
    return entry;
  }

  /** 外部ROS入力を検証しlistenerごとにcopyする。入力: '/out',{data:'x'}。出力: void。 */
  private receive(name: string, native: unknown): void {
    if (this.state !== 'running') return;
    try {
      const codec = this.registrations.get(name)!.codec;
      const wire = codec.encode(native);
      const listeners = this.listeners.get(name)!;
      // 一人のlistener失敗が他のpeerへの配送を止めないよう個別に通知する。
      for (const callback of [...listeners]) {
        if (!listeners.has(callback)) continue;
        try { callback(codec.decode(wire)); } catch (error) { this.onError(error); }
      }
    } catch (error) { this.onError(error); }
  }
}

/** semantic QoSでentity共有keyを作る。入力: registration。出力: 固定順序JSON key。 */
function entityKey(entry: RosRegistration): string {
  const { rosTopic, rosType, rosQos } = entry.binding;
  return JSON.stringify([rosTopic, rosType, rosQos.history, rosQos.depth, rosQos.reliability, rosQos.durability]);
}
