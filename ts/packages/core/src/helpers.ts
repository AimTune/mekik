// Author-facing helpers (PROTOCOL.md §6). Each takes ilmek's `ctx` and emits the
// custom payloads the TurnMapper recognises - no ambient storage, because ilmek
// already threads `ctx` through every node.
//
//   node("lookup", async (state, ctx) => {
//       const order = await mekik.tool(ctx, "get_order", { id }, () => Orders.get(id));
//       mekik.ui(ctx, "order-card", { id: order.id, total: order.total });
//       const ok = await mekik.approve(ctx, { title: `Refund ${order.total}?` },
//                                       { ui: { component: "approval-form", props: { amount: order.total } } });
//       return { reply: ok.approved ? "done" : "cancelled" };
//   })

import { isInterrupt, type Context } from "@ilmek/core";

import {
    CLIENT_TOOL_EVENT,
    type AIChunk,
    type ClientToolDefinition,
    type ClientToolMode,
    type MessageAction,
    type SkillEntry,
    type SkillOrigin,
    type SkillSummary,
    type SkillUse,
    type ToolCall,
    type UiRef,
} from "./protocol.ts";
import { renderSkillsPrompt, type SkillSource, type SkillsPromptOptions } from "./skills.ts";

const MEKIK_KEY = "$mekik";

/** Per-ctx tool counter, so repeated tool calls get stable, replay-safe ids. */
const toolCounters = new WeakMap<object, number>();

function nextToolId(ctx: Context<any>): string {
    const n = toolCounters.get(ctx) ?? 0;
    toolCounters.set(ctx, n + 1);
    // Stable across replay: taskId is unchanged and call order is deterministic,
    // so the resume pass mints the same id and its re-emitted trace upserts.
    return `${ctx.taskId || "task"}:tool:${n}`;
}

/** Per-ctx ui counter — same replay-stability story as {@link nextToolId}. */
const uiCounters = new WeakMap<object, number>();

function nextUiId(ctx: Context<any>): string {
    const n = uiCounters.get(ctx) ?? 0;
    uiCounters.set(ctx, n + 1);
    return `${ctx.taskId || "task"}:ui:${n}`;
}

function emitChunk(ctx: Context<any>, chunk: AIChunk): void {
    ctx.emit({ [MEKIK_KEY]: "genui", chunk });
}

/**
 * Presentation options for a streamed chunk.
 *
 * @remarks
 * A caller-supplied `id` is the chunk's client-side key: emitting another chunk
 * with the **same id updates that element in place** instead of appending a new
 * one, and an explicit id opts the chunk out of the mapper's text-run coalescing
 * (PROTOCOL.md §4.1). Omit it and mekik manages the id for you.
 */
export interface ChunkOptions {
    /** Client-side chunk key; same id ⇒ update in place. */
    id?: string | number;
}

/**
 * Stream one prose delta to the client as a generative-UI text chunk.
 *
 * @remarks
 * Text chunks are **transient** — they render live as the run streams, but they
 * are not the conversation's durable reply. The durable reply is the single `text`
 * frame the mapper emits at run end from your reply selector. Use this for
 * token-by-token model output, and return the full string as the reply.
 *
 * @param ctx - The ilmek node context (threaded into every node).
 * @param content - The prose fragment to append to the current turn's stream.
 * @param opts - Optional chunk key; see {@link ChunkOptions}.
 *
 * @example
 * ```ts
 * for await (const delta of model.stream(input)) mekik.text(ctx, delta);
 * ```
 *
 * @see {@link ui} to mount a component; {@link event} to signal one.
 */
export function text(ctx: Context<any>, content: string, opts: ChunkOptions = {}): void {
    emitChunk(ctx, opts.id === undefined ? { type: "text", content } : { type: "text", content, id: opts.id });
}

