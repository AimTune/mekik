/**
 * Redis horizontal-scale backends for mekik (docs/SCALING.md).
 *
 * Two ports become fleet-aware, and this package supplies the Redis
 * implementation of each — drop them into `mekik({ turnLock, backplane })` and a
 * single-node app becomes a fleet with no engine changes:
 *
 * ```ts
 * import { Redis } from "ioredis";
 * import { mekik } from "@mekik/core";
 * import { RedisTurnLock, RedisBackplane } from "@mekik/redis";
 *
 * const redis = new Redis(process.env.REDIS_URL!);
 * const app = mekik({
 *     graph,
 *     turnLock: new RedisTurnLock(redis),   // SET NX PX single-writer lease
 *     backplane: new RedisBackplane(redis),  // Pub/Sub cross-node fan-out
 * });
 * ```
 *
 * Bring your own `ioredis` connection (it is a peer dependency). The turn lock
 * uses one connection; the backplane `duplicate()`s it for its subscriber, because
 * a connection in subscribe mode cannot also issue `PUBLISH`.
 */

import { randomBytes } from "node:crypto";

import type {
    Backplane,
    BackplaneMessage,
    Subscription,
    TurnLease,
    TurnLock,
} from "@mekik/core";

/**
 * The subset of the `ioredis` client surface these backends use. Typed
 * structurally so the package does not hard-depend on a specific ioredis version
 * (or force one on you) — any client with these methods works.
 */
export interface RedisClient {
    set(
        key: string,
        value: string,
        px: "PX",
        ttlMs: number,
        nx: "NX",
    ): Promise<string | null>;
    eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
    publish(channel: string, message: string): Promise<number>;
    subscribe(...channels: string[]): Promise<unknown>;
    unsubscribe(...channels: string[]): Promise<unknown>;
    on(event: "message", listener: (channel: string, message: string) => void): unknown;
    off(event: "message", listener: (channel: string, message: string) => void): unknown;
    /** Open a second connection (the backplane needs one for subscribe mode). */
    duplicate(): RedisClient;
    quit(): Promise<unknown>;
}

// ── turn lock ─────────────────────────────────────────────────────────────────

/** Token-checked so a node only ever renews or releases a lease it still holds. */
const RENEW_LUA =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE_LUA =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export interface RedisTurnLockOptions {
    /** Key prefix, so several apps can share one Redis. Default `"mekik"`. */
    keyPrefix?: string;
    /**
     * Lease TTL in ms — how long the lock survives without a heartbeat. Must exceed
     * a turn's worst case (a crashed owner's lock expires after this). Default 30000.
     */
    ttlMs?: number;
    /**
     * Heartbeat interval in ms. The held lease renews itself this often so a long
     * streaming run never lets the TTL lapse. Default `ttlMs / 3`.
     */
    heartbeatMs?: number;
    /** Called if a heartbeat discovers the lease was lost (TTL lapsed or stolen). */
    onLost?: (conversationId: string) => void;
}

/**
 * The distributed turn lock (docs/SCALING.md §The ports). `acquire` does a
 * `SET key token NX PX ttl`; on success it returns a lease that heartbeats its own
 * TTL until released, so the engine never has to. `null` means another node holds
 * the turn — the caller answers `busy`. Release is a token-checked `DEL`, so a
 * node can only free a lease it still owns.
 */
export class RedisTurnLock implements TurnLock {
    private readonly redis: RedisClient;
    private readonly prefix: string;
    private readonly ttlMs: number;
    private readonly heartbeatMs: number;
    private readonly onLost: ((conversationId: string) => void) | undefined;

    constructor(redis: RedisClient, options: RedisTurnLockOptions = {}) {
        this.redis = redis;
        this.prefix = options.keyPrefix ?? "mekik";
        this.ttlMs = options.ttlMs ?? 30_000;
        this.heartbeatMs = options.heartbeatMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3));
        this.onLost = options.onLost;
    }

    private key(conversationId: string): string {
        return `${this.prefix}:lock:${conversationId}`;
    }

    /**
     * Acquire the per-conversation turn via `SET key token NX PX ttl`.
     *
     * @param conversationId - The conversation whose turn to claim.
     * @returns A {@link TurnLease} that heartbeats its own TTL until released, or
     * `null` if another node already holds the turn (the caller answers `busy`).
     *
     * @example
     * ```ts
     * const lease = await turnLock.acquire(conversationId);
     * if (!lease) return sendBusy();
     * try { await runTurn(); } finally { await lease.release(); }
     * ```
     */
    async acquire(conversationId: string): Promise<TurnLease | null> {
        const key = this.key(conversationId);
        const token = randomBytes(16).toString("base64url");

        const ok = await this.redis.set(key, token, "PX", this.ttlMs, "NX");
        if (ok !== "OK") return null; // another node owns the turn

        let released = false;
        const renew = async (): Promise<void> => {
            const held = await this.redis.eval(RENEW_LUA, 1, key, token, this.ttlMs);
            // `pexpire` returns 1 on success; 0 means the key was gone (lease lost).
            if (held === 0 && !released) this.onLost?.(conversationId);
        };

        // The lease keeps itself alive: the engine acquires once and holds through a
        // run that may stream for many seconds, without calling renew() itself.
        const timer = setInterval(() => {
            void renew().catch(() => {});
        }, this.heartbeatMs);
        // Don't let the heartbeat keep the process alive on its own.
        (timer as { unref?: () => void }).unref?.();

        return {
            renew,
            release: async () => {
                if (released) return;
                released = true;
                clearInterval(timer);
                await this.redis.eval(RELEASE_LUA, 1, key, token);
            },
        };
    }
}

