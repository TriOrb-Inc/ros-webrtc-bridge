export interface CommandIdentity {
  readonly sessionId: string;
  readonly epoch: string;
  readonly handle: string;
  readonly topic: string;
}

export interface CommandRequest {
  readonly sessionId: string;
  readonly epoch: string;
  readonly handle: string;
  readonly leaseId: string;
  readonly seq: string;
}

export interface GuardOptions {
  readonly clock: () => number;
  readonly authorize: (identity: CommandIdentity, phase: 'open' | 'arm' | 'receive' | 'publish') => boolean;
  readonly maxSessions: number;
  readonly maxHandles: number;
  readonly leaseMs: number;
}

export interface Lease {
  readonly id: string;
  readonly expiresAt: number;
}

export interface CommandTicket {
  /** Revalidate immediately before the ROS call. Input: synchronous ROS operation, e.g. (() => adapter.publish(data)); returns void. */
  publish(publish: () => void): void;
}

export interface HandleState {
  readonly identity: CommandIdentity;
  readonly leaseMs: number;
  lease: Lease | undefined;
  received: bigint;
  published: bigint;
}