/**
 * Stream an async sequence of prose deltas as live text chunks and return the
 * full text — the token-by-token pattern in a single call.
 *
 * @remarks
 * Each delta is emitted with {@link text}, so consecutive deltas share one stream
 * text-run and a client renders a **single growing bubble**, not one bubble per
 * token (PROTOCOL.md §4.1). Streamed text is **transient**: the returned string is
 * every delta concatenated — return it from your node as the durable `reply`, and
 * the mapper emits that as the one persistent `text` frame at run end. Empty or
 * `undefined` deltas are skipped.
 *
 * @typeParam T - The element type of the source stream (e.g. a model's streaming chunk).
 * @param ctx - The ilmek node context.
 * @param deltas - The async source, e.g. `model.stream(input)`.
 * @param select - Pulls the text fragment out of each element; omit when the source yields raw strings.
 * @returns The full text accumulated from every emitted delta.
 *
 * @example
 * ```ts
 * const full = await mekik.streamText(ctx, model.stream(state.input), (u) => u.text);
 * return { reply: full };
 * ```
 *
 * @see {@link text} to emit one delta yourself.
 */
export async function streamText<T = string>(
    ctx: Context<any>,
    deltas: AsyncIterable<T>,
    select: (delta: T) => string | undefined = (d) => d as unknown as string,
): Promise<string> {
    let full = "";
    for await (const delta of deltas) {
        const piece = select(delta);
        if (!piece) continue;
        text(ctx, piece);
        full += piece;
    }
    return full;
}

/**
 * The authenticated claims for this turn — the `AuthVerdict.claims` the authenticator
 * returned, which the engine places at `ctx.meta.auth` (PROTOCOL.md §7). Empty when the
 * app runs without an authenticator or the connection is anonymous.
 *
 * @param ctx - The ilmek node context.
 * @returns The claims record, or `{}` when unauthenticated.
 */
export function authClaims(ctx: Context<any>): Record<string, unknown> {
    const auth = (ctx.meta as Record<string, unknown> | undefined)?.auth;
    return typeof auth === "object" && auth !== null ? (auth as Record<string, unknown>) : {};
}

/**
 * Read a claim as a list of strings, coercing the shapes it survives a JSON round-trip
 * as: a string list, a single string, or a list of boxed values. Missing ⇒ empty.
 *
 * @param claims - A claims record, e.g. from {@link authClaims}.
 * @param key - The claim to read (e.g. `"roles"`).
 */
export function claimStrings(claims: Record<string, unknown>, key: string): string[] {
    const value = claims[key];
    if (Array.isArray(value)) {
        return value.map((x) => (typeof x === "string" ? x : String(x))).filter((x) => x.length > 0);
    }
    return typeof value === "string" && value.length > 0 ? [value] : [];
}

/**
 * Mount or update a generative-UI component by its client-registry name.
 *
 * @remarks
 * mekik streams the instruction to render a component the **client** (chativa) has
 * registered — it ships no components itself. Emitting the same component again
 * with new props updates it in place. Pass `opts.id` to key the instance yourself —
 * that is how two instances of the *same* component (two order cards) stay
 * distinct and individually updatable; see also {@link mount} for the managed form.
 *
 * @param ctx - The ilmek node context.
 * @param component - The component name registered on the client.
 * @param props - Props handed to the component; omit for one that needs none.
 * @param opts - Optional chunk key; see {@link ChunkOptions}.
 *
 * @example
 * ```ts
 * mekik.ui(ctx, "order-card", { id: order.id, total: order.total });
 * ```
 */
export function ui(ctx: Context<any>, component: string, props?: Record<string, unknown>, opts: ChunkOptions = {}): void {
    const chunk: AIChunk = props === undefined ? { type: "ui", component } : { type: "ui", component, props };
    emitChunk(ctx, opts.id === undefined ? chunk : { ...chunk, id: opts.id });
}

/**
 * A managed handle to one mounted GenUI component instance — mekik owns the
 * chunk id, the author just calls {@link UiHandle.update}.
 *
 * @see {@link mount}
 */
export interface UiHandle {
    /** The chunk id keying this instance on the client. */
    readonly id: string | number;
    /** Re-emit the component with new props — the client updates it in place. */
    update(props: Record<string, unknown>): void;
}

/**
 * Mount a GenUI component and get a {@link UiHandle} for updating it in place —
 * ids managed for you.
 *
 * @remarks
 * The handle's id is minted replay-stable (like tool ids: `taskId` + call order),
 * so the resume pass after an interrupt re-emits the same id and the client
 * updates the existing element instead of duplicating it. Pass `opts.id` to pick
 * the key yourself (e.g. `order.id`, so the same order always maps to the same card).
 *
 * @param ctx - The ilmek node context.
 * @param component - The component name registered on the client.
 * @param props - Initial props; omit for a component that needs none.
 * @param opts - Optional explicit chunk key; see {@link ChunkOptions}.
 * @returns A handle whose `update(props)` re-renders this same instance.
 *
 * @example
 * ```ts
 * const card = mekik.mount(ctx, "order-card", { id: order.id, status: "loading" });
 * const details = await mekik.tool(ctx, "get_details", { id: order.id }, () => Orders.details(order.id));
 * card.update({ id: order.id, status: "ready", total: details.total });
 * ```
 */
