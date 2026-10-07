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
 * else is transient: live-only, never stored, never replayed — except the open
 * *rich message frame* family (PROTOCOL.md §4.5): frames whose `type` is a
 * client message-renderer name are persistent too; see {@link isMessageFrame}.
 */
export const PERSISTENT_FRAME_TYPES = ["text", "tool_call", "skill", "genui", "interrupt", "interrupt_resolved"] as const;

export type PersistentFrameType = (typeof PERSISTENT_FRAME_TYPES)[number];

/**
 * Frame types the protocol itself owns, in either direction — a rich message
 * frame (PROTOCOL.md §4.5) may use any `type` EXCEPT these (`"text"` is the one
 * deliberate overlap: a text message frame IS the `text` frame). `"typing"` is
 * reserved defensively: chativa's shared frame parser claims it.
 */
export const RESERVED_FRAME_TYPES: ReadonlySet<string> = new Set([
    "hello",
    "welcome",
    "text",
    "resume",
    "genui_event",
    "client_tools",
    "client_skills",
    "abort",
    "tool_call",
    "skill",
    "skills",
    "genui",
    "genui_components",
    "interrupt",
    "interrupt_resolved",
    "run",
    "error",
    "typing",
]);

/**
 * The reserved genui **event-chunk name** that carries a fire-and-forget client
 * tool invocation (PROTOCOL.md §11.3): `{type:"event", name:"client_tool",
 * payload:{name, params?}}`. A client routes chunks with this name to its tool
 * registry instead of the mounted components.
 */
export const CLIENT_TOOL_EVENT = "client_tool";

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

// ── client tools (PROTOCOL.md §11) ────────────────────────────────────────────

/**
 * How a client tool is invoked (PROTOCOL.md §11.3): `"call"` round-trips — the
 * run parks on an interrupt until the client answers with the tool's result —
 * while `"notify"` fires and forgets as a genui event chunk. Default: `"call"`.
 */
export type ClientToolMode = "call" | "notify";

/**
 * One tool the **client** declares it can execute (PROTOCOL.md §11.1): a UI
 * capability — render a card, open a picker, read the device — described well
 * enough for a server-side model to call it. Declared in `hello.tools` or a
 * `client_tools` frame; the server snapshots the declarations into
 * `ctx.meta.clientTools` per turn (only when {@link MekikOptions.clientTools}
 * opts in — the default is off).
 *
 * A declaration is **capability, not authority**: it changes what the server
 * *may ask the client to do*, never what the server itself does. Authorization
 * and side effects stay server-side.
 */
export interface ClientToolDefinition {
    /** Unique per connection; a redeclared name replaces the earlier one. */
    name: string;
    /** What the tool does — this is what a model reads. */
    description?: string;
    /** JSON Schema for the tool's parameters (a model's `input_schema`). */
    parameters?: Record<string, unknown>;
    /**
     * Server-side filter labels (PROTOCOL.md §11.2). A tool with no tags is
     * unrestricted — every {@link clientTools} query returns it; a tagged tool is
     * returned only by queries whose tags intersect its own. This is how one
     * node sees a tool another node does not.
     */
    tags?: string[];
    /** Invocation mode; see {@link ClientToolMode}. Default `"call"`. */
    mode?: ClientToolMode;
}

/** A client tool invocation as it travels on an `interrupt` frame (`data.tool`, PROTOCOL.md §11.3). */
export interface ClientToolCall {
    name: string;
    params?: Record<string, unknown>;
}

/**
 * Sanitize a client-declared tool list (PROTOCOL.md §11.1): drop anything that
 * is not a definition with a non-empty string `name`, keep only the known,
 * correctly-typed fields, and dedupe by name (last declaration wins). Pure —
 * the engine applies it to `hello.tools` and `client_tools.tools`, and a client
 * library may use it to validate before sending.
 */
export function sanitizeClientTools(value: unknown): ClientToolDefinition[] {
    if (!Array.isArray(value)) return [];
    const byName = new Map<string, ClientToolDefinition>();
    for (const entry of value) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.name !== "string" || e.name.length === 0) continue;
        const def: ClientToolDefinition = { name: e.name };
        if (typeof e.description === "string") def.description = e.description;
        if (typeof e.parameters === "object" && e.parameters !== null && !Array.isArray(e.parameters)) {
            def.parameters = e.parameters as Record<string, unknown>;
        }
        if (Array.isArray(e.tags)) {
            const tags = e.tags.filter((t): t is string => typeof t === "string" && t.length > 0);
            if (tags.length > 0) def.tags = [...new Set(tags)];
        }
        if (e.mode === "call" || e.mode === "notify") def.mode = e.mode;
        byName.set(def.name, def);
    }
    return [...byName.values()];
}

