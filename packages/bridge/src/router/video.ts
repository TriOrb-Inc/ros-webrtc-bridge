import { fields, textField } from './protocol.js';
import type { VideoSlot } from '../transport/types.js';
import type { VideoState, Viewer } from '../media/types.js';
import type { Wire } from './types.js';

/** What one peer's router needs from the media plane. Keeps werift and GStreamer out of the router. */
export interface VideoAccess {
  readonly maxSlots: number;
  catalog(): { track: string; codec: string }[];
  authorize(track: string): boolean;
  attach(track: string, viewer: Viewer): void;
  detach(track: string, viewer: Viewer): void;
  requestKeyframe(track: string): void;
}

/**
 * Video control operations for one peer.
 *
 * A negotiated `m=video` section is only a pipe; watching is an explicit act. Binding a slot to a
 * track is permanent for the session: reusing a mid for a different source would change resolution
 * and parameter sets underneath a decoder that was never told to expect it.
 */
export class VideoRouter {
  private readonly bound = new Map<string, { slot: VideoSlot; viewer: Viewer; watching: boolean }>();
  private readonly free: VideoSlot[];

  /**
   * Bind negotiated slots to one peer's session.
   * @param access Media plane restricted to this peer's authorization.
   * @param slots Slots negotiated by the transport, in m-line order.
   * @param send Queue a control envelope, e.g. an asynchronous `video.state` event.
   */
  constructor(private readonly access: VideoAccess, slots: readonly VideoSlot[], private readonly send: (wire: Wire) => void) {
    this.free = [...slots];
  }

  /** List tracks this peer may watch. No input; returns catalog entries, or undefined when none are allowed. */
  catalog(): { track: string; codec: string }[] | undefined {
    const tracks = this.access.catalog();
    // Omit the key entirely rather than sending an empty list, so a DataChannel-only deployment
    // produces exactly the welcome envelope it always did.
    return tracks.length === 0 ? undefined : tracks;
  }

  /**
   * Execute one video control operation.
   * @param wire Envelope whose `op` starts with `video.`, e.g. `{op:'video.subscribe',id:'r1',track:'front'}`.
   * @param id Correlation identifier already validated by the caller.
   * @returns The response envelope, e.g. `{op:'video.subscribed',mid:'1'}`. Unknown operations throw.
   */
  operation(wire: Wire, id: string): Wire {
    if (wire.op === 'video.subscribe') {
      fields(wire, ['id', 'track']);
      const track = textField(wire, 'track');
      if (!this.access.authorize(track)) throw new Error('unauthorized');
      const entry = this.bind(track);
      // Re-subscribing to a track this peer already watches is idempotent, not a second viewer.
      if (!entry.watching) { entry.watching = true; this.access.attach(track, entry.viewer); }
      return { v: 1, op: 'video.subscribed', id, track, mid: entry.slot.mid };
    }
    if (wire.op === 'video.unsubscribe') {
      fields(wire, ['id', 'mid']);
      const mid = textField(wire, 'mid');
      const track = [...this.bound].find(([, entry]) => entry.slot.mid === mid)?.[0];
      if (track === undefined) throw new Error('unknown_video_slot');
      this.release(track);
      return { v: 1, op: 'video.unsubscribed', id };
    }
    throw new Error('unknown_operation');
  }

  /** Detach every viewer. No input; returns void. Called when the peer closes or its session is revoked. */
  close(): void {
    for (const track of [...this.bound.keys()]) this.release(track);
  }

  /** Re-evaluate authorization for every watched track. No input; returns void. Losing access detaches. */
  revalidate(): void {
    for (const [track, entry] of this.bound) {
      if (entry.watching && !this.access.authorize(track)) {
        this.release(track);
        entry.viewer.state('failed');
      }
    }
  }

  /** Bind a slot to a track, or reuse the one already bound. Input: track name; returns the binding. */
  private bind(track: string): { slot: VideoSlot; viewer: Viewer; watching: boolean } {
    const existing = this.bound.get(track);
    if (existing !== undefined) return existing;
    const slot = this.free.shift();
    if (slot === undefined) throw new Error('video_slot_limit');
    const entry = { slot, watching: false, viewer: this.viewer(track, slot) };
    // A decoder recovering from loss asks the sender, not the source; forward it to the encoder.
    slot.onKeyframeRequest(() => { if (entry.watching) this.access.requestKeyframe(track); });
    this.bound.set(track, entry);
    return entry;
  }

  /** Stop delivering a track while keeping its slot bound. Input: track name; returns void. */
  private release(track: string): void {
    const entry = this.bound.get(track)!;
    if (!entry.watching) return;
    entry.watching = false;
    this.access.detach(track, entry.viewer);
  }

  /** Build the sink handed to the media plane. Inputs: track name and slot; returns a viewer. */
  private viewer(track: string, slot: VideoSlot): Viewer {
    return {
      /** Hand one RTP packet to the peer. Input: complete packet; returns void. */
      write: (packet: Buffer) => slot.write(packet),
      /** Report a lifecycle change without disclosing why. Input: state; returns void. */
      state: (state: VideoState) => this.send({ v: 1, op: 'video.state', track, mid: slot.mid, state }),
    };
  }
}