export function mount(
    ctx: Context<any>,
    component: string,
    props?: Record<string, unknown>,
    opts: ChunkOptions = {},
): UiHandle {
    const id = opts.id ?? nextUiId(ctx);
    ui(ctx, component, props, { id });
    return {
        id,
        update(next: Record<string, unknown>): void {
            ui(ctx, component, next, { id });
        },
    };
}

/**
 * Dispatch a named event to a mounted GenUI component — advance a step, highlight
 * a row — without re-mounting it.
 *
 * @param ctx - The ilmek node context.
 * @param name - The event name the component listens for.
 * @param payload - Optional event payload.
 * @param opts - Optional chunk key; see {@link ChunkOptions}.
 *
 * @example
 * ```ts
 * mekik.event(ctx, "highlight", { rowId: 3 });
 * ```
 */
export function event(ctx: Context<any>, name: string, payload?: unknown, opts: ChunkOptions = {}): void {
    const chunk: AIChunk = payload === undefined ? { type: "event", name } : { type: "event", name, payload };
    emitChunk(ctx, opts.id === undefined ? chunk : { ...chunk, id: opts.id });
}

/**
 * Emit a single `tool_call` frame — the low-level primitive behind {@link tool}.
 *
 * @remarks
 * Exported so an integration that runs the tool itself (e.g. `@mekik/langchain`,
 * where the agent invokes the tool) can produce the same trace without re-deriving
 * the reserved `$mekik` payload shape. Traces **upsert by `call.id`**, so
 * re-emitting the same id with a new `status` is how a running → completed/error
 * pair is expressed. Prefer {@link tool} unless you own the tool's invocation.
 *
 * @param ctx - The ilmek node context.
 * @param call - The trace record: `{ id, name, status, params?, result?, error? }`.
 *
 * @see {@link nextToolCallId} to mint a replay-stable `id`.
 */
export function toolTrace(ctx: Context<any>, call: ToolCall): void {
    ctx.emit({ [MEKIK_KEY]: "tool", call });
}

/**
 * Mint a replay-stable `tool_call` id for this context.
 *
 * @remarks
 * The id is stable across an interrupt/resume — the resume pass mints the same id
 * for the same call, so a re-emitted trace upserts instead of duplicating.
 *
 * @param ctx - The ilmek node context.
 * @returns A deterministic id for the next tool call on this context.
 * @see {@link toolTrace}
 */
export function nextToolCallId(ctx: Context<any>): string {
    return nextToolId(ctx);
}

/**
 * Run a side effect exactly once and surface it as a `tool_call` trace.
 *
 * @remarks
 * `fn` executes inside ilmek's `ctx.step`, so its result is **journaled**: on the
 * replay pass after an interrupt the node re-runs, but `fn` is not called again —
 * it returns the recorded value. This is what stops a paused-then-resumed node
 * from repeating a charge or a lookup. The trace re-emits on replay, but as an
 * upsert by id the client just updates the existing entry. An interrupt thrown by
 * `fn` is rethrown untouched — a pause is not a failure.
 *
 * @typeParam T - The tool's result type. Must survive a journal round-trip
 * (plain data, not class instances or live handles).
 * @param ctx - The ilmek node context.
 * @param name - Tool name; shown in the trace and used as the journal step key.
 * @param params - Parameters, surfaced in the `running` trace.
 * @param fn - The side effect. Runs once ever, across any number of resumes.
 * @returns The tool's result — the recorded value on a replay pass.
 *
 * @example
 * ```ts
 * const order = await mekik.tool(ctx, "get_order", { id }, () => Orders.get(id));
 * ```
 */
