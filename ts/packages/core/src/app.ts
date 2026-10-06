// The assembly point: `mekik(options)` wires ilmek + the ports + the engine into
// one `MekikApp` a transport can drive. Sensible in-memory defaults everywhere,
// so the smallest useful call is `mekik({ graph })`.

import { InMemoryCheckpointer, type Checkpointer, type CompiledGraph } from "@ilmek/core";

import { IlmekAdapter } from "./adapter.ts";
import {
    ConversationEngine,
    randomMinter,
    type ClientSkillsPolicy,
    type ClientToolsPolicy,
    type ConnectParams,
    type Connection,
    type EngineConfig,
    type GenUiEvent,
    type Greeting,
} from "./engine.ts";
import type { IdMinter } from "./mapper.ts";
import type { TextInFrame } from "./protocol.ts";
import type { Authenticator } from "./auth.ts";
import { ComponentCatalog, type ComponentSource } from "./components.ts";
import {
    InMemoryConversationStore,
    InMemoryHistoryStore,
    type ConversationStore,
    type HistoryStore,
} from "./stores.ts";
import { LocalTurnLock, NoopBackplane, type Backplane, type TurnLock } from "./scaling.ts";
import { toSkillSource, type SkillsInput } from "./skills.ts";

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
     * Accept **client-declared tools** into `ctx.meta.clientTools` (PROTOCOL.md §11).
     * Default: off — declarations in `hello.tools` / `client_tools` frames are
     * ignored entirely, mirroring `acceptClientMeta`'s drop-by-default posture,
     * because a declaration is client-controlled input a model will read.
     *
     * Pass `true` to accept every well-formed declaration, or a function to
     * filter — pin names, strip tags, cap the count:
     *
     * @example
     * ```ts
     * clientTools: (tools) => tools.filter((t) => ["show_map", "pick_date"].includes(t.name)),
     * ```
     *
     * Nodes read the accepted set with `mekik.clientTools(ctx, { tags })` and
     * invoke one with `mekik.callClientTool(ctx, name, params)`.
     */
    clientTools?: ClientToolsPolicy;
    /**
     * The **skills** this server offers its nodes (PROTOCOL.md §12): a
     * `SkillSource` — `@ilmek/skills`' `SkillCatalog` fits as-is — or a plain
     * list of `{ name, description, instructions, tags? }`. Nodes read level 1
     * with `mekik.skills(ctx)` / `mekik.skillsPrompt(ctx)` and load one with
     * `mekik.loadSkill(ctx, name)`; the catalog's summaries are announced to
     * each client after `welcome` (hash-versioned, like components).
     *
     * @example
     * ```ts
     * import { SkillCatalog } from "@ilmek/skills";
     * const app = mekik({ graph, skills: await SkillCatalog.fromDirectories(["./skills"]) });
     * ```
     */
    skills?: SkillsInput;
    /**
     * Accept **client-declared skills** into the turn's skill set (PROTOCOL.md
     * §12.4). Default: off — declarations in `hello.skills` / `client_skills`
     * frames are ignored entirely, the same posture as {@link clientTools},
     * because a skill's description and instructions are text a model will
     * follow. Pass `true` to accept every well-formed declaration, or a function
     * to filter — pin names, cap instruction length, strip tags. A client skill
     * never overrides a server skill of the same name.
     *
     * @example
     * ```ts
     * clientSkills: (skills) => skills.filter((s) => s.instructions.length <= 4000),
     * ```
     */
    clientSkills?: ClientSkillsPolicy;
    /**
     * What the bot sends once when a fresh conversation first connects (before any
     * turn) — a greeting / instructions. Not sent on reconnect (the transcript
     * already has it). Return undefined for no greeting.
     *
     * @remarks
     * A string is one `text` frame. It may also be a **described rich message**
     * (`mekik.messages.card.spec({…})`, PROTOCOL.md §4.5) or a list mixing both,
     * delivered in order — so a first impression can be a card with buttons
     * rather than a paragraph. Each item lands as its own persistent frame and
     * replays on reconnect like any other.
     *
     * GenUI components are deliberately not accepted here: a chunk belongs to a
     * turn's stream, and the greeting fires outside any run. Send the same thing
     * as a message instead.
     *
     * @example
     * ```ts
     * greeting: (conv) => [
     *     `Hi ${conv.userId}! What can I do for you?`,
     *     mekik.messages.buttons.spec({
     *         buttons: [{ label: "Track an order", value: "/track" }, { label: "Start a return", value: "/return" }],
     *     }),
     * ]
     * ```
     */
    greeting?: (conv: { conversationId: string; userId: string }) => Greeting | undefined;
    /**
     * Components this server defines itself (PROTOCOL.md §10). Each one is shipped
     * to the client on connect and registered there, so a `ui` chunk can mount it
     * without anything being compiled into the page.
     *
     * Accepts a plain spec, a {@link defineComponent} result, or a
     * {@link GenUiComponent} subclass (instance or constructor).
     *
     * @example
     * ```ts
     * const orderCard = defineComponent({
     *     name: "order-card",
     *     template: `<h3>{{title}}</h3><button data-event="track">Track</button>`,
     *     props: { title: "" },
     * });
     * const app = mekik({ graph: g, components: [orderCard] });
     * ```
     */
    components?: readonly ComponentSource[];
    /**
     * What a click on a component does (PROTOCOL.md §10.4). Every `data-event`
     * interaction that is not already answering an open interrupt arrives here;
     * return a graph input update to run a turn on it, or `undefined` to ignore it.
     * Leave the option unset and every such interaction is inert.
     *
     * @remarks
     * This is {@link MekikOptions.input} for components: a mapper, not a place to do
     * work. Side effects belong in the node the turn reaches, where the journal makes
     * them exactly-once. The turn runs under the same single-writer rule as a `text`
     * turn — a click while the graph is parked on an interrupt is refused with
     * `error{interrupted}`, and one arriving mid-run with `error{busy}`. Nothing is
     * written to the transcript on the user's behalf; a click is not an utterance.
     *
     * @example
     * ```ts
     * onGenUiEvent: (ev) =>
     *     ev.eventType === "track_order"
     *         ? { input: `track ${(ev.payload as { id?: string })?.id ?? ""}` }
     *         : undefined,   // anything else: not worth a turn
     * ```
     */
    onGenUiEvent?: (event: GenUiEvent) => Record<string, unknown> | undefined;
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
            ...(options.clientTools !== undefined ? { clientTools: options.clientTools } : {}),
            ...(options.skills !== undefined ? { skills: toSkillSource(options.skills) } : {}),
            ...(options.clientSkills !== undefined ? { clientSkills: options.clientSkills } : {}),
            ...(options.greeting ? { greeting: options.greeting } : {}),
            ...(options.components?.length ? { components: new ComponentCatalog(options.components) } : {}),
            ...(options.onGenUiEvent ? { onGenUiEvent: options.onGenUiEvent } : {}),
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
