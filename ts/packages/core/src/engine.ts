// The ConversationEngine (PROTOCOL.md §1, §5). Transport-agnostic: it talks to
// `Connection` handles, never to a socket. `@mekik/ws` supplies real WebSocket
// connections; the conformance suite supplies in-memory ones. Everything the
// wire does - handshake, watermark replay, multi-connection fan-out, the turn
// lock, driving a run through the mapper - lives here.

import { randomBytes } from "node:crypto";

import type { IlmekEvent } from "@ilmek/core";

import { IlmekAdapter } from "./adapter.ts";
import { awaitedEvent, interruptFrameData, TurnMapper, type IdMinter } from "./mapper.ts";
import {
    AUTH_CLOSE_CODE,
    isPersistent,
    parseIncoming,
    PROTOCOL_VERSION,
    ProtocolError,
    RESERVED_FRAME_TYPES,
    sanitizeClientSkills,
    sanitizeClientTools,
    type ClientSkillDefinition,
    type ClientSkillsFrame,
    type ClientToolDefinition,
    type ClientToolsFrame,
    type GenUIEventFrame,
    type OutgoingFrame,
    type PendingView,
    type ResumeFrame,
    type TextInFrame,
} from "./protocol.ts";
import type { ComponentCatalog } from "./components.ts";
import { hashSkills, TurnSkills, type SkillSource } from "./skills.ts";
import type { MessageSpec } from "./messages.ts";
import type { ConversationStore, HistoryStore, PersistentFrame } from "./stores.ts";
import type { Authenticator, Credential } from "./auth.ts";
import type { Backplane, Subscription, TurnLease, TurnLock } from "./scaling.ts";

/**
 * What a greeting may be: a bare string (one `text` frame — the original form),
 * a described rich message, or a list mixing both, delivered in order.
 *
 * @see {@link EngineConfig.greeting}
 */
export type Greeting = string | MessageSpec | ReadonlyArray<string | MessageSpec>;

/**
 * Normalize a greeting into the frames to send. A bare string becomes a `text`
 * frame; empty strings are skipped (an app that computes "no greeting" as `""`
 * means it). Reserved frame types can't reach here through `messageSpec`, which
 * throws — but a hand-built spec is dropped rather than allowed to collide with
 * the protocol's own frames.
 */
function greetingFrames(greeting: Greeting | undefined): MessageSpec[] {
    if (greeting === undefined) return [];
    const items = Array.isArray(greeting) ? greeting : [greeting as string | MessageSpec];
    const out: MessageSpec[] = [];
    for (const item of items) {
        if (typeof item === "string") {
            if (item.length > 0) out.push({ type: "text", data: { text: item } });
            continue;
        }
        if (RESERVED_FRAME_TYPES.has(item.type) && item.type !== "text") continue;
        out.push(item);
    }
    return out;
}

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
        /** Hash of the component catalog the client has cached (§10.2). */
        componentsHash?: string;
        /** Tools this client can execute (§11.1). Inert unless {@link EngineConfig.clientTools} opts in. */
        tools?: ClientToolDefinition[];
        /** Hash of the server skill catalog the client has cached (§12.2). */
        skillsHash?: string;
        /** Skills this client declares (§12.4). Inert unless {@link EngineConfig.clientSkills} opts in. */
        skills?: ClientSkillDefinition[];
    };
    /** Raw credential (headers/query) for the Authenticator, if configured. */
    credential?: Credential;
}

/**
 * Whether — and which — client-declared tools the server accepts (PROTOCOL.md
 * §11.1). `true` accepts every well-formed declaration; a function is the
 * allowlist form — it sees the sanitized declarations and returns the subset to
 * accept (or `undefined` for none). Absent, client tool declarations are
 * **ignored entirely**: the same opt-in posture as `acceptClientMeta`, because a
 * declaration is client-controlled input that a model will read.
 */
export type ClientToolsPolicy =
    | true
    | ((
          tools: ClientToolDefinition[],
          conv: { conversationId: string; userId: string },
      ) => ClientToolDefinition[] | undefined);

/**
 * Whether — and which — client-declared skills the server accepts (PROTOCOL.md
 * §12.4). `true` accepts every well-formed declaration; a function is the
 * allowlist form — it sees the sanitized declarations and returns the subset to
 * accept (or `undefined` for none). Absent, client skill declarations are
 * **ignored entirely**, the same posture as {@link ClientToolsPolicy}: a skill
 * is text a model will follow.
 */
export type ClientSkillsPolicy =
    | true
    | ((
          skills: ClientSkillDefinition[],
          conv: { conversationId: string; userId: string },
      ) => ClientSkillDefinition[] | undefined);

