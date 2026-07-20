// The canonical ilmek-event → mekik-frame mapping (PROTOCOL.md §4).
//
// This is the closed, golden-tested core of the protocol. `TurnMapper` consumes
// one run's `IlmekEvent` stream and produces the mekik frames a client sees. It
// is turn-stateful - it owns the current turn's genui stream id and chunk
// counter - but every source of nondeterminism (the persistent-seq allocator,
// the id minter, the clock, the reply selector) is injected, so the fixtures in
// conformance/mekik/fixtures replay byte-for-byte across TS and .NET.

import { isToken, type IlmekEvent, type Pending } from "@ilmek/core";

import type {
    AIChunk,
    GenUIFrame,
    InterruptFrame,
    MessageAction,
    OutgoingFrame,
    TextOutFrame,
    ToolCall,
    ToolCallFrame,
    UiRef,
} from "./protocol.ts";

/** Mints the ids that appear on the wire. Production: random. Fixtures: 1-based counters. */
export interface IdMinter {
    /** For `text` frame `id`. */
    message(): string;
    /** For a turn's genui `streamId`. */
    stream(): string;
}

export interface TurnMapperDeps {
    /** Advance and return the conversation's next persistent `seq`. */
    allocSeq: () => number;
    mint: IdMinter;
    /** Wall clock (ms). Injected so fixtures pin `timestamp`. */
    now: () => number;
    /**
     * Pick the run's reply text from final channel state at `run_end{done}`
     * (PROTOCOL.md §4.3). Returns undefined/"" to emit no consolidated text.
     */
    reply?: (state: Record<string, unknown>) => string | undefined;
}

/** The reserved key `mekik.approve`/`mekik.ui`/`mekik.tool` tuck metadata under. */
const MEKIK_KEY = "$mekik";

interface MekikGenUIPayload {
    [MEKIK_KEY]: "genui";
    chunk: AIChunk;
}
interface MekikToolPayload {
    [MEKIK_KEY]: "tool";
    call: ToolCall;
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isGenUIPayload(v: unknown): v is MekikGenUIPayload {
    return isRecord(v) && v[MEKIK_KEY] === "genui" && isRecord(v.chunk);
}
function isToolPayload(v: unknown): v is MekikToolPayload {
    return isRecord(v) && v[MEKIK_KEY] === "tool" && isRecord(v.call);
}

/** Split an interrupt payload into its client-facing parts (PROTOCOL.md §4.2). */
export function unwrapInterrupt(payload: unknown): { payload: unknown; ui?: UiRef; actions?: MessageAction[] } {
    if (!isRecord(payload) || !isRecord(payload[MEKIK_KEY])) {
        return { payload };
    }
    const meta = payload[MEKIK_KEY] as { ui?: UiRef; actions?: MessageAction[] };
    // Strip the reserved key from what the human sees; keep everything else.
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) if (k !== MEKIK_KEY) rest[k] = v;
    return {
        payload: rest,
        ...(meta.ui !== undefined ? { ui: meta.ui } : {}),
        ...(meta.actions !== undefined ? { actions: meta.actions } : {}),
    };
}

/** Build the `interrupt` frame (or its `welcome.pending` view minus seq) for one pending pause. */
export function interruptFrameData(p: Pending): InterruptFrame["data"] {
    const { payload, ui, actions } = unwrapInterrupt(p.payload);
    return {
        payload,
        ...(ui !== undefined ? { ui } : {}),
        ...(actions !== undefined ? { actions } : {}),
    };
}

export class TurnMapper {
    private readonly deps: TurnMapperDeps;
    private streamId: string | null = null;
    private chunkCounter = 0;

    constructor(deps: TurnMapperDeps) {
        this.deps = deps;
    }

