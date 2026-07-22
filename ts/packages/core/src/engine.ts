// The ConversationEngine (PROTOCOL.md §1, §5). Transport-agnostic: it talks to
// `Connection` handles, never to a socket. `@mekik/ws` supplies real WebSocket
// connections; the conformance suite supplies in-memory ones. Everything the
// wire does - handshake, watermark replay, multi-connection fan-out, the turn
// lock, driving a run through the mapper - lives here.

import { randomBytes } from "node:crypto";

import type { IlmekEvent } from "@ilmek/core";

import { IlmekAdapter } from "./adapter.ts";
import { interruptFrameData, TurnMapper, type IdMinter } from "./mapper.ts";
import {
    AUTH_CLOSE_CODE,
    isPersistent,
    parseIncoming,
    PROTOCOL_VERSION,
    ProtocolError,
    type OutgoingFrame,
    type PendingView,
    type ResumeFrame,
    type TextInFrame,
} from "./protocol.ts";
import type { ConversationStore, HistoryStore, PersistentFrame } from "./stores.ts";
import type { Authenticator, Credential } from "./auth.ts";
import type { Backplane, Subscription, TurnLease, TurnLock } from "./scaling.ts";

/**
 * One live client connection, as the engine sees it. A transport implements this
 * over its own socket; `id` is the mekik `connectionId`.
 */
export interface Connection {
    readonly id: string;
    send(frame: OutgoingFrame): void;
    close(code?: number, reason?: string): void;
}

/** What a transport hands the engine at connect - identity travels here or in a first `hello`. */
export interface ConnectParams {
    hello?: {
        userId?: string;
        conversationId?: string;
        watermark?: number;
        token?: string;
        meta?: Record<string, unknown>;
    };
    /** Raw credential (headers/query) for the Authenticator, if configured. */
    credential?: Credential;
}

/** Everything the engine needs, assembled by `mekik()` (see app.ts). */
export interface EngineConfig {
    adapter: IlmekAdapter;
    history: HistoryStore;
    conversations: ConversationStore;
    authenticator?: Authenticator;
    /** Map an inbound `text` frame to the graph's input update. */
    input: (frame: TextInFrame) => Record<string, unknown>;
    /** Pick the run's reply text from final state (PROTOCOL.md §4.3). */
    reply?: (state: Record<string, unknown>) => string | undefined;
    /** Per-turn server context → `ctx.meta.mekik` (PROTOCOL.md §6). */
    context?: (conv: { conversationId: string; userId: string }, turn: { text: string; meta?: Record<string, unknown> }) => Record<string, unknown>;
    /** Allowlist for client-supplied meta → `ctx.meta.client`. Default: drop everything. */
    acceptClientMeta?: (meta: Record<string, unknown>) => Record<string, unknown> | undefined;
    /** A one-time bot greeting sent when a fresh conversation first connects (PROTOCOL.md §1). */
    greeting?: (conv: { conversationId: string; userId: string }) => string | undefined;
    minter: IdMinter;
    now: () => number;
    /** Cross-node single-writer lease. Default: `LocalTurnLock` (single node). */
    turnLock: TurnLock;
    /** Cross-node fan-out. Default: `NoopBackplane` (single node fans out directly). */
    backplane: Backplane;
}

interface ConnState {
    conn: Connection;
    userId: string;
    claims?: Record<string, unknown>;
}

/** Per-conversation, process-local runtime state. `seq` is the persistent-frame counter. */
interface Live {
    seq: number;
    connections: Map<string, ConnState>;
    /** The in-flight run's abort controller, or null when idle - this is the local turn lock. */
    turn: AbortController | null;
    /** This node's backplane subscription for the conversation, if any (NoopBackplane: inert). */
    sub?: Subscription;
}

export class ConversationEngine {
    private readonly cfg: EngineConfig;
    private readonly live = new Map<string, Live>();
    private readonly connIndex = new Map<string, string>();
    /** This node's identity - stamped on published frames so we skip our own on the backplane. */
    private readonly nodeId = `node-${randomBytes(8).toString("base64url")}`;

    constructor(cfg: EngineConfig) {
        this.cfg = cfg;
    }

    // ── connect / disconnect ──────────────────────────────────────────────────