export async function tool<T>(
    ctx: Context<any>,
    name: string,
    params: Record<string, unknown>,
    fn: () => T | Promise<T>,
): Promise<T> {
    const id = nextToolId(ctx);
    const emitTool = (call: ToolCall): void => toolTrace(ctx, call);

    emitTool({ id, name, status: "running", params });
    try {
        const result = await ctx.step(name, fn);
        emitTool({ id, name, status: "completed", result });
        return result;
    } catch (err) {
        // An interrupt is not a tool failure - rethrow it untouched so the pause
        // propagates (this mirrors the .NET rethrow rule, PROTOCOL.md §9).
        if (isInterrupt(err)) throw err;
        emitTool({ id, name, status: "error", error: err instanceof Error ? err.message : String(err) });
        throw err;
    }
}

// ── client tools (PROTOCOL.md §11) ────────────────────────────────────────────

/** Narrow the client tool set a node sees; see {@link clientTools}. */
export interface ClientToolFilter {
    /**
     * Tag filter (§11.2). A tool with **no tags is unrestricted** and matches
     * every query; a tagged tool matches only when its tags intersect these. So
     * a frontend tags the tools it wants scoped to particular nodes, and leaves
     * general-purpose ones untagged.
     */
    tags?: readonly string[];
    /** Keep only tools of this invocation mode. */
    mode?: ClientToolMode;
}

/**
 * The client tools this turn may call (PROTOCOL.md §11.2) — the sanitized,
 * server-accepted union of what the conversation's live connections declared,
 * snapshotted at run start into `ctx.meta.clientTools`.
 *
 * @remarks
 * Empty unless the app opted in via `MekikOptions.clientTools` — the default is
 * to ignore declarations entirely. The returned definitions are ready to hand to
 * a model as its tool list (`name`, `description`, `parameters` as JSON Schema);
 * dispatch a model's call with {@link callClientTool}.
 *
 * @param ctx - The ilmek node context.
 * @param filter - Optional tag/mode narrowing; see {@link ClientToolFilter}.
 * @returns The matching definitions, in declaration order.
 *
 * @example
 * ```ts
 * // this node only exposes the client's billing widgets to the model
 * const tools = mekik.clientTools(ctx, { tags: ["billing"] });
 * ```
 */
export function clientTools(ctx: Context<any>, filter: ClientToolFilter = {}): ClientToolDefinition[] {
    const declared = (ctx.meta as Record<string, unknown> | undefined)?.clientTools;
    if (!Array.isArray(declared)) return [];
    let defs = declared.filter(
        (d): d is ClientToolDefinition =>
            typeof d === "object" && d !== null && typeof (d as { name?: unknown }).name === "string",
    );
    if (filter.mode !== undefined) defs = defs.filter((d) => (d.mode ?? "call") === filter.mode);
    if (filter.tags !== undefined) {
        const wanted = new Set(filter.tags);
        defs = defs.filter((d) => !d.tags || d.tags.length === 0 || d.tags.some((t) => wanted.has(t)));
    }
    return defs;
}

export interface CallClientToolOptions {
    /** Journal key; defaults to `tool:{name}`, so one node can call several client tools. */
    key?: string;
}

/**
 * Invoke a tool the **client** declared (PROTOCOL.md §11.3) and resolve to the
 * result its handler returns.
 *
 * @remarks
 * For a `"call"`-mode tool (the default) this is a real pause with everything a
 * pause buys: the run parks on an interrupt whose frame carries `data.tool =
 * {name, params}`, the client executes its handler and answers with a `resume`
 * carrying `{ok: true, result}` (or `{ok: false, error}`, which makes this call
 * **throw**), and the wait survives a disconnect or restart — `welcome.pending`
 * re-announces the open call so a reconnecting client can retry it. The node
 * re-runs from the top on resume, so wrap side effects in {@link tool}, exactly
 * as around any other pause.
 *
 * A `"notify"`-mode tool never parks: the invocation streams as a genui event
 * chunk (`name: "client_tool"`) in the turn's stream and the call resolves
 * immediately with `undefined`.
 *
 * Either way the call is surfaced as a `tool_call` running → completed/error
 * trace, so the conversation shows the client-side work like any server tool.
 *
 * @typeParam T - The shape of the client handler's result.
 * @param ctx - The ilmek node context.
 * @param name - The declared tool name (see {@link clientTools}).
 * @param params - Parameters for the client handler, matching the declared schema.
 * @param opts - Journaling options; see {@link CallClientToolOptions}.
 * @returns The handler's result (`undefined` for a notify tool).
 *
 * @example
 * ```ts
 * const when = await mekik.callClientTool<{ date: string }>(ctx, "pick_date", { min: "2026-08-01" });
 * ```
 */
