// The assembly point: `mekik(options)` wires ilmek + the ports + the engine into
// one `MekikApp` a transport can drive. Sensible in-memory defaults everywhere,
// so the smallest useful call is `mekik({ graph })`.

import { InMemoryCheckpointer, type Checkpointer, type CompiledGraph } from "@ilmek/core";

import { IlmekAdapter } from "./adapter.ts";
import { ConversationEngine, randomMinter, type ConnectParams, type Connection, type EngineConfig } from "./engine.ts";
import type { IdMinter } from "./mapper.ts";
import type { TextInFrame } from "./protocol.ts";
import type { Authenticator } from "./auth.ts";
import {
    InMemoryConversationStore,
    InMemoryHistoryStore,
    type ConversationStore,
    type HistoryStore,
} from "./stores.ts";
import { LocalTurnLock, NoopBackplane, type Backplane, type TurnLock } from "./scaling.ts";

export interface MekikOptions {
    /** The ilmek graph this app serves. One run == one conversational turn. */
    graph: CompiledGraph<any>;
    /** ilmek's checkpointer (durable HITL). Default: in-memory (loses parked interrupts on restart). */
    checkpointer?: Checkpointer;
    /** Map an inbound `text` turn to the graph's input update. Default: `{ input: text }`. */
    input?: (frame: TextInFrame) => Record<string, unknown>;
    /** Pick the run's consolidated reply text from final channel state (PROTOCOL.md §4.3). */
    reply?: (state: Record<string, unknown>) => string | undefined;
    /** Per-turn server context placed at `ctx.meta.mekik` (PROTOCOL.md §6). */
    context?: (
        conv: { conversationId: string; userId: string },
        turn: { text: string; meta?: Record<string, unknown> },
    ) => Record<string, unknown>;
    /** Allowlist client-supplied meta into `ctx.meta.client`. Default: drop everything. */
    acceptClientMeta?: (meta: Record<string, unknown>) => Record<string, unknown> | undefined;
    /**
     * A bot message sent once when a fresh conversation first connects (before any
     * turn) — a greeting / instructions. Not sent on reconnect (the transcript
     * already has it). Return undefined for no greeting.
     */
    greeting?: (conv: { conversationId: string; userId: string }) => string | undefined;
    /** Enable connect-time auth (PROTOCOL.md §7). */
    authenticator?: Authenticator;
    history?: HistoryStore;
    conversations?: ConversationStore;
    /**
     * Cross-node single-writer turn lease (docs/SCALING.md). Default: `LocalTurnLock`
     * — one node, no lease. Pass a Redis lock to run a fleet.
     */
    turnLock?: TurnLock;
    /**
     * Cross-node fan-out backplane (docs/SCALING.md). Default: `NoopBackplane` — one
     * node fans out directly. Pass a Redis Pub/Sub backplane to run a fleet.
     */
    backplane?: Backplane;
    /** ilmek superstep budget per run. */
    recursionLimit?: number;
    /** Override the wire id minter (tests inject a deterministic one). */
    minter?: IdMinter;
    /** Override the clock (tests inject a fixed one). */
    now?: () => number;
}

export class MekikApp {
    readonly engine: ConversationEngine;
    readonly adapter: IlmekAdapter;
    readonly history: HistoryStore;
    readonly conversations: ConversationStore;

    constructor(options: MekikOptions) {
        const checkpointer = options.checkpointer ?? new InMemoryCheckpointer();
        this.adapter = new IlmekAdapter(options.graph, checkpointer, options.recursionLimit);
        this.history = options.history ?? new InMemoryHistoryStore();
        this.conversations = options.conversations ?? new InMemoryConversationStore();

        const cfg: EngineConfig = {
            adapter: this.adapter,
            history: this.history,
            conversations: this.conversations,
            input: options.input ?? ((f) => ({ input: f.data.text })),
            minter: options.minter ?? randomMinter(),
            now: options.now ?? Date.now,
            turnLock: options.turnLock ?? new LocalTurnLock(),
            backplane: options.backplane ?? new NoopBackplane(),
            // Spread-conditionally so exactOptionalPropertyTypes never sees an
            // explicit `undefined` for an omitted optional.
            ...(options.authenticator ? { authenticator: options.authenticator } : {}),
            ...(options.reply ? { reply: options.reply } : {}),
            ...(options.context ? { context: options.context } : {}),
            ...(options.acceptClientMeta ? { acceptClientMeta: options.acceptClientMeta } : {}),
            ...(options.greeting ? { greeting: options.greeting } : {}),
        };
        this.engine = new ConversationEngine(cfg);
    }

    /** Register a new connection and run the handshake (§1). */
    connect(conn: Connection, params?: ConnectParams): Promise<void> {
        return this.engine.connect(conn, params);
    }

    /** Feed one inbound frame (JSON string or parsed object). */
    receive(conn: Connection, raw: string | unknown): Promise<void> {
        return this.engine.receive(conn, raw);
    }

    /** Drop a connection (socket closed). */
    disconnect(conn: Connection): void {
        this.engine.disconnect(conn);
    }
}

/** Build a `MekikApp`. The callable half of the exported `mekik` (see index.ts). */
export function createMekikApp(options: MekikOptions): MekikApp {
    return new MekikApp(options);
}
