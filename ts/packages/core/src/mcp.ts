// mekik as an MCP server (PROTOCOL.md §13): a graph becomes a tool another
// agent can call. Transport-agnostic — this file speaks JSON-RPC objects and
// drives the engine through an in-process `Connection`, exactly as the
// conformance suite does. `@mekik/mcp` puts it behind Streamable HTTP;
// `Mekik.AspNetCore.MapMekikMcp` is the .NET twin.
//
// The mapping is deliberately small: one turn == one `tools/call`. A finished
// run returns the reply; a run that paused for a human returns the open
// interrupts and asks the caller to answer them through the `<name>__resume`
// tool — so human-in-the-loop survives the hop into another agent's toolbox.

import type { MekikApp } from "./app.ts";
import type { Connection } from "./engine.ts";
import type {
    ErrorFrame,
    GenUIFrame,
    InterruptFrame,
    MessageAction,
    OutgoingFrame,
    RunFrame,
    SkillFrame,
    TextOutFrame,
    ToolCall,
    ToolCallFrame,
    WelcomeFrame,
} from "./protocol.ts";

/** The MCP protocol revisions this server speaks; the first is what it answers an unknown request with. */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** A tool as `tools/list` advertises it. */
export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

/** A `tools/call` result (MCP `CallToolResult`), the subset mekik emits. */
export interface McpCallToolResult {
    content: Array<{ type: "text"; text: string }>;
    structuredContent: McpTurnResult;
    isError?: boolean;
}

/** One open pause, as a caller sees it in `structuredContent.pending`. */
export interface McpPendingView {
    id: string;
    payload: unknown;
    actions?: MessageAction[];
    /** Set when the pause is a client tool call (§11.3) — an MCP caller cannot answer those. */
    tool?: string;
}

/** The structured half of a turn's result — everything a calling agent may want to branch on. */
export interface McpTurnResult {
    conversationId: string;
    status: "finished" | "interrupted" | "error" | "aborted" | "refused";
    /** The consolidated reply text (finished), the error text (error, refused), or `""`. */
    reply: string;
    /** Open pauses to answer through `<name>__resume`. Empty unless `status` is `interrupted`. */
    pending: McpPendingView[];
    /** Tools the run traced, last status per id. */
    toolCalls: Array<{ id: string; name: string; status: string }>;
    /** Skills the run loaded. */
    skills: string[];
    /** The persistent frames of the turn, when {@link McpServerOptions.includeFrames} is on. */
    frames?: OutgoingFrame[];
}

export interface McpServerOptions {
    /** The tool's name — what a calling agent invokes. Letters, digits, `_` and `-`, at most 64 characters. */
    name: string;
    /** What the agent does; this is what a calling model reads. */
    description?: string;
    /** `serverInfo` in the `initialize` result. Default `{ name: "mekik", version: "0" }`. */
    serverInfo?: { name: string; version: string };
    /** The mekik `userId` every MCP conversation belongs to. Default `"mcp"`. */
    userId?: string;
    /** Put the turn's persistent frames in `structuredContent.frames`. Default off. */
    includeFrames?: boolean;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// ── JSON-RPC ──────────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: string | number | null;
    method: string;
    params?: unknown;
}

export interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: string | number | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

export const JSON_RPC = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
} as const;

/**
 * A `MekikApp` exposed as an MCP server: two tools — `<name>` runs a turn,
 * `<name>__resume` answers a paused one — over any JSON-RPC transport.
 *
 * ```ts
 * const server = new MekikMcpServer(app, { name: "support_desk", description: "Answers support questions." });
 * server.tools();                                              // for tools/list
 * await server.callTool("support_desk", { message: "Where is ORD-42?" });
 * await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });   // any transport
 * ```
 */
export class MekikMcpServer {
    readonly name: string;
    private readonly app: MekikApp;
    private readonly options: McpServerOptions;
    private connSeq = 0;

    constructor(app: MekikApp, options: McpServerOptions) {
        if (!TOOL_NAME.test(options.name)) {
            throw new Error(`MCP tool name ${JSON.stringify(options.name)} must be 1–64 letters, digits, "_" or "-"`);
        }
        this.app = app;
        this.options = options;
        this.name = options.name;
    }

    /** The resume tool's name: `<name>__resume`. */
    get resumeName(): string {
        return `${this.name}__resume`;
    }

