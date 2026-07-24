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

import type { AIChunk, MessageAction, ToolCall, UiRef } from "./protocol.ts";

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

function emitChunk(ctx: Context<any>, chunk: AIChunk): void {
    ctx.emit({ [MEKIK_KEY]: "genui", chunk });
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
 *
 * @example
 * ```ts
 * for await (const delta of model.stream(input)) mekik.text(ctx, delta);
 * ```
 *
 * @see {@link ui} to mount a component; {@link event} to signal one.
 */
export function text(ctx: Context<any>, content: string): void {
    emitChunk(ctx, { type: "text", content });
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
 * with new props updates it in place.
 *
 * @param ctx - The ilmek node context.
 * @param component - The component name registered on the client.
 * @param props - Props handed to the component; omit for one that needs none.
 *
 * @example
 * ```ts
 * mekik.ui(ctx, "order-card", { id: order.id, total: order.total });
 * ```
 */
export function ui(ctx: Context<any>, component: string, props?: Record<string, unknown>): void {
    emitChunk(ctx, props === undefined ? { type: "ui", component } : { type: "ui", component, props });
}

/**
 * Dispatch a named event to a mounted GenUI component — advance a step, highlight
 * a row — without re-mounting it.
 *
 * @param ctx - The ilmek node context.
 * @param name - The event name the component listens for.
 * @param payload - Optional event payload.
 *
 * @example
 * ```ts
 * mekik.event(ctx, "highlight", { rowId: 3 });
 * ```
 */
export function event(ctx: Context<any>, name: string, payload?: unknown): void {
    emitChunk(ctx, payload === undefined ? { type: "event", name } : { type: "event", name, payload });
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

// `index.ts` attaches these to the callable `mekik` factory, so both
// `mekik({ graph })` and `mekik.ui(ctx, …)` read the way the docs show.