export async function callClientTool<T = unknown>(
    ctx: Context<any>,
    name: string,
    params?: Record<string, unknown>,
    opts: CallClientToolOptions = {},
): Promise<T> {
    if (!name) throw new Error("a client tool call needs a tool name");
    const def = clientTools(ctx).find((d) => d.name === name);
    const id = nextToolId(ctx);
    const trace = (call: ToolCall): void => toolTrace(ctx, call);

    trace({ id, name, status: "running", ...(params !== undefined ? { params } : {}) });

    if ((def?.mode ?? "call") === "notify") {
        // Fire-and-forget: the invocation is an event chunk in the turn stream,
        // keyed by the (replay-stable) trace id so a resume pass upserts it.
        event(ctx, CLIENT_TOOL_EVENT, { name, ...(params !== undefined ? { params } : {}) }, { id });
        trace({ id, name, status: "completed" });
        return undefined as T;
    }

    const answer = await ctx.interrupt<unknown>(
        { [MEKIK_KEY]: { tool: { name, ...(params !== undefined ? { params } : {}) } } },
        opts.key ?? `tool:${name}`,
    );

    // The result envelope (§11.3). A hand-rolled resume that skips the envelope
    // is taken as the bare result - lenient on purpose, so a human answering an
    // open tool call from another tab does not wedge the run.
    if (typeof answer === "object" && answer !== null && typeof (answer as { ok?: unknown }).ok === "boolean") {
        const env = answer as { ok: boolean; result?: unknown; error?: unknown };
        if (!env.ok) {
            const message = typeof env.error === "string" && env.error.length > 0 ? env.error : `client tool "${name}" failed`;
            trace({ id, name, status: "error", error: message });
            throw new Error(message);
        }
        trace({ id, name, status: "completed", result: env.result });
        return env.result as T;
    }
    trace({ id, name, status: "completed", result: answer });
    return answer as T;
}

// ── skills (PROTOCOL.md §12) ──────────────────────────────────────────────────

/** Per-ctx skill counter — same replay-stability story as {@link nextToolId}. */
const skillCounters = new WeakMap<object, number>();

function nextSkillId(ctx: Context<any>): string {
    const n = skillCounters.get(ctx) ?? 0;
    skillCounters.set(ctx, n + 1);
    return `${ctx.taskId || "task"}:skill:${n}`;
}

/** The turn's skill source (§12.3), or undefined when the app configured no skills and accepted none. */
function skillSourceOf(ctx: Context<any>): SkillSource | undefined {
    const s = (ctx.meta as Record<string, unknown> | undefined)?.skills;
    return typeof s === "object" && s !== null && typeof (s as SkillSource).list === "function" && typeof (s as SkillSource).get === "function"
        ? (s as SkillSource)
        : undefined;
}

/** Narrow the skills a node sees; see {@link skills}. */
export interface SkillFilter {
    /**
     * Tag filter — the client-tool rule (§11.2): an untagged skill is
     * unrestricted and matches every query; a tagged skill matches only when
     * its tags intersect these.
     */
    tags?: readonly string[];
    /** Keep only skills of one origin: the server's catalog or the client's declarations. */
    source?: SkillOrigin;
}

/**
 * The skills this turn may load (PROTOCOL.md §12.3) — level 1: the summaries a
 * model reads before choosing. The server's catalog (`MekikOptions.skills`)
 * plus whatever client-declared skills the app accepted, each stamped with its
 * `source`. Empty when the app configured neither.
 *
 * @param ctx - The ilmek node context.
 * @param filter - Optional tag/origin narrowing; see {@link SkillFilter}.
 *
 * @example
 * ```ts
 * const system = base + "\n\n" + mekik.skillsPrompt(ctx, { tags: ["billing"] });
 * ```
 */
export function skills(ctx: Context<any>, filter: SkillFilter = {}): SkillSummary[] {
    const source = skillSourceOf(ctx);
    if (!source) return [];
    let defs = [...source.list()];
    if (filter.source !== undefined) defs = defs.filter((d) => d.source === filter.source);
    if (filter.tags !== undefined) {
        const wanted = new Set(filter.tags);
        defs = defs.filter((d) => !d.tags || d.tags.length === 0 || d.tags.some((t) => wanted.has(t)));
    }
    return defs;
}

