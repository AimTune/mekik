// mekik as an A2A agent (PROTOCOL.md §14): the graph behind an Agent Card and
// the Agent2Agent JSON-RPC methods, so another agent can send it messages and
// answer its human-in-the-loop pauses as A2A tasks. Transport-agnostic — this
// file speaks JSON-RPC objects and drives the engine through `driveTurn`, the
// same in-process door the MCP server uses. `@mekik/a2a` and
// `Mekik.AspNetCore.MapMekikA2a` put it behind HTTP.
//
// The mapping: one mekik conversation is one A2A `contextId`; one turn is one
// task. A task whose run paused for a human is `input-required`, and the next
// message that names the task's id is the resume — its text (or a data part
// with `answers`) answers the open interrupts.

import { randomBytes } from "node:crypto";

import type { MekikApp } from "./app.ts";
import { driveTurn, summarize, type McpPendingView, type McpTurnResult } from "./mcp.ts";
import type { SkillSummary } from "./protocol.ts";

/** The A2A protocol revision this server implements. */
export const A2A_PROTOCOL_VERSION = "0.3.0";

/** A2A JSON-RPC error codes beyond the standard ones. */
export const A2A_ERRORS = {
    TASK_NOT_FOUND: -32001,
    TASK_NOT_CANCELABLE: -32002,
    UNSUPPORTED_OPERATION: -32004,
    CONTENT_TYPE_NOT_SUPPORTED: -32005,
} as const;

export type A2aTaskState =
    | "submitted"
    | "working"
    | "input-required"
    | "completed"
    | "canceled"
    | "failed"
    | "rejected"
    | "auth-required"
    | "unknown";

export type A2aPart =
    | { kind: "text"; text: string; metadata?: Record<string, unknown> }
    | { kind: "data"; data: Record<string, unknown>; metadata?: Record<string, unknown> }
    | { kind: "file"; file: Record<string, unknown>; metadata?: Record<string, unknown> };

export interface A2aMessage {
    kind: "message";
    messageId: string;
    role: "user" | "agent";
    parts: A2aPart[];
    taskId?: string;
    contextId?: string;
    metadata?: Record<string, unknown>;
}

export interface A2aArtifact {
    artifactId: string;
    name?: string;
    parts: A2aPart[];
}

export interface A2aTaskStatus {
    state: A2aTaskState;
    message?: A2aMessage;
    timestamp: string;
}

export interface A2aTask {
    kind: "task";
    id: string;
    contextId: string;
    status: A2aTaskStatus;
    artifacts?: A2aArtifact[];
    history?: A2aMessage[];
    metadata?: Record<string, unknown>;
}

export interface A2aAgentSkill {
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples?: string[];
}

export interface A2aAgentCard {
    protocolVersion: string;
    name: string;
    description: string;
    url: string;
    preferredTransport: "JSONRPC";
    version: string;
    capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
    defaultInputModes: string[];
    defaultOutputModes: string[];
    skills: A2aAgentSkill[];
}

export interface A2aServerOptions {
    /** The agent's name on its card. */
    name: string;
    /** What the agent does — what a calling agent reads on the card. */
    description?: string;
    /** Where this agent's JSON-RPC endpoint is reachable — the card's `url`. */
    url: string;
    /** The agent's version on its card. Default `"0"`. */
    version?: string;
    /**
     * Skills listed on the card. Pass the app's skill catalog summaries
     * (`catalog.list()`) so the card advertises what the agent knows; the agent
     * itself is always listed first.
     */
    skills?: readonly SkillSummary[];
    /** The mekik `userId` every A2A conversation belongs to. Default `"a2a"`. */
    userId?: string;
    /** Where tasks are kept. Default in-memory. */
    tasks?: A2aTaskStore;
    /** Clock for `status.timestamp`; injected by tests. */
    now?: () => number;
    /** Id minter for tasks and messages; injected by tests. */
    mintId?: (kind: "task" | "message" | "artifact") => string;
}