// ── skills (PROTOCOL.md §12) ──────────────────────────────────────────────────

/** Where a skill came from: the server's catalog, or a client's declaration (§12.3). */
export type SkillOrigin = "server" | "client";

/**
 * Level 1 of a skill — what a model sees before choosing one (PROTOCOL.md
 * §12.1). This is what the `skills` catalog frame carries and what
 * `mekik.skills(ctx)` returns.
 */
export interface SkillSummary {
    /** 1–64 lowercase letters, digits and single hyphens (the Agent Skills name rule). */
    name: string;
    /** What the skill does and when to use it — the whole trigger surface. */
    description: string;
    /**
     * Server-side filter labels, the same rule as client tool tags (§11.2): an
     * untagged skill is unrestricted, a tagged one is returned only by queries
     * whose tags intersect its own.
     */
    tags?: string[];
    /** Stamped by the turn snapshot; absent on a source's own entries. */
    source?: SkillOrigin;
}

/**
 * Level 2 — a skill with its instructions, as a source hands it back.
 *
 * `TTool` is the agent framework's tool type: `@mekik/core` stays
 * framework-agnostic, so a plain `SkillEntry` carries `unknown` tools and an
 * integration closes it — `SkillEntry<StructuredToolInterface>` for
 * `@mekik/langchain`.
 */
export interface SkillEntry<TTool = unknown> extends SkillSummary {
    /** The markdown a model reads once it has chosen the skill. */
    instructions: string;
    /**
     * The tools this skill owns (§12.6): an agent loop offers them to the model
     * only after it loads the skill. **Server-side only** — never serialized:
     * not on the `skills` catalog frame, not in the catalog hash, not on a
     * `skill` frame. A client-declared skill (§12.4) can never carry tools.
     */
    tools?: readonly TTool[];
}

/**
 * One skill the **client** declares (PROTOCOL.md §12.4): instructions the
 * frontend wants the model to follow when a task matches — a house style, a
 * product's UI conventions. Inline, because a client has no folder to serve:
 * the whole skill travels in the declaration. Accepted only when
 * {@link MekikOptions.clientSkills} opts in — the default is off.
 */
export interface ClientSkillDefinition {
    name: string;
    description: string;
    instructions: string;
    tags?: string[];
}

/** Trace status for a `skill` frame: the instructions were handed to the node, or the name was unknown. */
export type SkillStatus = "loaded" | "error";

/** One skill use as it travels on a `skill` frame (PROTOCOL.md §12.5). */
export interface SkillUse {
    /** Replay-stable id, minted like a tool call's. */
    id: string;
    name: string;
    status: SkillStatus;
    source?: SkillOrigin;
    error?: string;
}

export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The Agent Skills name rule: lowercase letters, digits and single hyphens, 1–64 characters. */
export function isValidSkillName(name: string): boolean {
    return name.length > 0 && name.length <= SKILL_NAME_MAX && SKILL_NAME_PATTERN.test(name);
}

/**
 * Sanitize a client-declared skill list (PROTOCOL.md §12.4): keep only entries
 * with a valid `name`, a non-empty `description` of at most 1024 characters
 * and a string `instructions`; keep only the known fields; dedupe by name
 * (last declaration wins). Pure — the engine applies it to `hello.skills` and
 * `client_skills.skills`.
 */
export function sanitizeClientSkills(value: unknown): ClientSkillDefinition[] {
    if (!Array.isArray(value)) return [];
    const byName = new Map<string, ClientSkillDefinition>();
    for (const entry of value) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.name !== "string" || !isValidSkillName(e.name)) continue;
        if (typeof e.description !== "string") continue;
        const description = e.description.trim();
        if (description.length === 0 || description.length > SKILL_DESCRIPTION_MAX) continue;
        if (typeof e.instructions !== "string") continue;
        const def: ClientSkillDefinition = { name: e.name, description, instructions: e.instructions };
        if (Array.isArray(e.tags)) {
            const tags = e.tags.filter((t): t is string => typeof t === "string" && t.length > 0);
            if (tags.length > 0) def.tags = [...new Set(tags)];
        }
        byName.set(def.name, def);
    }
    return [...byName.values()];
}

// ── client → server ───────────────────────────────────────────────────────────