/**
 * One graph-addressed interaction from a mounted GenUI component — what a
 * `mekik-event` element hands the server (PROTOCOL.md §10.4).
 *
 * @remarks
 * Two kinds of interaction never reach here, because both are already spoken for: a
 * `submit` whose payload names an open interrupt (coerced to a resume, §4.4), and a
 * `component-event` claimed by a node parked on {@link onEvent}. What is left is the
 * graph-wide traffic: a click on a widget whose turn is long over.
 */
export interface GenUiEvent {
    conversationId: string;
    userId: string;
    /** The turn stream the component was mounted in. */
    streamId: string;
    /** The element's event name — its `mekik-event` or `data-event` value. */
    eventType: string;
    /** The registry name of the component it came from, when the client knows it. */
    component?: string;
    /**
     * The element's `data-payload`, parsed — an object for JSON, the raw string for
     * anything that did not parse, undefined when it carried none.
     */
    payload?: unknown;
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
    /** Accept client-declared tools → `ctx.meta.clientTools` (§11). Default: ignore them. */
    clientTools?: ClientToolsPolicy;
    /** The server's skill catalog (§12), announced on connect and offered to nodes at `ctx.meta.skills`. */
    skills?: SkillSource;
    /** Accept client-declared skills into `ctx.meta.skills` (§12.4). Default: ignore them. */
    clientSkills?: ClientSkillsPolicy;
    /** Components the server defines itself, announced on connect (PROTOCOL.md §5). */
    components?: ComponentCatalog;
    /** Turn a component interaction into a graph input update, or undefined to ignore it (PROTOCOL.md §10.4). */
    onGenUiEvent?: (event: GenUiEvent) => Record<string, unknown> | undefined;
    /** A one-time bot greeting sent when a fresh conversation first connects (PROTOCOL.md §1). */
    greeting?: (conv: { conversationId: string; userId: string }) => Greeting | undefined;
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
    /**
     * The tools this connection declared (§11.1), already sanitized and passed
     * through the {@link ClientToolsPolicy}. `stamp` orders declarations across
     * a conversation's connections: when two tabs declare the same tool name,
     * the most recent declaration wins in the per-turn snapshot.
     */
    tools?: { defs: ClientToolDefinition[]; stamp: number };
    /** The skills this connection declared (§12.4), sanitized and policy-filtered; `stamp` as for tools. */
    skills?: { defs: ClientSkillDefinition[]; stamp: number };
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
    /** Orders client tool declarations across connections (see ConnState.tools). */
    private declStamp = 0;

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
        const state: ConnState = { conn, userId, ...(claims ? { claims } : {}) };
        live.connections.set(conn.id, state);
        this.connIndex.set(conn.id, conversationId);

        // Client tool declarations (§11.1). Inert unless the app opted in - the
        // same default-drop posture as client meta, because a declaration is
        // client-controlled input a model will read.
        if (hello.tools !== undefined) this.applyClientTools(state, hello.tools, conversationId, userId);
        if (hello.skills !== undefined) this.applyClientSkills(state, hello.skills, conversationId, userId);

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

        // The component catalog (§10.2). Sent straight after `welcome` so a widget
        // named by the very first turn is already registered. An unchanged catalog
        // costs one tiny frame — the markup itself travels only when the hash moved.
        const catalog = this.cfg.components;
        if (catalog && !catalog.isEmpty) {
            conn.send(
                hello.componentsHash === catalog.hash
                    ? { type: "genui_components", hash: catalog.hash, unchanged: true }
                    : { type: "genui_components", hash: catalog.hash, components: [...catalog.definitions] },
            );
        }

        // The skill catalog (§12.2): the server's level-1 summaries, hash-versioned
        // exactly like the component catalog, so a UI can show what the agent can
        // do and a returning client pays one tiny frame.
        const skills = this.cfg.skills?.list() ?? [];
        if (skills.length > 0) {
            const hash = hashSkills(skills);
            conn.send(
                hello.skillsHash === hash
                    ? { type: "skills", hash, unchanged: true }
                    : { type: "skills", hash, skills: skills.map((s) => ({ ...s, source: "server" as const })) },
            );
        }

        // Replay the tail the client hasn't durably seen (§2). A server-substituted
        // conversation resets the watermark: the asserted one wasn't resumable.
        const clientWatermark = watermarkReset ? 0 : hello.watermark ?? 0;
        const tail = await this.cfg.history.after(conversationId, clientWatermark);
        for (const frame of tail) conn.send(frame);

        // A fresh conversation (nothing in the transcript yet) gets a one-time bot
        // greeting. Persisted like any bot frame, so a later reconnect replays it
        // instead of greeting twice.
        if (this.cfg.greeting && live.seq === 0) {
            for (const spec of greetingFrames(this.cfg.greeting({ conversationId, userId }))) {
                await this.dispatch(conversationId, {
                    type: spec.type,
                    id: spec.id ?? this.cfg.minter.message(),
                    seq: ++live.seq,
                    from: "bot",
                    data: spec.data,
                    timestamp: this.cfg.now(),
                } as OutgoingFrame);
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
            case "client_tools":
                return this.handleClientTools(conn, convId, frame);
            case "client_skills":
                return this.handleClientSkills(conn, convId, frame);
        }
    }

