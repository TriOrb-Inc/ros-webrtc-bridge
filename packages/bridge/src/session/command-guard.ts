import { randomUUID } from 'node:crypto';
import { identifier, positiveLimit, sequence } from './validation.js';
import type { CommandIdentity, CommandRequest, CommandTicket, GuardOptions, HandleState, Lease } from './types.js';

/** Manage command authority through the synchronous ROS publish boundary. Provides no downstream DDS or controller delivery guarantees. */
export class CommandGuard {
  private readonly options: GuardOptions;
  private readonly prefix = randomUUID();
  private nextId = 0n;
  private lastTime = 0;
  // Bound session and handle registrations; remove owned resources on revocation.
  private readonly sessions = new Map<string, string>();
  private readonly handles = new Map<string, HandleState>();
  private closed = false;

  /** Fix configuration. Input: clock, authorization, and limits, e.g. {leaseMs:250,...}; returns a new guard. */
  constructor(options: GuardOptions) {
    positiveLimit(options.maxSessions);
    positiveLimit(options.maxHandles);
    positiveLimit(options.leaseMs);
    // Copy external options so later mutation cannot change boundary conditions.
    if (typeof options.clock !== 'function' || typeof options.authorize !== 'function') throw new Error('invalid_callback');
    this.options = { ...options };
    this.now();
  }

  /** Register a new connection. Input: connection epoch, e.g. 'epoch-1'; returns a nonreused session ID. */
  openSession(epoch: string): string {
    this.assertOpen();
    identifier(epoch);
    if (this.sessions.size >= this.options.maxSessions) throw new Error('session_limit');
    // IDs distinguish old packets across instances and reconnects within the same guard.
    const id = this.id();
    this.sessions.set(id, epoch);
    return id;
  }

  /** Register a resolved output topic. Inputs: owner session, remapped full topic name, optional topic lease duration defaulting to the constructor value; returns a handle. */
  openHandle(sessionId: string, topic: string, leaseMs: number = this.options.leaseMs): string {
    this.assertOpen();
    positiveLimit(leaseMs);
    const epoch = this.sessions.get(sessionId);
    if (epoch === undefined) throw new Error('unknown_session');
    if (typeof topic !== 'string' || !/^\/(?:[A-Za-z_][A-Za-z0-9_]*\/)*[A-Za-z_][A-Za-z0-9_]*$/.test(topic) || topic.length > 247) throw new Error('invalid_topic');
    // Authorize before registering a handle so failed authorization leaves no resources behind.
    const identity = Object.freeze({ sessionId, epoch, handle: this.id(), topic });
    this.authorize(identity, 'open');
    if (!this.sessions.has(sessionId)) throw new Error('unknown_session');
    if (this.handles.size >= this.options.maxHandles) throw new Error('handle_limit');
    this.handles.set(identity.handle, { identity, leaseMs, lease: undefined, received: -1n, published: -1n });
    return identity.handle;
  }

  /** Issue a time-limited exclusive-writer lease. Inputs: owner session and publisher handle; returns a lease such as {id,expiresAt:250}. */
  arm(sessionId: string, handle: string): Lease {
    let state = this.owned(sessionId, handle);
    this.authorize(state.identity, 'arm');
    state = this.owned(sessionId, handle);
    const now = this.now();
    // An active lease in another session owns the output topic exclusively even across different aliases.
    for (const candidate of this.handles.values()) {
      if (candidate.identity.topic === state.identity.topic && candidate.identity.sessionId !== sessionId && candidate.lease !== undefined && now < candidate.lease.expiresAt) throw new Error('writer_busy');
    }
    const expiresAt = now + state.leaseMs;
    if (expiresAt > Number.MAX_SAFE_INTEGER) throw new Error('invalid_clock');
    // Invalidate earlier leases when rearming, including other handles in the same session.
    for (const candidate of this.handles.values()) {
      if (candidate.identity.topic === state.identity.topic) candidate.lease = undefined;
    }
    state.lease = Object.freeze({ id: this.id(), expiresAt });
    return state.lease;
  }

