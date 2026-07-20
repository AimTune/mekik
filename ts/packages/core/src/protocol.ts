// The mekik/1 wire protocol - frame shapes, parsing, and canonical JSON.
//
// PROTOCOL.md is the normative spec; this file is its TypeScript surface. The
// frames are transport-agnostic JSON: the same objects travel over WebSocket
// today and could travel over anything that carries UTF-8 text. Nothing here
// knows about sockets, ilmek, or the engine - it is pure data plus two pure
// functions (parseIncoming, canonicalize).

/** Announced in `welcome.data.protocol`. Major bump = breaking (PROTOCOL.md preamble). */
export const PROTOCOL_VERSION = "mekik/1";

/**
 * Server→client frame types that get a per-conversation `seq`, are appended to
 * the transcript, and are replayed on reconnect (PROTOCOL.md §2). Everything
 * else is transient: live-only, never stored, never replayed.
 */
export const PERSISTENT_FRAME_TYPES = ["text", "tool_call", "genui", "interrupt", "interrupt_resolved"] as const;

export type PersistentFrameType = (typeof PERSISTENT_FRAME_TYPES)[number];

/** WS close code for an auth rejection (PROTOCOL.md §7). */
export const AUTH_CLOSE_CODE = 4401;

// ── GenUI chunk (identical to chativa's AIChunk, so the widget renders it as-is) ──

export type AIChunk =
    | { type: "ui"; component: string; props?: Record<string, unknown>; id?: string | number }
    | { type: "text"; content: string; id?: string | number }
    | { type: "event"; name: string; payload?: unknown; id?: string | number };

/** An interrupt/chip action. `value` omitted ⇒ the answer is the `label` string. */
export interface MessageAction {
    label: string;
    value?: unknown;
}

/** A component reference an interrupt can mount as an approval form. */
export interface UiRef {
    component: string;
    props?: Record<string, unknown>;
}

// ── client → server ───────────────────────────────────────────────────────────

export interface HelloFrame {
    type: "hello";
    userId?: string;
    conversationId?: string;
    watermark?: number;
    token?: string;
    /** Client-supplied context; only the allowlisted subset reaches `ctx.meta.client` (PROTOCOL.md §6). */
    meta?: Record<string, unknown>;
}

export interface TextInFrame {
    type: "text";
    data: { text: string };
    meta?: Record<string, unknown>;
}

/** Answer one or more open interrupts, keyed by thread-scoped interrupt id (PROTOCOL.md §4.4). */
export interface ResumeFrame {
    type: "resume";
    answers: Record<string, unknown>;
}

export interface GenUIEventFrame {
    type: "genui_event";
    streamId: string;
    eventType: string;
    payload?: unknown;
}

export interface AbortFrame {
    type: "abort";
}

export type IncomingFrame = HelloFrame | TextInFrame | ResumeFrame | GenUIEventFrame | AbortFrame;

// ── server → client ───────────────────────────────────────────────────────────

/** Re-announced in `welcome.data.pending` so a reconnecting UI re-renders open forms (PROTOCOL.md §3.2). */
export interface PendingView {
    id: string;
    data: { payload: unknown; ui?: UiRef; actions?: MessageAction[] };
}

export interface WelcomeFrame {
    type: "welcome";
    data: {
        protocol: string;
        conversationId: string;
        userId: string;
        connectionId: string;
        watermark: number;
        pending: PendingView[];
    };
}

export interface TextOutFrame {
    type: "text";
    id: string;
    seq: number;
    from: "bot" | "user";
    data: { text: string };
    timestamp: number;
}

export type ToolStatus = "running" | "completed" | "error";

export interface ToolCall {
    id: string;
    name: string;
    status: ToolStatus;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: string;
}

export interface ToolCallFrame {
    type: "tool_call";
    seq: number;
    data: ToolCall;
}

export interface GenUIFrame {
    type: "genui";
    seq: number;
    streamId: string;
    done: boolean;
    chunk: AIChunk;
}

