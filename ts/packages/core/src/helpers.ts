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

/** Stream one prose delta as a genui text chunk. */
export function text(ctx: Context<any>, content: string): void {
    emitChunk(ctx, { type: "text", content });
}

/** Mount/update a GenUI component by registry name. */
export function ui(ctx: Context<any>, component: string, props?: Record<string, unknown>): void {
    emitChunk(ctx, props === undefined ? { type: "ui", component } : { type: "ui", component, props });
}

/** Dispatch a named GenUI event to a mounted component. */
export function event(ctx: Context<any>, name: string, payload?: unknown): void {
    emitChunk(ctx, payload === undefined ? { type: "event", name } : { type: "event", name, payload });
}

/**
 * Emit one `tool_call` frame. The low-level primitive behind `tool()`, exported
 * so an integration that does its own execution (e.g. `@mekik/langchain`, where
 * the agent invokes the tool) can still produce the same trace without
 * re-deriving the reserved `$mekik` payload shape. Traces upsert by `call.id`,
 * so re-emitting the same id is how a running→completed pair is expressed.
 */
export function toolTrace(ctx: Context<any>, call: ToolCall): void {
    ctx.emit({ [MEKIK_KEY]: "tool", call });
}

/** Mint a replay-stable `tool_call` id for this ctx. See `toolTrace`. */
export function nextToolCallId(ctx: Context<any>): string {
    return nextToolId(ctx);
}

/**
 * Run a tool exactly once (journaled by `ctx.step`) and emit its `tool_call`
 * running→completed/error trace. The side effect is memoized across an
 * interrupt-replay; the trace, being an upsert by id, re-emits harmlessly.
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
 * Pause for a human, attaching presentation metadata under the reserved
 * `$mekik` key so the mapper can build the `interrupt` frame's `ui`/`actions`
 * (PROTOCOL.md §4.2). Returns the human's answer on resume.
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