    /** What `tools/list` advertises. */
    tools(): McpToolDefinition[] {
        const description = this.options.description ?? `Talk to the ${this.name} agent.`;
        return [
            {
                name: this.name,
                description:
                    `${description} Send one message and receive the agent's reply. If the result says it is ` +
                    `"interrupted", the agent is waiting for an answer: call ${this.resumeName} with the conversationId and answers.`,
                inputSchema: {
                    type: "object",
                    properties: {
                        message: { type: "string", description: "The user's message for this turn." },
                        conversationId: {
                            type: "string",
                            description: "Continue an existing conversation (from a previous result). Omit to start a new one.",
                        },
                    },
                    required: ["message"],
                },
            },
            {
                name: this.resumeName,
                description:
                    `Answer the open interrupts of a paused ${this.name} conversation and continue it. ` +
                    `Every id listed in the previous result's pending[] must be answered.`,
                inputSchema: {
                    type: "object",
                    properties: {
                        conversationId: { type: "string", description: "The paused conversation, from the previous result." },
                        answers: {
                            type: "object",
                            description: "Answers keyed by interrupt id. For a pause with actions, an action's value (or its label).",
                            additionalProperties: true,
                        },
                    },
                    required: ["conversationId", "answers"],
                },
            },
        ];
    }

    /**
     * Run one tool. Argument shape errors throw (the JSON-RPC layer maps them to
     * `-32602`); a turn that fails inside the graph is a **result** with
     * `isError: true`, as the protocol wants — the tool ran, the agent failed.
     */
    async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallToolResult> {
        if (name === this.name) {
            const message = args.message;
            if (typeof message !== "string") throw new McpArgumentError("`message` (string) is required");
            const conversationId = optionalString(args.conversationId, "conversationId");
            return this.turn(conversationId, { type: "text", data: { text: message } });
        }
        if (name === this.resumeName) {
            const conversationId = optionalString(args.conversationId, "conversationId");
            if (conversationId === undefined) throw new McpArgumentError("`conversationId` (string) is required");
            const answers = args.answers;
            if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
                throw new McpArgumentError("`answers` (object keyed by interrupt id) is required");
            }
            return this.turn(conversationId, { type: "resume", answers: answers as Record<string, unknown> });
        }
        throw new McpArgumentError(`unknown tool ${JSON.stringify(name)}`);
    }

    /** Handle one JSON-RPC message. Returns `null` for a notification (nothing to send back). */
    async handle(message: unknown): Promise<JsonRpcResponse | null> {
        if (typeof message !== "object" || message === null || Array.isArray(message)) {
            return rpcError(null, JSON_RPC.INVALID_REQUEST, "request must be a JSON-RPC object");
        }
        const req = message as Partial<JsonRpcRequest>;
        const id = req.id === undefined ? null : req.id;
        if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
            return rpcError(id, JSON_RPC.INVALID_REQUEST, "request must carry jsonrpc \"2.0\" and a method");
        }
        if (req.id === undefined) return null; // a notification: initialized, cancelled, progress …

        const params = (typeof req.params === "object" && req.params !== null ? req.params : {}) as Record<string, unknown>;
        switch (req.method) {
            case "initialize": {
                const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
                        capabilities: { tools: {} },
                        serverInfo: this.options.serverInfo ?? { name: "mekik", version: "0" },
                    },
                };
            }
            case "ping":
                return { jsonrpc: "2.0", id, result: {} };
            case "tools/list":
                return { jsonrpc: "2.0", id, result: { tools: this.tools() } };
            case "tools/call": {
                if (typeof params.name !== "string") return rpcError(id, JSON_RPC.INVALID_PARAMS, "`name` is required");
                const args = typeof params.arguments === "object" && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
                try {
                    return { jsonrpc: "2.0", id, result: await this.callTool(params.name, args) };
                } catch (err) {
                    if (err instanceof McpArgumentError) return rpcError(id, JSON_RPC.INVALID_PARAMS, err.message);
                    return rpcError(id, JSON_RPC.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
                }
            }
            default:
                return rpcError(id, JSON_RPC.METHOD_NOT_FOUND, `method not found: ${req.method}`);
        }
    }

    // ── one turn over an in-process connection ────────────────────────────────

    private async turn(conversationId: string | undefined, frame: Record<string, unknown>): Promise<McpCallToolResult> {
        const { conversationId: convId, frames } = await driveTurn(this.app, `mcp-${++this.connSeq}`, this.options.userId ?? "mcp", conversationId, frame);
        return summarize(convId, frames, this.resumeName, this.options.includeFrames === true);
    }
}

/**
 * Run one turn of an app over an in-process connection and collect the frames
 * it produced (PROTOCOL.md §13.2, §14.2): connect as `userId` on
 * `conversationId` (a fresh conversation when undefined or unknown), drop the
 * handshake and replay, send `frame`, return what came back. Shared by the MCP
 * and A2A servers; a bridge to any other agent protocol starts here.
 */
