// The ilmek seam (PROTOCOL.md §5). A thin, typed wrapper over ilmek's public
// run/resume streams so the engine depends on this surface, not on ilmek's
// module layout - and so the ".NET rethrow" concern (MODEL.md §11) has one home.
//
// It is intentionally minimal: ilmek already yields exactly the event stream the
// mapper wants, keyed by threadId (== conversationId) with meta on ctx. The
// adapter just forwards, injecting the checkpointer every call needs.

import {
    pendingInterrupts,
    resumeKeyedStream,
    stream,
    type Checkpointer,
    type CompiledGraph,
    type IlmekEvent,
    type Pending,
} from "@ilmek/core";

/** Per-run context the engine threads into ilmek. */
export interface RunContext {
    /** The ilmek thread id - mekik's `conversationId`. */
    threadId: string;
    /** Merged context (`meta.mekik` / `meta.client` / `meta.auth`), read by nodes as `ctx.meta`. */
    meta: Record<string, unknown>;
    /** Cancels the run at the next superstep boundary (an `abort` frame). */
    signal?: AbortSignal;
}

export class IlmekAdapter<C extends Record<string, unknown> = Record<string, unknown>> {
    readonly graph: CompiledGraph<any>;
    readonly checkpointer: Checkpointer;
    private readonly recursionLimit: number | undefined;

    constructor(graph: CompiledGraph<any>, checkpointer: Checkpointer, recursionLimit?: number) {
        this.graph = graph;
        this.checkpointer = checkpointer;
        this.recursionLimit = recursionLimit;
    }

    /** Start a fresh turn: fold `input` into the graph and stream its events. */
    run(input: Record<string, unknown>, ctx: RunContext): AsyncGenerator<IlmekEvent> {
        return stream(this.graph, input, this.opts(ctx));
    }

    /**
     * Resume a parked thread, answering interrupts by thread-scoped id
     * (PROTOCOL.md §4.4). ilmek's `resumeKeyed` requires every open interrupt to
     * be answered; the engine enforces that before calling this.
     */
    resume(answers: Record<string, unknown>, ctx: RunContext): AsyncGenerator<IlmekEvent> {
        return resumeKeyedStream(this.graph, answers, this.opts(ctx));
    }

    /** The interrupts the thread is parked on, or `[]`. Drives `welcome.pending` and the parked-turn guard. */
    pending(threadId: string): Promise<readonly Pending[]> {
        return pendingInterrupts(this.checkpointer, threadId);
    }

    private opts(ctx: RunContext) {
        return {
            threadId: ctx.threadId,
            checkpointer: this.checkpointer,
            meta: ctx.meta,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            ...(this.recursionLimit !== undefined ? { recursionLimit: this.recursionLimit } : {}),
        };
    }
}