export interface HelloFrame {
    type: "hello";
    userId?: string;
    conversationId?: string;
    watermark?: number;
    token?: string;
    /**
     * Hash of the component catalog this client has cached (PROTOCOL.md §10.2).
     * Equal to the server's hash ⇒ the catalog is not re-sent.
     */
    componentsHash?: string;
    /** Client-supplied context; only the allowlisted subset reaches `ctx.meta.client` (PROTOCOL.md §6). */
    meta?: Record<string, unknown>;
    /**
     * Tools this client can execute (PROTOCOL.md §11.1). Inert unless the server
     * opts in via {@link MekikOptions.clientTools}; replaced wholesale by a later
     * `client_tools` frame.
     */
    tools?: ClientToolDefinition[];
    /**
     * Hash of the server skill catalog this client has cached (PROTOCOL.md §12.2).
     * Equal to the server's hash ⇒ the summaries are not re-sent.
     */
    skillsHash?: string;
    /**
     * Skills this client declares (PROTOCOL.md §12.4). Inert unless the server
     * opts in via {@link MekikOptions.clientSkills}; replaced wholesale by a later
     * `client_skills` frame.
     */
    skills?: ClientSkillDefinition[];
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

/**
 * Who an interaction is addressed to (PROTOCOL.md §10.4). The markup picks it:
 * `component-event` sends `"component"`, `mekik-event` sends `"graph"`, and the
 * original `data-event` sends neither — an unscoped event tries both routes.
 */
export type GenUIEventScope = "component" | "graph";

export interface GenUIEventFrame {
    type: "genui_event";
    streamId: string;
    eventType: string;
    /** Omitted by a plain `data-event`; see {@link GenUIEventScope}. */
    scope?: GenUIEventScope;
    /** The registry name of the component the interaction came from, when the client knows it. */
    component?: string;
    payload?: unknown;
}

/**
 * Replace this connection's declared client tools (PROTOCOL.md §11.1). The list
 * is the connection's whole new set — sending `[]` withdraws every tool. Like
 * `hello.tools`, inert unless the server opted in.
 */
export interface ClientToolsFrame {
    type: "client_tools";
    tools: ClientToolDefinition[];
}

/**
 * Replace this connection's declared client skills (PROTOCOL.md §12.4). The
 * list is the connection's whole new set — sending `[]` withdraws every skill.
 * Like `hello.skills`, inert unless the server opted in.
 */
export interface ClientSkillsFrame {
    type: "client_skills";
    skills: ClientSkillDefinition[];
}

export interface AbortFrame {
    type: "abort";
}

export type IncomingFrame =
    | HelloFrame
    | TextInFrame
    | ResumeFrame
    | GenUIEventFrame
    | ClientToolsFrame
    | ClientSkillsFrame
    | AbortFrame;

// ── server → client ───────────────────────────────────────────────────────────

/**
 * Re-announced in `welcome.data.pending` so a reconnecting UI re-renders open forms
 * (PROTOCOL.md §3.2). `data` is the `interrupt` frame's `data`, verbatim — including
 * `event` (a pause waiting on a component interaction, §10.4) and `tool` (an open
 * client tool call, §11.3).
 */
export interface PendingView {
    id: string;
    data: { payload: unknown; ui?: UiRef; actions?: MessageAction[]; event?: string; tool?: ClientToolCall };
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

/**
 * A rich message frame (PROTOCOL.md §4.5): the `text` frame's envelope with an
 * open `type` naming a client message renderer (`"image"`, `"card"`,
 * `"carousel"`, …) and that renderer's payload as `data`. Persistent — same
 * seq/replay/watermark rules as `text`. A client without a renderer for the
 * `type` ignores the frame (the additive-change rule, PROTOCOL.md preamble).
 */
export interface MessageOutFrame {
    /** A client message-renderer name; never one of {@link RESERVED_FRAME_TYPES}. */
    type: string;
    id: string;
    seq: number;
    from: "bot" | "user";
    data: Record<string, unknown>;
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

/**
 * A skill was loaded into a node (PROTOCOL.md §12.5) — the trace that lets a
 * client show "using skill: pdf" the way it shows a tool call. Persistent;
 * upserts by `data.id`.
 */
export interface SkillFrame {
    type: "skill";
    seq: number;
    data: SkillUse;
}

/**
 * The server's skill catalog, sent once per connection after `welcome`
 * (PROTOCOL.md §12.2). Transient, like `genui_components`: `unchanged: true`
 * means the client's cached catalog matches `hash` and no summaries follow.
 * Client-declared skills are never echoed here — a client already knows what
 * it declared.
 */
export interface SkillsFrame {
    type: "skills";
    hash: string;
    unchanged?: boolean;
    skills?: SkillSummary[];
}

export interface GenUIFrame {
    type: "genui";
    seq: number;
    streamId: string;
    done: boolean;
    chunk: AIChunk;
}

/**
 * A component the server defines itself (PROTOCOL.md §10). Markup, not code:
 * the client registers it under `name` and mounts it from a `ui` chunk.
 */
export interface GenUiComponentDefinition {
    /** Registry name a `ui` chunk mounts by. */
    name: string;
    /** Markup with `{{…}}` placeholders (§10.3). */
    template: string;
    /** Optional CSS, scoped to the component on the client. */
    css?: string;
    /** Prop defaults; also the declaration the client makes reactive. */
    props?: Record<string, unknown>;
    /** Definition version — a change re-registers the component. */
    version?: string;
    /** Custom element tag on the client. Derived from `name` when omitted. */
    tag?: string;
}

/**
 * The component catalog, sent once per connection after `welcome` (§10.2).
 * Transient: no `seq`, never persisted, never replayed. `unchanged: true`
 * means the client's cached catalog matches `hash` and no markup follows.
 */
export interface GenUiComponentsFrame {
    type: "genui_components";
    hash: string;
    unchanged?: boolean;
    components?: GenUiComponentDefinition[];
}

export interface InterruptFrame {
    type: "interrupt";
    seq: number;
    id: string;
    /**
     * `event` is set when the pause is waiting for a component interaction rather
     * than an answer (PROTOCOL.md §10.4): the named `data-event` resolves it, and the
     * client should not offer default Approve/Cancel chips. `tool` is set when the
     * pause is a **client tool call** (PROTOCOL.md §11.3): the client runs the named
     * tool and answers with `{ok, result?|error?}` — again, no default chips.
     */
    data: { payload: unknown; ui?: UiRef; actions?: MessageAction[]; event?: string; tool?: ClientToolCall };
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
    | MessageOutFrame
    | ToolCallFrame
    | SkillFrame
    | SkillsFrame
    | GenUIFrame
    | GenUiComponentsFrame
    | InterruptFrame
    | InterruptResolvedFrame
    | RunFrame
    | ErrorFrame;

export type Frame = IncomingFrame | OutgoingFrame;

/**
 * True for a rich message frame (PROTOCOL.md §4.5): the `text` envelope under a
 * non-reserved `type`. Only the mapper mints these, so the shape check is a
 * guard against misclassifying, not a validator.
 */
export function isMessageFrame(frame: OutgoingFrame): frame is MessageOutFrame {
    return (
        typeof frame.type === "string" &&
        !RESERVED_FRAME_TYPES.has(frame.type) &&
        typeof (frame as MessageOutFrame).id === "string" &&
        typeof (frame as MessageOutFrame).seq === "number"
    );
}

/** True for the server→client frames that carry `seq` and are transcript-persisted. */
export function isPersistent(
    frame: OutgoingFrame,
): frame is TextOutFrame | MessageOutFrame | ToolCallFrame | SkillFrame | GenUIFrame | InterruptFrame | InterruptResolvedFrame {
    return (PERSISTENT_FRAME_TYPES as readonly string[]).includes(frame.type) || isMessageFrame(frame);
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

const INCOMING_TYPES: ReadonlySet<string> = new Set(["hello", "text", "resume", "genui_event", "client_tools", "client_skills", "abort"]);

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
        const v = value as { streamId?: unknown; eventType?: unknown; scope?: unknown };
        if (typeof v.streamId !== "string" || typeof v.eventType !== "string") {
            throw new ProtocolError("bad_request", "genui_event requires streamId and eventType strings");
        }
        if (v.scope !== undefined && v.scope !== "component" && v.scope !== "graph") {
            throw new ProtocolError("bad_request", 'genui_event scope must be "component" or "graph"');
        }
    }
    if (type === "client_tools") {
        const tools = (value as { tools?: unknown }).tools;
        if (!Array.isArray(tools)) {
            throw new ProtocolError("bad_request", "client_tools frame requires tools: array");
        }
    }
    if (type === "client_skills") {
        const skills = (value as { skills?: unknown }).skills;
        if (!Array.isArray(skills)) {
            throw new ProtocolError("bad_request", "client_skills frame requires skills: array");
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