    async connect(conn: Connection, params: ConnectParams = {}): Promise<void> {
        const hello = params.hello ?? {};

        let verifiedUserId: string | undefined;
        let claims: Record<string, unknown> | undefined;
        if (this.cfg.authenticator) {
            const credential: Credential = params.credential ?? (hello.token !== undefined ? { token: hello.token } : {});
            const verdict = await this.cfg.authenticator.authenticate(credential);
            if (!verdict.ok) {
                conn.send({ type: "error", data: { code: "unauthorized", message: verdict.reason ?? "unauthorized" } });
                conn.close(AUTH_CLOSE_CODE, "unauthorized");
                return;
            }
            verifiedUserId = verdict.userId;
            claims = verdict.claims;
        }

        // A verified id always wins over a client-asserted one (anti-spoof, §1).
        const userId = verifiedUserId ?? hello.userId ?? this.mint("user");

        const { conversationId, watermarkReset } = await this.resolveConversation(hello.conversationId, userId);

        const live = await this.ensureLive(conversationId);
        live.connections.set(conn.id, { conn, userId, ...(claims ? { claims } : {}) });
        this.connIndex.set(conn.id, conversationId);

        const pending = await this.cfg.adapter.pending(conversationId);
        const pendingViews: PendingView[] = pending.map((p) => ({ id: p.id, data: interruptFrameData(p) }));
        conn.send({
            type: "welcome",
            data: {
                protocol: PROTOCOL_VERSION,
                conversationId,
                userId,
                connectionId: conn.id,
                watermark: live.seq,
                pending: pendingViews,
            },
        });

        // Replay the tail the client hasn't durably seen (§2). A server-substituted
        // conversation resets the watermark: the asserted one wasn't resumable.
        const clientWatermark = watermarkReset ? 0 : hello.watermark ?? 0;
        const tail = await this.cfg.history.after(conversationId, clientWatermark);
        for (const frame of tail) conn.send(frame);

        // A fresh conversation (nothing in the transcript yet) gets a one-time bot
        // greeting. Persisted like any bot text, so a later reconnect replays it
        // instead of greeting twice.
        if (this.cfg.greeting && live.seq === 0) {
            const text = this.cfg.greeting({ conversationId, userId });
            if (text) {
                await this.dispatch(conversationId, {
                    type: "text",
                    id: this.cfg.minter.message(),
                    seq: ++live.seq,
                    from: "bot",
                    data: { text },
                    timestamp: this.cfg.now(),
                });
            }
        }
    }

    disconnect(conn: Connection): void {
        const convId = this.connIndex.get(conn.id);
        this.connIndex.delete(conn.id);
        if (!convId) return;
        // Keep the Live record (and its seq counter) - other tabs may still be on
        // this conversation, and the counter must not reset if they aren't.
        this.live.get(convId)?.connections.delete(conn.id);
    }

    // ── inbound frames ────────────────────────────────────────────────────────

    async receive(conn: Connection, raw: string | unknown): Promise<void> {
        let frame;
        try {
            frame = parseIncoming(raw);
        } catch (err) {
            if (err instanceof ProtocolError) {
                conn.send({ type: "error", data: { code: err.code, message: err.message } });
                return;
            }
            throw err;
        }

        const convId = this.connIndex.get(conn.id);
        if (!convId) {
            conn.send({ type: "error", data: { code: "no_session", message: "connect before sending frames" } });
            return;
        }

        switch (frame.type) {
            case "hello":
                return; // A re-hello mid-session is ignored in v1.
            case "text":
                return this.handleText(conn, convId, frame);
            case "resume":
                return this.handleResume(conn, convId, frame);
            case "abort":
                return this.handleAbort(convId);
            case "genui_event":
                return this.handleGenUIEvent(conn, convId, frame);
        }
    }

    // ── turns ─────────────────────────────────────────────────────────────────