/** The task store port: a task record by id. */
export interface A2aTaskStore {
    get(id: string): Promise<A2aTask | undefined>;
    put(task: A2aTask): Promise<void>;
}

export class InMemoryA2aTaskStore implements A2aTaskStore {
    private readonly tasks = new Map<string, A2aTask>();
    async get(id: string): Promise<A2aTask | undefined> {
        return this.tasks.get(id);
    }
    async put(task: A2aTask): Promise<void> {
        this.tasks.set(task.id, task);
    }
}

/** A bad request shape — answered with JSON-RPC `-32602`. */
export class A2aRequestError extends Error {
    readonly code: number;
    constructor(message: string, code = -32602) {
        super(message);
        this.name = "A2aRequestError";
        this.code = code;
    }
}

export interface A2aJsonRpcResponse {
    jsonrpc: "2.0";
    id: string | number | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

/**
 * A `MekikApp` exposed as an A2A agent: `message/send` runs a turn (or answers
 * a paused task), `tasks/get` and `tasks/cancel` read and cancel tasks, and the
 * Agent Card describes it all.
 *
 * ```ts
 * const agent = new MekikA2aServer(app, { name: "Support desk", url: "https://bot.example.com/a2a", skills: catalog.list() });
 * agent.agentCard();                                          // for /.well-known/agent-card.json
 * await agent.handle({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message } });
 * ```
 */
export class MekikA2aServer {
    private readonly app: MekikApp;
    private readonly options: A2aServerOptions;
    private readonly tasks: A2aTaskStore;
    private readonly now: () => number;
    private readonly mint: (kind: "task" | "message" | "artifact") => string;
    private connSeq = 0;

    constructor(app: MekikApp, options: A2aServerOptions) {
        if (!options.name) throw new Error("an A2A agent needs a name");
        if (!options.url) throw new Error("an A2A agent card needs the url its JSON-RPC endpoint is served at");
        this.app = app;
        this.options = options;
        this.tasks = options.tasks ?? new InMemoryA2aTaskStore();
        this.now = options.now ?? Date.now;
        this.mint = options.mintId ?? ((kind) => `${kind}-${randomBytes(8).toString("base64url")}`);
    }

    /** The Agent Card (`/.well-known/agent-card.json`). */
    agentCard(): A2aAgentCard {
        const description = this.options.description ?? `The ${this.options.name} agent, served by mekik.`;
        const skills: A2aAgentSkill[] = [
            { id: "chat", name: this.options.name, description, tags: ["chat"] },
            ...(this.options.skills ?? []).map((s) => ({ id: s.name, name: s.name, description: s.description, tags: [...(s.tags ?? [])] })),
        ];
        return {
            protocolVersion: A2A_PROTOCOL_VERSION,
            name: this.options.name,
            description,
            url: this.options.url,
            preferredTransport: "JSONRPC",
            version: this.options.version ?? "0",
            capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
            defaultInputModes: ["text/plain"],
            defaultOutputModes: ["text/plain"],
            skills,
        };
    }

    /** Handle one JSON-RPC message. Returns `null` for a notification. */
    async handle(message: unknown): Promise<A2aJsonRpcResponse | null> {
        if (typeof message !== "object" || message === null || Array.isArray(message)) {
            return rpcError(null, -32600, "request must be a JSON-RPC object");
        }
        const req = message as { jsonrpc?: unknown; id?: string | number | null; method?: unknown; params?: unknown };
        const id = req.id === undefined ? null : req.id;
        if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
            return rpcError(id, -32600, "request must carry jsonrpc \"2.0\" and a method");
        }
        if (req.id === undefined) return null;
        const params = (typeof req.params === "object" && req.params !== null ? req.params : {}) as Record<string, unknown>;