export async function driveTurn(
    app: MekikApp,
    connectionId: string,
    userId: string,
    conversationId: string | undefined,
    frame: Record<string, unknown>,
): Promise<{ conversationId: string; frames: OutgoingFrame[] }> {
    const conn = new CollectingConnection(connectionId);
    try {
        await app.connect(conn, { hello: { userId, ...(conversationId !== undefined ? { conversationId } : {}) } });
        const welcome = conn.frames.find((f) => f.type === "welcome") as WelcomeFrame | undefined;
        const convId = welcome?.data.conversationId ?? conversationId ?? "";
        conn.frames.length = 0; // the handshake and replay are not this turn's output
        await app.receive(conn, frame);
        return { conversationId: convId, frames: [...conn.frames] };
    } finally {
        app.disconnect(conn);
    }
}

/** A bad argument shape — the JSON-RPC layer answers `-32602`. */
export class McpArgumentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "McpArgumentError";
    }
}

class CollectingConnection implements Connection {
    readonly id: string;
    readonly frames: OutgoingFrame[] = [];
    constructor(id: string) {
        this.id = id;
    }
    send(frame: OutgoingFrame): void {
        this.frames.push(frame);
    }
    close(): void {}
}

function optionalString(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new McpArgumentError(`\`${field}\` must be a string`);
    return value;
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Reduce a turn's frames to the tool result. Pure — both languages pin it through the same cases. */
export function summarize(conversationId: string, frames: readonly OutgoingFrame[], resumeName: string, includeFrames: boolean): McpCallToolResult {
    let status: McpTurnResult["status"] | undefined;
    const replies: string[] = [];
    const streamed: string[] = [];
    const pending: McpPendingView[] = [];
    const tools = new Map<string, ToolCall>();
    const skills: string[] = [];
    let refused: string | undefined;

    // OutgoingFrame includes the open rich-message family (type: string), so the
    // discriminant does not narrow; each protocol-owned type is cast explicitly.
    for (const f of frames) {
        switch (f.type) {
            case "run": {
                const run = f as RunFrame;
                if (run.data.status !== "started") status = run.data.status;
                break;
            }
            case "text": {
                const text = f as TextOutFrame;
                if (text.from === "bot") replies.push(text.data.text);
                break;
            }
            case "genui": {
                const chunk = (f as GenUIFrame).chunk;
                if (chunk.type === "text") streamed.push(chunk.content);
                break;
            }
            case "interrupt":
                pending.push(pendingView(f as InterruptFrame));
                break;
            case "tool_call": {
                const call = (f as ToolCallFrame).data;
                tools.set(call.id, call);
                break;
            }
            case "skill": {
                const use = (f as SkillFrame).data;
                if (use.status === "loaded") skills.push(use.name);
                break;
            }
            case "error": {
                const err = (f as ErrorFrame).data;
                refused = `${err.code}: ${err.message}`;
                break;
            }
            default:
                break;
        }
    }

    const finalStatus: McpTurnResult["status"] = status ?? "refused";
    const reply = finalStatus === "refused" ? (refused ?? "the turn was refused") : replies.length > 0 ? replies.join("\n") : streamed.join("");
    const result: McpTurnResult = {
        conversationId,
        status: finalStatus,
        reply,
        pending,
        toolCalls: [...tools.values()].map((t) => ({ id: t.id, name: t.name, status: t.status })),
        skills,
    };
    if (includeFrames) result.frames = frames.filter((f) => "seq" in f);

    let text: string;
    let isError = false;
    switch (result.status) {
        case "finished":
            text = reply.length > 0 ? reply : "(no reply)";
            break;
        case "interrupted":
            text =
                "The agent paused and needs input before it can continue:\n" +
                pending.map((p) => `- interrupt ${JSON.stringify(p.id)}: ${describePending(p)}`).join("\n") +
                `\nCall ${resumeName} with conversationId ${JSON.stringify(conversationId)} and an answers object keyed by those ids.`;
            break;
        case "error":
            text = reply.length > 0 ? reply : "the run failed";
            isError = true;
            break;
        case "aborted":
            text = "The run was aborted; the conversation can be continued.";
            break;
        case "refused":
            text = reply;
            isError = true;
            break;
    }
    const out: McpCallToolResult = { content: [{ type: "text", text }], structuredContent: result };
    if (isError) out.isError = true;
    return out;
}

function pendingView(f: InterruptFrame): McpPendingView {
    const view: McpPendingView = { id: f.id, payload: f.data.payload };
    if (f.data.actions !== undefined) view.actions = f.data.actions;
    if (f.data.tool !== undefined) view.tool = f.data.tool.name;
    return view;
}

function describePending(p: McpPendingView): string {
    if (p.tool !== undefined) return `a client tool call (${p.tool}) that only the conversation's own UI can answer`;
    const payload = typeof p.payload === "object" && p.payload !== null ? JSON.stringify(p.payload) : String(p.payload);
    const actions = p.actions?.length ? ` — options: ${p.actions.map((a) => JSON.stringify(a.value === undefined ? a.label : a.value)).join(", ")}` : "";
    return `${payload}${actions}`;
}