/**
 * Level 1 as text: the `<available_skills>` block for a system prompt, over
 * {@link skills} with the same filter. `""` when there is nothing to list —
 * safe to append unconditionally.
 *
 * @param ctx - The ilmek node context.
 * @param filter - Which skills to list; see {@link SkillFilter}.
 * @param opts - The intro sentence; see {@link SkillsPromptOptions}.
 */
export function skillsPrompt(ctx: Context<any>, filter: SkillFilter = {}, opts: SkillsPromptOptions = {}): string {
    return renderSkillsPrompt(skills(ctx, filter), opts);
}

/**
 * The tools the visible **server** skills own (`SkillEntry.tools`, §12.6),
 * keyed by skill name — what an agent loop holds back until the model loads
 * each skill. Same filter as {@link skills}; a skill without tools is absent,
 * and a client-declared skill never contributes (declarations carry no tools).
 * Reads the catalog without emitting a `skill` frame.
 *
 * `TTool` is not checked here — `@mekik/core` does not know the agent
 * framework; the integration that consumes the map validates its entries.
 *
 * @param ctx - The ilmek node context.
 * @param filter - Which skills to consider; see {@link SkillFilter}.
 */
export function skillTools<TTool = unknown>(ctx: Context<any>, filter: SkillFilter = {}): Record<string, readonly TTool[]> {
    const source = skillSourceOf(ctx);
    const out: Record<string, readonly TTool[]> = {};
    if (!source) return out;
    for (const summary of skills(ctx, filter)) {
        if (summary.source === "client") continue;
        const entry = source.get(summary.name);
        if (!entry || entry.source === "client" || !Array.isArray(entry.tools) || entry.tools.length === 0) continue;
        out[summary.name] = [...(entry.tools as readonly TTool[])];
    }
    return out;
}

/**
 * Emit a single `skill` frame — the low-level primitive behind {@link loadSkill},
 * exported for integrations that resolve skills themselves. Upserts by `use.id`.
 */
export function skillTrace(ctx: Context<any>, use: SkillUse): void {
    ctx.emit({ [MEKIK_KEY]: "skill", use });
}

/**
 * Load one skill's instructions — level 2 (PROTOCOL.md §12.5) — and surface
 * the use as a `skill` frame so the conversation shows which skill the agent
 * is following.
 *
 * @remarks
 * Loading is a catalog read, not a side effect, so it is not journaled; the
 * trace id is replay-stable (`taskId` + call order), so a resume pass upserts
 * the same frame. An unknown name emits a `status: "error"` trace and
 * **throws** — the agent wrappers turn that into an observation the model can
 * read instead.
 *
 * @param ctx - The ilmek node context.
 * @param name - The skill's name, as listed by {@link skills}.
 * @returns The skill with its `instructions`.
 *
 * @example
 * ```ts
 * const pdf = mekik.loadSkill(ctx, "pdf");
 * messages.push(new SystemMessage(pdf.instructions));
 * ```
 */
export function loadSkill(ctx: Context<any>, name: string): SkillEntry {
    if (!name) throw new Error("loadSkill needs a skill name");
    const id = nextSkillId(ctx);
    const entry = skillSourceOf(ctx)?.get(name);
    if (!entry) {
        const error = `unknown skill ${JSON.stringify(name)}`;
        skillTrace(ctx, { id, name, status: "error", error });
        throw new Error(error);
    }
    skillTrace(ctx, { id, name, status: "loaded", ...(entry.source !== undefined ? { source: entry.source } : {}) });
    return entry;
}

/**
 * Read one of a skill's bundled files — level 3 (PROTOCOL.md §12.5). Only a
 * server skill backed by folders has files (`@ilmek/skills`' catalog does);
 * the call rejects for a client-declared skill or a source without resources.
 * The catalog confines `path` to the skill folder.
 */
export async function skillResource(ctx: Context<any>, name: string, path: string): Promise<string> {
    const source = skillSourceOf(ctx);
    if (!source?.readResource) throw new Error(`skill ${JSON.stringify(name)} has no resources`);
    return source.readResource(name, path);
}