    /** Frames for one ilmek event, in emit order. May be empty (dropped events). */
    map(ev: IlmekEvent): OutgoingFrame[] {
        switch (ev.type) {
            case "run_start":
                return [{ type: "run", data: { status: "started" } }];

            case "custom":
                return this.mapCustom(ev.payload);

            case "interrupt":
                return ev.pending.map((p) => this.interruptFrame(p));

            case "run_end":
                return this.mapRunEnd(ev);

            // Not surfaced in v1 (PROTOCOL.md §4.1). A future `debug` mode may map these.
            case "node_start":
            case "node_end":
            case "node_error":
            case "node_retry":
            case "step_start":
            case "state":
            case "checkpoint":
                return [];
        }
    }

    private mapCustom(payload: unknown): OutgoingFrame[] {
        if (isToken(payload)) {
            return [this.genuiFrame({ type: "text", content: payload.text }, false)];
        }
        if (isGenUIPayload(payload)) {
            return [this.genuiFrame(payload.chunk, false)];
        }
        if (isToolPayload(payload)) {
            const frame: ToolCallFrame = { type: "tool_call", seq: this.deps.allocSeq(), data: payload.call };
            return [frame];
        }
        // Unrecognised customs are dropped here; an extension hook (MekikOptions
        // .onCustom) maps them in the engine, outside this closed core.
        return [];
    }

    private mapRunEnd(ev: Extract<IlmekEvent, { type: "run_end" }>): OutgoingFrame[] {
        switch (ev.status) {
            case "interrupted":
                // The interrupt frames were already emitted from the `interrupt`
                // event; here we only close the run.
                return [{ type: "run", data: { status: "interrupted" } }];

            case "aborted":
                // No text: the last checkpoint stands and the thread is resumable.
                return [{ type: "run", data: { status: "aborted" } }];

            case "error": {
                const message = formatErrors(ev.errors);
                const text = this.botText(`⚠️ ${message}`);
                return [text, { type: "run", data: { status: "error" } }];
            }

            case "done": {
                const out: OutgoingFrame[] = [];
                if (this.streamId !== null) {
                    out.push(this.genuiFrame({ type: "event", name: "stream_done" }, true));
                }
                const reply = this.deps.reply?.(ev.state);
                if (typeof reply === "string" && reply.length > 0) out.push(this.botText(reply));
                out.push({ type: "run", data: { status: "finished" } });
                return out;
            }
        }
    }

    private interruptFrame(p: Pending): InterruptFrame {
        return { type: "interrupt", seq: this.deps.allocSeq(), id: p.id, data: interruptFrameData(p) };
    }

    private genuiFrame(chunk: AIChunk, done: boolean): GenUIFrame {
        if (this.streamId === null) this.streamId = this.deps.mint.stream();
        // Assign a chunk id if the emitter didn't; ids increment within the stream.
        const withId: AIChunk = chunk.id === undefined ? { ...chunk, id: this.nextChunkId() } : chunk;
        return { type: "genui", seq: this.deps.allocSeq(), streamId: this.streamId, done, chunk: withId };
    }

    private botText(text: string): TextOutFrame {
        return {
            type: "text",
            id: this.deps.mint.message(),
            seq: this.deps.allocSeq(),
            from: "bot",
            data: { text },
            timestamp: this.deps.now(),
        };
    }

    private nextChunkId(): number {
        return ++this.chunkCounter;
    }
}

function formatErrors(errors: ReadonlyArray<readonly [string, unknown]>): string {
    if (errors.length === 0) return "the run failed";
    return errors
        .map(([node, err]) => {
            const msg = err instanceof Error ? err.message : String(err);
            return `${node}: ${msg}`;
        })
        .join("; ");
}

/**
 * Drive a whole recorded event list through a fresh mapper (the fixture entry
 * point). Production streams events one at a time through `TurnMapper.map`; this
 * is the batch form the golden runner and `run()`-style callers use.
 */
export function eventToFrames(events: readonly IlmekEvent[], deps: TurnMapperDeps): OutgoingFrame[] {
    const mapper = new TurnMapper(deps);
    const out: OutgoingFrame[] = [];
    for (const ev of events) out.push(...mapper.map(ev));
    return out;
}
