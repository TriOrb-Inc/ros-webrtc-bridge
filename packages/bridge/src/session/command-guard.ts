import { randomUUID } from 'node:crypto';
import { identifier, positiveLimit, sequence } from './validation.js';
import type { CommandIdentity, CommandRequest, CommandTicket, GuardOptions, HandleState, Lease } from './types.js';

/** 同期ROS publish直前までのcommand権限を管理する。DDS/controller以降の配送保証は持たない。 */
export class CommandGuard {
  private readonly options: GuardOptions;
  private readonly prefix = randomUUID();
  private nextId = 0n;
  private lastTime = 0;
  // sessionとhandleの登録件数を有限にし、撤回時には所有物を取り除く。
  private readonly sessions = new Map<string, string>();
  private readonly handles = new Map<string, HandleState>();
  private closed = false;

  /** 設定を固定する。入力例: {leaseMs:250,...}、出力例: guard。@param options clock/認可/上限 @returns 新規guard */
  constructor(options: GuardOptions) {
    positiveLimit(options.maxSessions);
    positiveLimit(options.maxHandles);
    positiveLimit(options.leaseMs);
    // 外部の設定オブジェクトの書換えで境界条件が変わらないようコピーする。
    if (typeof options.clock !== 'function' || typeof options.authorize !== 'function') throw new Error('invalid_callback');
    this.options = { ...options };
    this.now();
  }

  /** 新接続を登録する。入力例: ('epoch-1')、出力例: session ID。@param epoch 接続世代 @returns 再利用しないID */
  openSession(epoch: string): string {
    this.assertOpen();
    identifier(epoch);
    if (this.sessions.size >= this.options.maxSessions) throw new Error('session_limit');
    // IDはインスタンスを跨ぐ旧packetと同一guard内の再接続を区別する。
    const id = this.id();
    this.sessions.set(id, epoch);
    return id;
  }

  /** 設定解決済み出力Topicを登録する。入力例: (session,'/cmd_vel',250)、出力例: handle。@param sessionId 所有session @param topic remap後の完全名 @param leaseMs Topic設定の期限幅。省略時はconstructor値 @returns handle */
  openHandle(sessionId: string, topic: string, leaseMs: number = this.options.leaseMs): string {
    this.assertOpen();
    positiveLimit(leaseMs);
    const epoch = this.sessions.get(sessionId);
    if (epoch === undefined) throw new Error('unknown_session');
    if (typeof topic !== 'string' || !/^\/(?:[A-Za-z_][A-Za-z0-9_]*\/)*[A-Za-z_][A-Za-z0-9_]*$/.test(topic) || topic.length > 247) throw new Error('invalid_topic');
    // 認可はhandleを登録する前に完了し、失敗時に資源を残さない。
    const identity = Object.freeze({ sessionId, epoch, handle: this.id(), topic });
    this.authorize(identity, 'open');
    if (!this.sessions.has(sessionId)) throw new Error('unknown_session');
    if (this.handles.size >= this.options.maxHandles) throw new Error('handle_limit');
    this.handles.set(identity.handle, { identity, leaseMs, lease: undefined, received: -1n, published: -1n });
    return identity.handle;
  }

  /** 排他writerの期限付きleaseを発行する。入力例: (session,handle)、出力例: {id,expiresAt:250}。@param sessionId 所有者 @param handle publisher @returns lease */
  arm(sessionId: string, handle: string): Lease {
    let state = this.owned(sessionId, handle);
    this.authorize(state.identity, 'arm');
    state = this.owned(sessionId, handle);
    const now = this.now();
    // aliasが違っても出力Topicが同じなら、他sessionの有効leaseが排他権を持つ。
    for (const candidate of this.handles.values()) {
      if (candidate.identity.topic === state.identity.topic && candidate.identity.sessionId !== sessionId && candidate.lease !== undefined && now < candidate.lease.expiresAt) throw new Error('writer_busy');
    }
    const expiresAt = now + state.leaseMs;
    if (expiresAt > Number.MAX_SAFE_INTEGER) throw new Error('invalid_clock');
    // 同じsessionの別handleも含めて再arm以前のleaseを失効させる。
    for (const candidate of this.handles.values()) {
      if (candidate.identity.topic === state.identity.topic) candidate.lease = undefined;
    }
    state.lease = Object.freeze({ id: this.id(), expiresAt });
    return state.lease;
  }