/** True when the turn's skill source can serve bundled files (level 3). */
export function skillResourcesAvailable(ctx: Context<any>): boolean {
    return typeof skillSourceOf(ctx)?.readResource === "function";
}

export interface ApproveOptions {
    /** Mount a form for the approval instead of relying on chip fallback. */
    ui?: UiRef;
    /** Chip actions; if omitted and no `ui`, the client shows default Approve/Cancel. */
    actions?: MessageAction[];
    /** Journal key, when a node pauses more than once (ilmek MODEL.md §5.4). */
    key?: string;
}

/**
 * Pause the run for a human and resume with their answer.
 *
 * @remarks
 * The node **suspends** at the returned promise on the first pass — it never
 * resolves there. The engine emits an `interrupt` frame (carrying `payload`, and
 * the optional `ui`/`actions` under the reserved `$mekik` key, PROTOCOL.md §4.2)
 * and ends the run `interrupted`. When the client answers with a `resume` keyed by
 * the interrupt id, the graph re-runs the node from the top and this call resolves
 * to the answer. Everything before it re-runs on resume, so wrap side effects in
 * {@link tool}. Omit both `ui` and `actions` for default Approve/Cancel chips.
 *
 * @typeParam T - The shape of the human's answer.
 * @param ctx - The ilmek node context.
 * @param payload - The question, delivered to the client as `interrupt.data.payload`.
 * @param opts - Presentation and journaling options; see {@link ApproveOptions}.
 * @returns The human's answer, resolved on resume.
 *
 * @example
 * ```ts
 * const ok = await mekik.approve<{ approved: boolean }>(
 *   ctx,
 *   { title: "Deploy to production?" },
 *   { actions: [{ label: "Approve", value: { approved: true } }] },
 * );
 * ```
 */
export function approve<T = unknown>(
    ctx: Context<any>,
    payload: Record<string, unknown>,
    opts: ApproveOptions = {},
): Promise<T> {
    const meta: { ui?: UiRef; actions?: MessageAction[] } = {};
    if (opts.ui !== undefined) meta.ui = opts.ui;
    if (opts.actions !== undefined) meta.actions = opts.actions;

    const wrapped =
        opts.ui !== undefined || opts.actions !== undefined ? { ...payload, [MEKIK_KEY]: meta } : payload;

    return ctx.interrupt<T>(wrapped, opts.key);
}

export interface OnEventOptions {
    /** Context for the client, delivered as `interrupt.data.payload`. */
    payload?: Record<string, unknown>;
    /** Mount a component as part of the pause, as {@link approve} does. */
    ui?: UiRef;
    /** Journal key; defaults to `event:{eventType}`, so one node can wait on several events. */
    key?: string;
}

/**
 * Pause the run until a mounted component fires a named interaction.
 *
 * @remarks
 * The widget half of {@link approve}: instead of chips in the chat, the run waits
 * for the `component-event` a component already on screen will send, and resolves
 * to that event's payload. Mount the component first — this call never resolves on
 * the pass that parks, so anything emitted after it only reaches the client on the
 * resume.
 *
 * It is a real pause, with everything that buys: the run ends `interrupted` and the
 * thread is checkpointed, so the wait survives a disconnect, a restart and a move to
 * another node. The interrupt is re-announced in `welcome.pending` on reconnect like
 * any other, carrying `data.event` so the client knows this pause answers by
 * interaction and offers no default Approve/Cancel chips.
 *
 * The node re-runs from the top on resume, so wrap side effects in {@link tool} and
 * give the chunks you emitted literal ids, exactly as around any other pause. While
 * several pauses are open ilmek requires them all answered at once, so an interaction
 * that arrives while another pause is also open draws `error{incomplete_resume}`
 * (PROTOCOL.md §4.4) — the same rule the `submit` shortcut plays by.
 *
 * @typeParam T - The shape of the event's payload.
 * @param ctx - The ilmek node context.
 * @param eventType - The component's `component-event` name.
 * @param opts - Presentation and journaling options; see {@link OnEventOptions}.
 * @returns The event's payload, resolved on the interaction.
 *
 * @example
 * ```ts
 * deliveryCard(ctx, props, { id: "card-1" });
 * const req = await mekik.onEvent<{ id: string }>(ctx, "track_order");
 * ```
 */