        try {
            switch (req.method) {
                case "message/send":
                    return { jsonrpc: "2.0", id, result: await this.sendMessage(params) };
                case "tasks/get": {
                    const task = await this.getTask(requireString(params.id, "id"), typeof params.historyLength === "number" ? params.historyLength : undefined);
                    return { jsonrpc: "2.0", id, result: task };
                }
                case "tasks/cancel":
                    return { jsonrpc: "2.0", id, result: await this.cancelTask(requireString(params.id, "id")) };
                case "message/stream":
                case "tasks/resubscribe":
                    return rpcError(id, A2A_ERRORS.UNSUPPORTED_OPERATION, `${req.method} is not supported: this agent does not stream`);
                case "tasks/pushNotificationConfig/set":
                case "tasks/pushNotificationConfig/get":
                case "tasks/pushNotificationConfig/list":
                case "tasks/pushNotificationConfig/delete":
                    return rpcError(id, A2A_ERRORS.UNSUPPORTED_OPERATION, `${req.method} is not supported: this agent does not push notifications`);
                default:
                    return rpcError(id, -32601, `method not found: ${req.method}`);
            }
        } catch (err) {
            if (err instanceof A2aRequestError) return rpcError(id, err.code, err.message);
            return rpcError(id, -32603, err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * `message/send`: a message without `taskId` starts a task — a new turn on
     * the conversation `contextId` names, or a fresh conversation; a message
     * naming an `input-required` task answers its open interrupts and continues
     * it. Returns the task.
     */
    async sendMessage(params: Record<string, unknown>): Promise<A2aTask> {
        const message = parseMessage(params.message);
        if (message.taskId !== undefined) return this.resume(message);

        const text = textOf(message);
        if (text.length === 0) throw new A2aRequestError("message needs at least one text part", A2A_ERRORS.CONTENT_TYPE_NOT_SUPPORTED);
        const taskId = this.mint("task");
        const turn = await driveTurn(this.app, `a2a-${++this.connSeq}`, this.options.userId ?? "a2a", message.contextId, { type: "text", data: { text } });
        const result = summarize(turn.conversationId, turn.frames, "message/send with taskId", false).structuredContent;
        const task = this.toTask(taskId, result, [{ ...message, taskId, contextId: turn.conversationId }], undefined);
        await this.tasks.put(task);
        return task;
    }

    private async resume(message: A2aMessage): Promise<A2aTask> {
        const existing = await this.tasks.get(message.taskId!);
        if (!existing) throw new A2aRequestError(`task ${JSON.stringify(message.taskId)} not found`, A2A_ERRORS.TASK_NOT_FOUND);
        if (existing.status.state !== "input-required") {
            throw new A2aRequestError(`task ${JSON.stringify(existing.id)} is ${existing.status.state} and takes no more input`, -32602);
        }
        const pending = (existing.metadata?.pending as McpPendingView[] | undefined) ?? [];
        const answers = answersFor(message, pending);
        const turn = await driveTurn(this.app, `a2a-${++this.connSeq}`, this.options.userId ?? "a2a", existing.contextId, { type: "resume", answers });
        const result = summarize(turn.conversationId, turn.frames, "message/send with taskId", false).structuredContent;
        const task = this.toTask(existing.id, result, [...(existing.history ?? []), { ...message, contextId: existing.contextId }], existing);
        await this.tasks.put(task);
        return task;
    }

    /** `tasks/get`: the task, its history truncated to the last `historyLength` messages when given. */
    async getTask(id: string, historyLength?: number): Promise<A2aTask> {
        const task = await this.tasks.get(id);
        if (!task) throw new A2aRequestError(`task ${JSON.stringify(id)} not found`, A2A_ERRORS.TASK_NOT_FOUND);
        if (historyLength !== undefined && task.history !== undefined) {
            return { ...task, history: historyLength <= 0 ? [] : task.history.slice(-historyLength) };
        }
        return task;
    }

    /**
     * `tasks/cancel`: an `input-required` task becomes `canceled` — the
     * conversation stays parked on its interrupts (mekik never discards a pause
     * on a caller's behalf), so a later message on the same context is refused
     * until a mekik client answers them. A finished task is not cancelable.
     */
    async cancelTask(id: string): Promise<A2aTask> {
        const task = await this.tasks.get(id);
        if (!task) throw new A2aRequestError(`task ${JSON.stringify(id)} not found`, A2A_ERRORS.TASK_NOT_FOUND);
        if (task.status.state !== "input-required") {
            throw new A2aRequestError(`task ${JSON.stringify(id)} is ${task.status.state} and cannot be canceled`, A2A_ERRORS.TASK_NOT_CANCELABLE);
        }
        const canceled: A2aTask = { ...task, status: { state: "canceled", timestamp: this.timestamp() } };
        await this.tasks.put(canceled);
        return canceled;
    }

    private toTask(id: string, result: McpTurnResult, history: A2aMessage[], previous: A2aTask | undefined): A2aTask {
        const state = stateOf(result.status);
        const artifacts: A2aArtifact[] = [...(previous?.artifacts ?? [])];
        if (result.reply.length > 0) {
            artifacts.push({ artifactId: this.mint("artifact"), name: "reply", parts: [{ kind: "text", text: result.reply }] });
        }
        const statusMessage = this.statusMessage(id, result);
        if (statusMessage) history.push(statusMessage);
        const metadata: Record<string, unknown> = {
            mekik: { conversationId: result.conversationId, status: result.status, toolCalls: result.toolCalls, skills: result.skills },
        };
        if (result.pending.length > 0) metadata.pending = result.pending;
        const task: A2aTask = {
            kind: "task",
            id,
            contextId: result.conversationId,
            status: { state, ...(statusMessage ? { message: statusMessage } : {}), timestamp: this.timestamp() },
            artifacts,
            history,
            metadata,
        };
        return task;
    }

    /** The agent's status message: what the caller must do next, or why the turn stopped. */
    private statusMessage(taskId: string, result: McpTurnResult): A2aMessage | undefined {
        let text: string | undefined;
        const parts: A2aPart[] = [];
        switch (result.status) {
            case "interrupted":
                text =
                    "The agent needs input before it can continue:\n" +
                    result.pending.map((p) => `- interrupt ${JSON.stringify(p.id)}: ${describe(p)}`).join("\n") +
                    "\nReply on this task: a text message answers a single open interrupt (an action's label or value), or a data part {\"answers\": {<interrupt id>: <answer>}} answers several.";
                parts.push({ kind: "data", data: { pending: result.pending } });
                break;
            case "error":
                text = result.reply.length > 0 ? result.reply : "the run failed";
                break;
            case "refused": {
                text = result.reply.length > 0 ? result.reply : "the turn was refused";
                break;
            }
            case "aborted":
                text = "The run was aborted; the conversation can be continued.";
                break;
            case "finished":
                return undefined;
        }
        if (text === undefined) return undefined;
        return {
            kind: "message",
            messageId: this.mint("message"),
            role: "agent",
            taskId,
            contextId: result.conversationId,
            parts: [{ kind: "text", text }, ...parts],
        };
    }

    private timestamp(): string {
        return new Date(this.now()).toISOString();
    }
}

// ── pure helpers ──────────────────────────────────────────────────────────────

/** A2A task state for a turn's status. */
export function stateOf(status: McpTurnResult["status"]): A2aTaskState {
    switch (status) {
        case "finished":
            return "completed";
        case "interrupted":
            return "input-required";
        case "error":
            return "failed";
        case "aborted":
            return "canceled";
        case "refused":
            return "rejected";
    }
}

/** Validate an inbound `message` param into an {@link A2aMessage}; throws {@link A2aRequestError}. */
export function parseMessage(raw: unknown): A2aMessage {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new A2aRequestError("`message` is required");
    const m = raw as Record<string, unknown>;
    if (m.role !== "user" && m.role !== "agent") throw new A2aRequestError("`message.role` must be \"user\" or \"agent\"");
    if (!Array.isArray(m.parts) || m.parts.length === 0) throw new A2aRequestError("`message.parts` must be a non-empty array");
    const parts: A2aPart[] = m.parts.map((p, i) => {
        if (typeof p !== "object" || p === null) throw new A2aRequestError(`message.parts[${i}] must be an object`);
        const part = p as Record<string, unknown>;
        if (part.kind === "text" && typeof part.text === "string") return { kind: "text", text: part.text };
        if (part.kind === "data" && typeof part.data === "object" && part.data !== null) return { kind: "data", data: part.data as Record<string, unknown> };
        if (part.kind === "file" && typeof part.file === "object" && part.file !== null) return { kind: "file", file: part.file as Record<string, unknown> };
        throw new A2aRequestError(`message.parts[${i}] must be a text, data or file part`);
    });
    const out: A2aMessage = {
        kind: "message",
        messageId: typeof m.messageId === "string" && m.messageId.length > 0 ? m.messageId : `message-${randomBytes(8).toString("base64url")}`,
        role: m.role,
        parts,
    };
    if (m.taskId !== undefined) {
        if (typeof m.taskId !== "string") throw new A2aRequestError("`message.taskId` must be a string");
        out.taskId = m.taskId;
    }
    if (m.contextId !== undefined) {
        if (typeof m.contextId !== "string") throw new A2aRequestError("`message.contextId` must be a string");
        out.contextId = m.contextId;
    }
    if (typeof m.metadata === "object" && m.metadata !== null) out.metadata = m.metadata as Record<string, unknown>;
    return out;
}

/** The text parts of a message, joined by newlines. */
export function textOf(message: A2aMessage): string {
    return message.parts
        .filter((p): p is Extract<A2aPart, { kind: "text" }> => p.kind === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
}

/**
 * Turn a message on an `input-required` task into the `resume` answers
 * (PROTOCOL.md §14.3): a data part with `answers` is used as-is; otherwise a
 * single open interrupt takes the message — its text, or the value of the
 * action whose label the text matches, or the data part itself; several open
 * interrupts require the `answers` form.
 */
export function answersFor(message: A2aMessage, pending: readonly McpPendingView[]): Record<string, unknown> {
    const data = message.parts.find((p): p is Extract<A2aPart, { kind: "data" }> => p.kind === "data");
    if (data && typeof data.data.answers === "object" && data.data.answers !== null && !Array.isArray(data.data.answers)) {
        return data.data.answers as Record<string, unknown>;
    }
    if (pending.length === 0) throw new A2aRequestError("the task has no open interrupt to answer");
    if (pending.length > 1) {
        throw new A2aRequestError(
            `the task has ${pending.length} open interrupts; answer them all with a data part {"answers": {<id>: <answer>}}`,
        );
    }
    const only = pending[0]!;
    if (data) return { [only.id]: data.data };
    const text = textOf(message);
    if (text.length === 0) throw new A2aRequestError("message needs a text or data part to answer the open interrupt");
    const action = only.actions?.find((a) => a.label === text);
    return { [only.id]: action ? (action.value === undefined ? action.label : action.value) : text };
}

function describe(p: McpPendingView): string {
    if (p.tool !== undefined) return `a client tool call (${p.tool}) that only the conversation's own UI can answer`;
    const payload = typeof p.payload === "object" && p.payload !== null ? JSON.stringify(p.payload) : String(p.payload);
    const actions = p.actions?.length ? ` — options: ${p.actions.map((a) => a.label).join(", ")}` : "";
    return `${payload}${actions}`;
}

function requireString(v: unknown, field: string): string {
    if (typeof v !== "string" || v.length === 0) throw new A2aRequestError(`\`${field}\` (string) is required`);
    return v;
}

function rpcError(id: string | number | null, code: number, message: string): A2aJsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
}