  /** 受信時に検証し一度だけ実行できるticketを返す。入力例: {seq:'1',...}、出力例: ticket。@param request wire識別情報 @returns publish予約 */
  prepare(request: CommandRequest): CommandTicket {
    const saved = Object.freeze({ ...request });
    const seq = sequence(saved.seq);
    const state = this.validate(saved, 'receive');
    if (seq <= state.received) throw new Error('stale_sequence');
    // 受信seqはcallback失敗でも巻き戻さず、同一commandの再実行を防ぐ。
    state.received = seq;
    let consumed = false;
    return Object.freeze({
      /** 待機中の失効を検知する。入力例: 同期spy、出力例: 呼出1回。@param publish 同期副作用 @returns なし */
      publish: (publish: () => void): void => {
        if (consumed) throw new Error('ticket_consumed');
        consumed = true;
        if (typeof publish !== 'function') throw new Error('invalid_callback');
        // この再検証と同期ROS呼出の間にawaitや外部hookを挟まない。
        const current = this.validate(saved, 'publish');
        if (seq <= current.published) throw new Error('stale_sequence');
        current.published = seq;
        publish();
      },
    });
  }

  /** handleとleaseを破棄する。入力例: (session,handle)、出力例: void。@param sessionId 所有者 @param handle 対象 @returns なし */
  closeHandle(sessionId: string, handle: string): void {
    this.owned(sessionId, handle);
    this.handles.delete(handle);
  }

  /** 撤回済みsessionの全handleを破棄する。入力例: (session)、出力例: void。@param sessionId 対象 @returns なし */
  revokeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    // 他sessionのhandleは維持し、writer権だけを所有物と同時に解放する。
    for (const [id, state] of this.handles) {
      if (state.identity.sessionId === sessionId) this.handles.delete(id);
    }
  }

  /** 全資源を破棄して再利用を禁止する。入力例: ()、出力例: void。@returns なし */
  close(): void {
    this.closed = true;
    this.sessions.clear();
    this.handles.clear();
  }

  /** 件数を観測する。入力例: ()、出力例: {sessions:1,handles:1}。@returns 現在件数 */
  stats(): { sessions: number; handles: number } {
    return { sessions: this.sessions.size, handles: this.handles.size };
  }

  /** 所有者を検証する。入力例: (session,handle)、出力例: state。@param sessionId 所有者 @param handle 対象 @returns 登録状態 */
  private owned(sessionId: string, handle: string): HandleState {
    this.assertOpen();
    const state = this.handles.get(handle);
    if (state === undefined || state.identity.sessionId !== sessionId) throw new Error('invalid_owner');
    return state;
  }

  /** hookの後で所有状態と期限を再確認する。入力例: (request,'publish')、出力例: state。@param request command @param phase 検証段階 @returns 状態 */
  private validate(request: CommandRequest, phase: 'receive' | 'publish'): HandleState {
    let state = this.owned(request.sessionId, request.handle);
    this.authorize(state.identity, phase);
    state = this.owned(request.sessionId, request.handle);
    // hook中に撤回や再armがあっても古いstateの検証結果を使わない。
    if (request.epoch !== state.identity.epoch) throw new Error('invalid_epoch');
    if (state.lease === undefined || request.leaseId !== state.lease.id) throw new Error('invalid_lease');
    if (this.now() >= state.lease.expiresAt) throw new Error('lease_expired');
    return state;
  }

  /** default denyで認可する。入力例: (identity,'arm')、出力例: void。@param identity 設定済み識別情報 @param phase 操作 @returns なし */
  private authorize(identity: CommandIdentity, phase: 'open' | 'arm' | 'receive' | 'publish'): void {
    if (this.options.authorize(identity, phase) !== true) throw new Error('unauthorized');
  }

  /** 単調clockを検証する。入力例: clockが100、出力例: 100。@returns 単調millisecond */
  private now(): number {
    const value = this.options.clock();
    if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER || value < this.lastTime) throw new Error('invalid_clock');
    this.lastTime = value;
    return value;
  }

  /** 閉鎖後の操作を拒否する。入力例: open状態、出力例: void。@returns なし */
  private assertOpen(): void {
    if (this.closed) throw new Error('guard_closed');
  }

  /** 再利用しない識別子を発行する。入力例: ()、出力例: prefix:1。@returns ID */
  private id(): string {
    this.nextId += 1n;
    return `${this.prefix}:${this.nextId}`;
  }
}
