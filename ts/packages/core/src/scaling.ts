// The horizontal-scale ports (docs/SCALING.md). Like the persistence ports in
// `stores.ts`, each is an interface with an in-memory default, so a single-node
// run needs nothing and a fleet swaps implementations in. Passing neither option
// keeps mekik's original process-local behaviour byte-for-byte — scaling is
// entirely opt-in.
//
// Two concerns become fleet-aware:
//   • TurnLock  - the per-conversation single-writer lease. On one node the
//     engine's `live.turn` already guarantees a single writer; a Redis lease
//     extends that guarantee across nodes.
//   • Backplane - cross-node fan-out. On one node the engine fans out directly
//     from `live.connections`; a Redis Pub/Sub backplane carries frames to the
//     other nodes holding tabs of the same conversation.

import type { OutgoingFrame } from "./protocol.ts";

// ── turn lock ─────────────────────────────────────────────────────────────────

/** A held per-conversation turn lease. Renewed while a long run streams; released when it ends. */
export interface TurnLease {
    /** Extend the lease TTL (a Redis lock heartbeat; a no-op for the local lock). */
    renew(): Promise<void>;
    /** Give up the lease so the next turn — here or on another node — can proceed. */
    release(): Promise<void>;
}

/**
 * The distributed turn lock. `acquire` returns a lease, or `null` if another node
 * already holds the turn for this conversation (the caller answers `busy`).
 */
export interface TurnLock {
    acquire(conversationId: string): Promise<TurnLease | null>;
}

/**
 * The single-node default: always grants. The engine's local `live.turn` is the
 * real lock on one node, so this lease is a no-op. A Redis `SET NX PX` lock is the
 * fleet implementation (docs/SCALING.md §The ports).
 */
export class LocalTurnLock implements TurnLock {
    async acquire(_conversationId: string): Promise<TurnLease> {
        return { renew: async () => {}, release: async () => {} };
    }
}

// ── backplane ─────────────────────────────────────────────────────────────────

/** What travels across the backplane: a frame plus the node that produced it (self-delivery guard). */
export interface BackplaneMessage {
    /** The producing node's id — a subscriber skips its own messages. */
    originId: string;
    frame: OutgoingFrame;
}

/** A live backplane subscription for one conversation. */
export interface Subscription {
    unsubscribe(): Promise<void>;
}

/**
 * Cross-node fan-out. The engine `publish`es every dispatched frame; each node
 * holding a tab of that conversation `subscribe`s and re-fans the frame to its
 * own sockets. Persist-once stays with the producing node — the backplane only
 * moves already-recorded frames.
 */
export interface Backplane {
    publish(conversationId: string, message: BackplaneMessage): Promise<void>;
    subscribe(conversationId: string, handler: (message: BackplaneMessage) => void): Promise<Subscription>;
}

/**
 * The single-node default: nothing to carry, because one node's `live.connections`
 * already holds every tab. `publish` drops the message and `subscribe` never
 * delivers, so behaviour is identical to pre-scaling mekik. Redis Pub/Sub is the
 * fleet implementation.
 */
export class NoopBackplane implements Backplane {
    async publish(_conversationId: string, _message: BackplaneMessage): Promise<void> {}
    async subscribe(_conversationId: string, _handler: (message: BackplaneMessage) => void): Promise<Subscription> {
        return { unsubscribe: async () => {} };
    }
}