export function onEvent<T = unknown>(
    ctx: Context<any>,
    eventType: string,
    opts: OnEventOptions = {},
): Promise<T> {
    if (!eventType) throw new Error("an awaited event needs a component-event name");

    const meta: { event: string; ui?: UiRef } = { event: eventType };
    if (opts.ui !== undefined) meta.ui = opts.ui;

    return ctx.interrupt<T>({ ...(opts.payload ?? {}), [MEKIK_KEY]: meta }, opts.key ?? `event:${eventType}`);
}

// ── buttons, typed (no hand-written action JSON) ──────────────────────────────

/** A {@link action}-built chip whose `value` type is carried for {@link choose} inference. */
export interface ActionOf<V> extends MessageAction {
    label: string;
    value: V;
}

/**
 * Build one quick-reply button (a `MessageAction`) — the typed constructor that
 * replaces hand-written `{ label, value }` JSON.
 *
 * @remarks
 * With no `value` the answer is the `label` string itself (protocol rule,
 * PROTOCOL.md §3.2). With a `value`, {@link choose} infers the answer type from it.
 *
 * @example
 * ```ts
 * mekik.action("Approve", { approved: true })
 * mekik.action("Cancel") // answer === "Cancel"
 * ```
 */
export function action(label: string): MessageAction;
export function action<const V>(label: string, value: V): ActionOf<V>;
export function action(label: string, value?: unknown): MessageAction {
    return value === undefined ? { label } : { label, value };
}

/** What one {@link choose} option can be: a bare label string, or a built action. */
export type ChoiceOption = string | MessageAction;

/** The answer type one option resolves to: its `value`, else its label string. */
export type ChoiceValue<O extends ChoiceOption> = O extends string
    ? O
    : O extends { value: infer V }
      ? V
      : O extends { label: infer L extends string }
        ? L
        : never;

export interface ChooseOptions {
    /** Also mount a form component; the chips remain as fallback. */
    ui?: UiRef;
    /** Journal key, when a node pauses more than once (ilmek MODEL.md §5.4). */
    key?: string;
}

/**
 * Pause the run on a set of buttons and resolve to the one the human picked —
 * the typed, no-JSON way to put chips in the chat.
 *
 * @remarks
 * Sugar over {@link approve}: emits an `interrupt` frame whose `actions` are the
 * given options, and resolves on `resume` with the chosen action's `value` (or its
 * label string when the option has no value — a bare string option is both). The
 * answer type is **inferred from the options**, so the call site needs no manual
 * generic and no hand-written `{ label, value }` objects:
 *
 * ```ts
 * const size = await mekik.choose(ctx, "Pick a size", ["S", "M", "L"]);
 * //    ^? "S" | "M" | "L"
 *
 * const verdict = await mekik.choose(ctx, { title: `Refund ${order.total}?` }, [
 *     mekik.action("Approve", { approved: true }),
 *     mekik.action("Reject", { approved: false }),
 * ]);
 * //    ^? { approved: true } | { approved: false }
 * ```
 *
 * The inferred type is a contract with your own client, not a guarantee — the
 * wire cannot stop a hand-rolled `resume` from carrying something else, same as
 * {@link approve}'s `T`.
 *
 * @param ctx - The ilmek node context.
 * @param payload - The question. A string is shorthand for `{ title }`; a record
 * passes through as `interrupt.data.payload`.
 * @param options - The buttons: bare strings and/or {@link action}-built chips.
 * @param opts - Optional form mount and journal key; see {@link ChooseOptions}.
 * @returns The picked option's value (its label string when it has no value).
 */
export function choose<const O extends readonly [ChoiceOption, ...ChoiceOption[]]>(
    ctx: Context<any>,
    payload: string | Record<string, unknown>,
    options: O,
    opts: ChooseOptions = {},
): Promise<ChoiceValue<O[number]>> {
    const actions: MessageAction[] = options.map((o) => (typeof o === "string" ? { label: o } : o));
    return approve<ChoiceValue<O[number]>>(ctx, typeof payload === "string" ? { title: payload } : payload, {
        actions,
        ...(opts.ui !== undefined ? { ui: opts.ui } : {}),
        ...(opts.key !== undefined ? { key: opts.key } : {}),
    });
}

// `index.ts` attaches these to the callable `mekik` factory, so both
// `mekik({ graph })` and `mekik.ui(ctx, …)` read the way the docs show.
