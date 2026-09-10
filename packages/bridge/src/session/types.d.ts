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
  /** ROS呼出直前に再検証する。入力例: (() => adapter.publish(data))、出力例: void。@param publish 同期ROS処理 @returns なし */
  publish(publish: () => void): void;
}

export interface HandleState {
  readonly identity: CommandIdentity;
  readonly leaseMs: number;
  lease: Lease | undefined;
  received: bigint;
  published: bigint;
}