export interface InterruptFrame {
    type: "interrupt";
    seq: number;
    id: string;
    data: { payload: unknown; ui?: UiRef; actions?: MessageAction[] };
}

export interface InterruptResolvedFrame {
    type: "interrupt_resolved";
    seq: number;
    id: string;
    data: { answer?: unknown };
}

export type RunStatus = "started" | "finished" | "interrupted" | "error" | "aborted";

export interface RunFrame {
    type: "run";
    data: { status: RunStatus };
}

export interface ErrorFrame {
    type: "error";
    data: { code: string; message: string };
}

export type OutgoingFrame =
    | WelcomeFrame
    | TextOutFrame
    | ToolCallFrame
    | GenUIFrame
    | InterruptFrame
    | InterruptResolvedFrame
    | RunFrame
    | ErrorFrame;

export type Frame = IncomingFrame | OutgoingFrame;

/** True for the server→client frames that carry `seq` and are transcript-persisted. */
export function isPersistent(frame: OutgoingFrame): frame is TextOutFrame | ToolCallFrame | GenUIFrame | InterruptFrame | InterruptResolvedFrame {
    return (PERSISTENT_FRAME_TYPES as readonly string[]).includes(frame.type);
}

// ── parsing ───────────────────────────────────────────────────────────────────

export class ProtocolError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = "ProtocolError";
        this.code = code;
    }
}

const INCOMING_TYPES: ReadonlySet<string> = new Set(["hello", "text", "resume", "genui_event", "abort"]);

/**
 * Parse one client→server message. Accepts a JSON string or an already-parsed
 * object. Throws `ProtocolError("bad_request", …)` on anything malformed - the
 * engine turns that into an `error` frame and keeps the connection open
 * (PROTOCOL.md §3.1).
 */
export function parseIncoming(raw: string | unknown): IncomingFrame {
    let value: unknown = raw;
    if (typeof raw === "string") {
        try {
            value = JSON.parse(raw);
        } catch {
            throw new ProtocolError("bad_request", "frame is not valid JSON");
        }
    }

    if (typeof value !== "object" || value === null) {
        throw new ProtocolError("bad_request", "frame must be a JSON object");
    }

    const type = (value as { type?: unknown }).type;
    if (typeof type !== "string" || !INCOMING_TYPES.has(type)) {
        throw new ProtocolError("bad_request", `unknown or missing frame type ${JSON.stringify(type)}`);
    }

    // Shape-check the fields the engine dereferences, so a bad frame fails here
    // (→ error{bad_request}) rather than as a deep TypeError mid-run.
    if (type === "text") {
        const data = (value as { data?: unknown }).data;
        if (typeof data !== "object" || data === null || typeof (data as { text?: unknown }).text !== "string") {
            throw new ProtocolError("bad_request", "text frame requires data.text: string");
        }
    }
    if (type === "resume") {
        const answers = (value as { answers?: unknown }).answers;
        if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
            throw new ProtocolError("bad_request", "resume frame requires answers: object");
        }
    }
    if (type === "genui_event") {
        const v = value as { streamId?: unknown; eventType?: unknown };
        if (typeof v.streamId !== "string" || typeof v.eventType !== "string") {
            throw new ProtocolError("bad_request", "genui_event requires streamId and eventType strings");
        }
    }

    return value as IncomingFrame;
}

// ── canonical JSON (for cross-language fixture comparison, PROTOCOL.md §9) ─────

/**
 * Deterministic JSON: object keys sorted ascending, arrays in order, no
 * insignificant whitespace. The wire never needs this - key order is irrelevant
 * to a JSON parser - but the golden fixtures compare TS and .NET output as
 * strings, and that comparison must not hinge on insertion order.
 */
export function canonicalize(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const v = (value as Record<string, unknown>)[key];
            // Drop undefined so `{ui: undefined}` and an absent `ui` canonicalize
            // alike - matching JSON.stringify's own omission of undefined props.
            if (v !== undefined) out[key] = sortKeys(v);
        }
        return out;
    }
    return value;
}