    private async handleText(conn: Connection, convId: string, frame: TextInFrame): Promise<void> {
        const live = this.live.get(convId)!;
        if (live.turn) {
            conn.send({ type: "error", data: { code: "busy", message: "a run is already in flight" } });
            return;
        }
        // Acquire the local lock synchronously, before the first await, so a second
        // text arriving in the same tick sees it held (§5).
        const abort = new AbortController();
        live.turn = abort;
        let lease: TurnLease | null = null;
        try {
            // Then the cross-node lease: `null` means another node owns the turn
            // (single-node LocalTurnLock always grants). See docs/SCALING.md.
            lease = await this.cfg.turnLock.acquire(convId);
            if (!lease) {
                conn.send({ type: "error", data: { code: "busy", message: "a run is already in flight" } });
                return;
            }

            const pending = await this.cfg.adapter.pending(convId);
            if (pending.length > 0) {
                conn.send({ type: "error", data: { code: "interrupted", message: "answer the open interrupt(s) first" } });
                return;
            }

            const state = live.connections.get(conn.id)!;
            // The user's own turn: stored + shown to the other tabs, not echoed
            // back to the sender (§1).
            await this.dispatch(convId, {
                type: "text",
                id: this.cfg.minter.message(),
                seq: ++live.seq,
                from: "user",
                data: { text: frame.data.text },
                timestamp: this.cfg.now(),
            }, conn.id);

            const turn = { text: frame.data.text, ...(frame.meta !== undefined ? { meta: frame.meta } : {}) };
            const meta = this.buildMeta(convId, state.userId, turn, state.claims);
            const input = this.cfg.input(frame);
            await this.drive(convId, live, this.cfg.adapter.run(input, { threadId: convId, meta, signal: abort.signal }));
        } finally {
            if (lease) await lease.release();
            live.turn = null;
        }
    }

    private async handleResume(conn: Connection, convId: string, frame: ResumeFrame): Promise<void> {
        const live = this.live.get(convId)!;
        if (live.turn) {
            conn.send({ type: "error", data: { code: "busy", message: "a run is already in flight" } });
            return;
        }
        const abort = new AbortController();
        live.turn = abort;
        let lease: TurnLease | null = null;
        try {
            lease = await this.cfg.turnLock.acquire(convId);
            if (!lease) {
                conn.send({ type: "error", data: { code: "busy", message: "a run is already in flight" } });
                return;
            }

            const pending = await this.cfg.adapter.pending(convId);
            if (pending.length === 0) {
                conn.send({ type: "error", data: { code: "not_interrupted", message: "no open interrupt to resume" } });
                return;
            }
            // ilmek's resumeKeyed requires every open interrupt answered; enforce
            // it here with a clear error rather than letting ilmek throw (§4.4).
            const missing = pending.filter((p) => !(p.id in frame.answers));
            if (missing.length > 0) {
                conn.send({
                    type: "error",
                    data: { code: "incomplete_resume", message: `answer all open interrupts: ${missing.map((m) => m.id).join(", ")}` },
                });
                return;
            }

            const state = live.connections.get(conn.id)!;
            // Tell every tab (and the transcript) each pause is closed, before the
            // continuation streams (§4.4).
            for (const p of pending) {
                await this.dispatch(convId, { type: "interrupt_resolved", seq: ++live.seq, id: p.id, data: { answer: frame.answers[p.id] } });
            }

            const meta = this.buildMeta(convId, state.userId, { text: "" }, state.claims);
            await this.drive(convId, live, this.cfg.adapter.resume(frame.answers, { threadId: convId, meta, signal: abort.signal }));
        } finally {
            if (lease) await lease.release();
            live.turn = null;
        }
    }

    private handleAbort(convId: string): void {
        this.live.get(convId)?.turn?.abort("client abort");
    }

    private async handleGenUIEvent(conn: Connection, convId: string, frame: { streamId: string; eventType: string; payload?: unknown }): Promise<void> {
        // v1: a component `submit` naming an open interrupt is coerced to a resume
        // (PROTOCOL.md §4.4). Anything else is reserved for a future forwarding path.
        if (frame.eventType !== "submit") return;
        const payload = frame.payload;
        if (typeof payload !== "object" || payload === null) return;
        const id = (payload as { id?: unknown }).id;
        if (typeof id !== "string") return;
        const pending = await this.cfg.adapter.pending(convId);
        if (!pending.some((p) => p.id === id)) return;
        await this.handleResume(conn, convId, { type: "resume", answers: { [id]: (payload as { answer?: unknown }).answer } });
    }