    /**
     * Replace this connection's declared client skills (§12.4) — the whole new
     * set, `[]` withdrawing everything. Takes effect on the next turn, like
     * client tools.
     */
    private handleClientSkills(conn: Connection, convId: string, frame: ClientSkillsFrame): void {
        const state = this.live.get(convId)?.connections.get(conn.id);
        if (!state) return;
        this.applyClientSkills(state, frame.skills, convId, state.userId);
    }

    /** Sanitize a skill declaration, pass it through the policy, and store it on the connection. */
    private applyClientSkills(state: ConnState, raw: unknown, convId: string, userId: string): void {
        const policy = this.cfg.clientSkills;
        if (policy === undefined) return; // opted out: declarations are inert
        let defs = sanitizeClientSkills(raw);
        if (policy !== true) defs = policy(defs, { conversationId: convId, userId }) ?? [];
        state.skills = { defs, stamp: ++this.declStamp };
    }

    /** The conversation's client skills as one turn sees them (§12.4): the union across live connections, last declaration of a name wins. */
    private clientSkillsFor(convId: string): ClientSkillDefinition[] {
        const live = this.live.get(convId);
        if (!live) return [];
        const declared = [...live.connections.values()]
            .map((s) => s.skills)
            .filter((t): t is { defs: ClientSkillDefinition[]; stamp: number } => t !== undefined)
            .sort((a, b) => a.stamp - b.stamp);
        const byName = new Map<string, ClientSkillDefinition>();
        for (const { defs } of declared) for (const def of defs) byName.set(def.name, def);
        return [...byName.values()];
    }

    /**
     * Replace this connection's declared client tools (§11.1). The frame carries
     * the connection's whole new set; `[]` withdraws every tool. Takes effect on
     * the next turn — an in-flight run keeps the snapshot it started with.
     */
    private handleClientTools(conn: Connection, convId: string, frame: ClientToolsFrame): void {
        const state = this.live.get(convId)?.connections.get(conn.id);
        if (!state) return;
        this.applyClientTools(state, frame.tools, convId, state.userId);
    }

    /** Sanitize a declaration, pass it through the policy, and store it on the connection. */
    private applyClientTools(state: ConnState, raw: unknown, convId: string, userId: string): void {
        const policy = this.cfg.clientTools;
        if (policy === undefined) return; // opted out: declarations are inert
        let defs = sanitizeClientTools(raw);
        if (policy !== true) defs = policy(defs, { conversationId: convId, userId }) ?? [];
        state.tools = { defs, stamp: ++this.declStamp };
    }

    /**
     * The conversation's client tools as one turn sees them (§11.2): the union of
     * every live connection's declaration, deduped by name — the most recent
     * declaration of a name wins. Undefined when nothing is declared (or the app
     * never opted in), so `ctx.meta` stays clean for the common case.
     */
    private clientToolsFor(convId: string): ClientToolDefinition[] | undefined {
        const live = this.live.get(convId);
        if (!live) return undefined;
        const declared = [...live.connections.values()]
            .map((s) => s.tools)
            .filter((t): t is { defs: ClientToolDefinition[]; stamp: number } => t !== undefined)
            .sort((a, b) => a.stamp - b.stamp);
        if (declared.length === 0) return undefined;
        const byName = new Map<string, ClientToolDefinition>();
        for (const { defs } of declared) for (const def of defs) byName.set(def.name, def);
        return byName.size > 0 ? [...byName.values()] : undefined;
    }

    // ── turns ─────────────────────────────────────────────────────────────────