// ── backplane ─────────────────────────────────────────────────────────────────

export interface RedisBackplaneOptions {
    /** Channel prefix, so several apps can share one Redis. Default `"mekik"`. */
    keyPrefix?: string;
    /**
     * The connection used for `subscribe`. A client in subscribe mode cannot
     * `PUBLISH`, so by default the publisher connection is `duplicate()`d. Pass your
     * own dedicated subscriber connection to skip that.
     */
    subscriber?: RedisClient;
}

/**
 * Cross-node fan-out over Redis Pub/Sub (docs/SCALING.md §The ports). The engine
 * `publish`es every dispatched frame; every node holding a tab of that
 * conversation `subscribe`s and re-fans it to its own sockets. Persist-once stays
 * with the producing node — the backplane only moves already-recorded frames, and
 * the engine skips its own by `originId`.
 *
 * One subscriber connection is multiplexed across every conversation: channels are
 * reference-counted, so the Nth `subscribe` on a conversation shares the one Redis
 * `SUBSCRIBE`, and the last `unsubscribe` tears it down.
 */
export class RedisBackplane implements Backplane {
    private readonly pub: RedisClient;
    private readonly sub: RedisClient;
    private readonly ownsSub: boolean;
    private readonly prefix: string;
    /** channel → the handlers registered on this node for that conversation. */
    private readonly handlers = new Map<string, Set<(message: BackplaneMessage) => void>>();
    private listening = false;

    constructor(redis: RedisClient, options: RedisBackplaneOptions = {}) {
        this.pub = redis;
        this.prefix = options.keyPrefix ?? "mekik";
        this.ownsSub = options.subscriber === undefined;
        this.sub = options.subscriber ?? redis.duplicate();
    }

    private channel(conversationId: string): string {
        return `${this.prefix}:bp:${conversationId}`;
    }

    private readonly onMessage = (channel: string, payload: string): void => {
        const set = this.handlers.get(channel);
        if (!set || set.size === 0) return;
        let message: BackplaneMessage;
        try {
            message = JSON.parse(payload) as BackplaneMessage;
        } catch {
            return; // ignore anything that isn't a well-formed BackplaneMessage
        }
        for (const handler of set) handler(message);
    };

    /** Broadcast an already-recorded frame to every other node on this conversation. */
    async publish(conversationId: string, message: BackplaneMessage): Promise<void> {
        await this.pub.publish(this.channel(conversationId), JSON.stringify(message));
    }

    /**
     * Subscribe this node to a conversation's frames. The returned {@link Subscription}
     * removes only this handler; the underlying Redis `SUBSCRIBE` is reference-counted,
     * so it is torn down when the last handler on the conversation unsubscribes.
     */
    async subscribe(
        conversationId: string,
        handler: (message: BackplaneMessage) => void,
    ): Promise<Subscription> {
        if (!this.listening) {
            this.sub.on("message", this.onMessage);
            this.listening = true;
        }

        const channel = this.channel(conversationId);
        let set = this.handlers.get(channel);
        if (set === undefined) {
            set = new Set();
            this.handlers.set(channel, set);
            await this.sub.subscribe(channel); // first handler on this conversation
        }
        set.add(handler);

        let removed = false;
        return {
            unsubscribe: async () => {
                if (removed) return;
                removed = true;
                const current = this.handlers.get(channel);
                if (!current) return;
                current.delete(handler);
                if (current.size === 0) {
                    this.handlers.delete(channel);
                    await this.sub.unsubscribe(channel); // last handler left
                }
            },
        };
    }

    /**
     * Close the subscriber connection this backplane opened. A no-op if you injected
     * your own `subscriber` (you own its lifecycle then). Does not touch the shared
     * publisher connection.
     */
    async close(): Promise<void> {
        if (this.listening) {
            this.sub.off("message", this.onMessage);
            this.listening = false;
        }
        if (this.ownsSub) await this.sub.quit();
    }
}