    /** Stream one run's events through a fresh TurnMapper, fanning frames out. */
    private async drive(convId: string, live: Live, events: AsyncGenerator<IlmekEvent>): Promise<void> {
        const mapper = new TurnMapper({
            allocSeq: () => ++live.seq,
            mint: this.cfg.minter,
            now: this.cfg.now,
            ...(this.cfg.reply ? { reply: this.cfg.reply } : {}),
        });
        for await (const ev of events) {
            for (const out of mapper.map(ev)) await this.dispatch(convId, out);
        }
    }

    // ── plumbing ──────────────────────────────────────────────────────────────

    /**
     * Persist a persistent frame, fan it out to this node's connections, then hand
     * it to the backplane for the other nodes. The producing node records once;
     * backplane subscribers only re-fan (see `ensureLive`).
     */
    private async dispatch(convId: string, frame: OutgoingFrame, exceptConnId?: string): Promise<void> {
        if (isPersistent(frame)) await this.cfg.history.record(convId, frame as PersistentFrame);
        this.fanOutLocal(convId, frame, exceptConnId);
        await this.cfg.backplane.publish(convId, { originId: this.nodeId, frame });
    }

    /** Send a frame to this node's own connections for the conversation (no record, no publish). */
    private fanOutLocal(convId: string, frame: OutgoingFrame, exceptConnId?: string): void {
        const live = this.live.get(convId);
        if (!live) return;
        for (const { conn } of live.connections.values()) {
            if (exceptConnId !== undefined && conn.id === exceptConnId) continue;
            conn.send(frame);
        }
    }

    private buildMeta(
        convId: string,
        userId: string,
        turn: { text: string; meta?: Record<string, unknown> },
        claims: Record<string, unknown> | undefined,
    ): Record<string, unknown> {
        const meta: Record<string, unknown> = {};
        if (this.cfg.context) meta.mekik = this.cfg.context({ conversationId: convId, userId }, turn);
        if (claims) meta.auth = claims;
        if (this.cfg.acceptClientMeta && turn.meta) {
            const client = this.cfg.acceptClientMeta(turn.meta);
            if (client !== undefined) meta.client = client;
        }
        return meta;
    }

    private async resolveConversation(requested: string | undefined, userId: string): Promise<{ conversationId: string; watermarkReset: boolean }> {
        if (requested) {
            const rec = await this.cfg.conversations.get(requested);
            // Adopt only if it exists AND belongs to this user - never hand one
            // user another user's conversation.
            if (rec && rec.userId === userId) return { conversationId: requested, watermarkReset: false };
            const conversationId = this.mint("conv");
            await this.cfg.conversations.create({ conversationId, userId, createdAt: this.cfg.now(), meta: {} });
            return { conversationId, watermarkReset: true };
        }
        const conversationId = this.mint("conv");
        await this.cfg.conversations.create({ conversationId, userId, createdAt: this.cfg.now(), meta: {} });
        return { conversationId, watermarkReset: false };
    }

    private async ensureLive(convId: string): Promise<Live> {
        let live = this.live.get(convId);
        if (!live) {
            live = { seq: await this.cfg.history.currentSeq(convId), connections: new Map(), turn: null };
            this.live.set(convId, live);
            // Subscribe once per conversation this node holds. Frames another node
            // produced arrive here and fan out to our local sockets; we skip our own
            // (originId) to avoid the pub/sub self-delivery echo. NoopBackplane never
            // delivers, so single-node behaviour is unchanged.
            live.sub = await this.cfg.backplane.subscribe(convId, (msg) => {
                if (msg.originId === this.nodeId) return;
                this.fanOutLocal(convId, msg.frame);
            });
        }
        return live;
    }

    private mint(prefix: string): string {
        return `${prefix}-${randomBytes(8).toString("base64url")}`;
    }
}

/** The default production id minter: random, collision-free. Fixtures inject a deterministic one. */
export function randomMinter(): IdMinter {
    let n = 0;
    const rid = (): string => `${randomBytes(6).toString("base64url")}-${n++}`;
    return { message: () => `msg-${rid()}`, stream: () => `stream-${rid()}` };
}