    /**
     * The guarded turn. Takes the local lock, then the cross-node lease, refuses a
     * second run with `busy`, and always releases both — every path that drives the
     * graph goes through here, so none of them can drift on the locking rules (§5).
     */
    private async withTurn(
        conn: Connection,
        convId: string,
        body: (live: Live, state: ConnState, signal: AbortSignal) => Promise<void>,
    ): Promise<void> {
        const live = this.live.get(convId)!;
        if (live.turn) {
            conn.send({ type: "error", data: { code: "busy", message: "a run is already in flight" } });
            return;
        }
        // Acquire the local lock synchronously, before the first await, so a second
        // frame arriving in the same tick sees it held (§5).
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
            await body(live, live.connections.get(conn.id)!, abort.signal);
        } finally {
            if (lease) await lease.release();
            live.turn = null;
        }
    }

    private handleText(conn: Connection, convId: string, frame: TextInFrame): Promise<void> {
        return this.withTurn(conn, convId, async (live, state, signal) => {
            const pending = await this.cfg.adapter.pending(convId);
            if (pending.length > 0) {
                conn.send({ type: "error", data: { code: "interrupted", message: "answer the open interrupt(s) first" } });
                return;
            }

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
            await this.drive(convId, live, this.cfg.adapter.run(input, { threadId: convId, meta, signal }));
        });
    }

    private handleResume(conn: Connection, convId: string, frame: ResumeFrame): Promise<void> {
        return this.withTurn(conn, convId, async (live, state, signal) => {
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

            // Tell every tab (and the transcript) each pause is closed, before the
            // continuation streams (§4.4).
            for (const p of pending) {
                await this.dispatch(convId, { type: "interrupt_resolved", seq: ++live.seq, id: p.id, data: { answer: frame.answers[p.id] } });
            }

            const meta = this.buildMeta(convId, state.userId, { text: "" }, state.claims);
            await this.drive(convId, live, this.cfg.adapter.resume(frame.answers, { threadId: convId, meta, signal }));
        });
    }

    private handleAbort(convId: string): void {
        this.live.get(convId)?.turn?.abort("client abort");
    }

    private async handleGenUIEvent(conn: Connection, convId: string, frame: GenUIEventFrame): Promise<void> {
        const payload = frame.payload;

        // Where the interaction is addressed, straight from the markup that fired it
        // (PROTOCOL.md §10.4): `component-event` → the component's own pause,
        // `mekik-event` → the graph, a plain `data-event` → whichever answers first.
        const toComponent = frame.scope !== "graph";
        const toGraph = frame.scope !== "component";

        const open = await this.cfg.adapter.pending(convId);

        // 1. A `submit` naming an open interrupt is coerced to a resume (§4.4) — a form
        //    bound to a pause answers that pause. The id in the payload is a direct
        //    address, so it outranks the scope rather than being filtered by it.
        if (frame.eventType === "submit" && typeof payload === "object" && payload !== null) {
            const id = (payload as { id?: unknown }).id;
            if (typeof id === "string" && open.some((p) => p.id === id)) {
                await this.handleResume(conn, convId, { type: "resume", answers: { [id]: (payload as { answer?: unknown }).answer } });
                return;
            }
        }

        // 2. A node parked on `onEvent` is waiting for exactly this interaction. The
        //    pause it holds is the binding, so no id has to travel in the payload.
        const waiting = toComponent ? open.find((p) => awaitedEvent(p) === frame.eventType) : undefined;
        if (waiting) {
            await this.handleResume(conn, convId, { type: "resume", answers: { [waiting.id]: payload } });
            return;
        }

        // 3. Otherwise it is the app's call. A `component-event` stops here: it was
        //    addressed to a component's own pause, and no node is holding one — the
        //    widget outlived the turn that mounted it. Without a handler the click is
        //    inert either way; a decorative button should cost nothing.
        if (!toGraph || !this.cfg.onGenUiEvent) return;

        // Ask before taking the turn, not after: an ignored event must not answer a
        // click with `busy` just because a run happens to be in flight.
        const state = this.live.get(convId)?.connections.get(conn.id);
        if (!state) return;
        const input = this.cfg.onGenUiEvent({
            conversationId: convId,
            userId: state.userId,
            streamId: frame.streamId,
            eventType: frame.eventType,
            ...(frame.component !== undefined ? { component: frame.component } : {}),
            ...(payload !== undefined ? { payload } : {}),
        });
        if (input === undefined) return;

        await this.withTurn(conn, convId, async (live, turnState, signal) => {
            // A parked run is answered, not overtaken — the same rule a `text` turn
            // obeys (§4.4). The click is refused, the pause stands.
            const pending = await this.cfg.adapter.pending(convId);
            if (pending.length > 0) {
                conn.send({ type: "error", data: { code: "interrupted", message: "answer the open interrupt(s) first" } });
                return;
            }

            // No `text` frame is dispatched: a click is not something the user said,
            // and the transcript already carries the widget it came from.
            const meta = this.buildMeta(convId, turnState.userId, { text: "" }, turnState.claims);
            await this.drive(convId, live, this.cfg.adapter.run(input, { threadId: convId, meta, signal }));
        });
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
        // The turn's client-tool snapshot (§11.2): taken here, at run start, so a
        // set that changes mid-run does not shift under the node's feet.
        const clientTools = this.clientToolsFor(convId);
        if (clientTools !== undefined) meta.clientTools = clientTools;
        // The turn's skill set (§12.3): the server catalog plus accepted client
        // declarations, merged once at run start for the same reason.
        const clientSkills = this.clientSkillsFor(convId);
        if (this.cfg.skills !== undefined || clientSkills.length > 0) {
            meta.skills = new TurnSkills(this.cfg.skills, clientSkills);
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