  /** Validate at receipt and return a single-use ticket. Input: wire identity fields, e.g. {seq:'1',...}; returns a publish reservation. */
  prepare(request: CommandRequest): CommandTicket {
    const saved = Object.freeze({ ...request });
    const seq = sequence(saved.seq);
    const state = this.validate(saved, 'receive');
    if (seq <= state.received) throw new Error('stale_sequence');
    // Never roll back received sequence state after callback failure, preventing command re-execution.
    state.received = seq;
    let consumed = false;
    return Object.freeze({
      /** Detect revocation while waiting. Input: synchronous publish side effect; invokes it once and returns void. */
      publish: (publish: () => void): void => {
        if (consumed) throw new Error('ticket_consumed');
        consumed = true;
        if (typeof publish !== 'function') throw new Error('invalid_callback');
        // Do not insert await or external hooks between this revalidation and the synchronous ROS call.
        const current = this.validate(saved, 'publish');
        if (seq <= current.published) throw new Error('stale_sequence');
        current.published = seq;
        publish();
      },
    });
  }

  /** Discard a handle and lease. Inputs: owner session and target handle; returns void. */
  closeHandle(sessionId: string, handle: string): void {
    this.owned(sessionId, handle);
    this.handles.delete(handle);
  }

  /** Discard all handles of a revoked session. Input: session ID; returns void. */
  revokeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    // Preserve other sessions' handles; release writer authority with the owner's resources.
    for (const [id, state] of this.handles) {
      if (state.identity.sessionId === sessionId) this.handles.delete(id);
    }
  }

  /** Discard all resources and forbid reuse. No input; returns void. */
  close(): void {
    this.closed = true;
    this.sessions.clear();
    this.handles.clear();
  }

  /** Observe registration counts. No input; returns current counts such as {sessions:1,handles:1}. */
  stats(): { sessions: number; handles: number } {
    return { sessions: this.sessions.size, handles: this.handles.size };
  }

  /** Validate ownership. Inputs: owner session and target handle; returns registration state. */
  private owned(sessionId: string, handle: string): HandleState {
    this.assertOpen();
    const state = this.handles.get(handle);
    if (state === undefined || state.identity.sessionId !== sessionId) throw new Error('invalid_owner');
    return state;
  }

  /** Recheck ownership and expiry after a hook. Inputs: command request and validation phase, e.g. (request,'publish'); returns state. */
  private validate(request: CommandRequest, phase: 'receive' | 'publish'): HandleState {
    let state = this.owned(request.sessionId, request.handle);
    this.authorize(state.identity, phase);
    state = this.owned(request.sessionId, request.handle);
    // Do not use stale validation results if a hook revokes or rearms ownership.
    if (request.epoch !== state.identity.epoch) throw new Error('invalid_epoch');
    if (state.lease === undefined || request.leaseId !== state.lease.id) throw new Error('invalid_lease');
    if (this.now() >= state.lease.expiresAt) throw new Error('lease_expired');
    return state;
  }

  /** Authorize with default deny. Inputs: configured identity and operation phase, e.g. (identity,'arm'); returns void. */
  private authorize(identity: CommandIdentity, phase: 'open' | 'arm' | 'receive' | 'publish'): void {
    if (this.options.authorize(identity, phase) !== true) throw new Error('unauthorized');
  }

  /** Validate the monotonic clock. No input; returns monotonic milliseconds, e.g. 100. */
  private now(): number {
    const value = this.options.clock();
    if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER || value < this.lastTime) throw new Error('invalid_clock');
    this.lastTime = value;
    return value;
  }

  /** Reject operations after closure. An open guard returns void. */
  private assertOpen(): void {
    if (this.closed) throw new Error('guard_closed');
  }

  /** Issue a nonreused identifier. No input; returns an ID such as prefix:1. */
  private id(): string {
    this.nextId += 1n;
    return `${this.prefix}:${this.nextId}`;
  }
}
