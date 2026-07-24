/**
 * LangChain integration for mekik.
 *
 * A LangChain agent invokes its own tools, which leaves two gaps mekik normally
 * closes for you with `mekik.tool(...)`:
 *
 * 1. **Visibility** — the UI never learns a tool ran, because nothing emitted a
 *    `tool_call` frame.
 * 2. **Exactly-once** — when a node pauses for a human and the graph resumes,
 *    the node re-runs from the top and the agent calls its tools *again*. Only
 *    `ctx.step` makes an effect survive that replay.
 *
 * `withMekikTools` closes both by wrapping each tool before you hand it to the
 * agent, and adds a per-tool policy so a tool can additionally require human
 * approval before it runs:
 *
 * ```ts
 * .node("agent", async (state, ctx) => {
 *     const tools = withMekikTools(ctx, [getOrder, refundPayment, internalLookup], {
 *         get_order:       { show: true },
 *         refund_payment:  { show: true, approve: true },          // ask first
 *         internal_lookup: { show: false },                        // runs, unseen
 *         create_order:    { show: true, redact: ["cardNumber"] }, // shown, masked
 *     });
 *     const agent = createAgent({ model, tools }); // langchain v1's entry point
 *     const out = await agent.invoke({ messages: [new HumanMessage(state.input)] });
 *     return { reply: lastText(out) };
 * })
 * ```
 *
 * Use `mekikCallbacks` instead only when you cannot wrap the tools (a prebuilt
 * agent that owns them). It gives visibility but NOT exactly-once — see its doc.
 */

import { DynamicStructuredTool, type StructuredToolInterface } from "@langchain/core/tools";
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { approve as mekikApprove, nextToolCallId, text as emitText, toolTrace } from "@mekik/core";
import type { MessageAction, ToolCall, UiRef } from "@mekik/core";
import type { Context } from "@ilmek/core";

/** What a redacted field is replaced with in a surfaced trace. */
export const REDACTED = "«redacted»";

export interface ApproveSpec {
    /** Question shown to the human. Defaults to `Run <tool>?`. */
    title?: string;
    /** Chips. Defaults to Approve/Reject carrying `{approved: true|false}`. */
    actions?: MessageAction[];
    /** Mount a form instead of relying on chips. */
    ui?: UiRef;
    /** What the tool returns to the agent when the human declines. */
    denyMessage?: string;
}

export interface ToolPolicy {
    /** Surface this tool's `tool_call` trace to the client. Default true. */
    show?: boolean;
    /** Require human approval before the tool runs. Default false. */
    approve?: boolean | ApproveSpec;
    /** Field names to mask in the surfaced params/result. The tool still sees the real values. */
    redact?: readonly string[];
}

export type ToolPolicyMap = Readonly<Record<string, ToolPolicy>>;

export interface WithMekikToolsOptions {
    /** Applied to any tool with no entry in the policy map. Default `{ show: true }`. */
    defaultPolicy?: ToolPolicy;
}

const DEFAULT_POLICY: ToolPolicy = { show: true };

/**
 * Wrap LangChain tools so each one, when the agent calls it:
 * emits a `tool_call` trace (unless `show: false`), optionally pauses for human
 * approval, and executes inside `ctx.step` so it runs exactly once across an
 * interrupt/resume cycle.
 *
 * The returned tools keep their name, description and schema, so an agent binds
 * them to the model exactly as before.
 */
export function withMekikTools<T extends StructuredToolInterface>(
    ctx: Context<any>,
    tools: readonly T[],
    policy: ToolPolicyMap = {},
    options: WithMekikToolsOptions = {},
): StructuredToolInterface[] {
    const fallback = options.defaultPolicy ?? DEFAULT_POLICY;
    return tools.map((t) => wrapOne(ctx, t, policy[t.name] ?? fallback));
}

function wrapOne(
    ctx: Context<any>,
    original: StructuredToolInterface,
    policy: ToolPolicy,
): StructuredToolInterface {
    const show = policy.show ?? true;
    const redact = policy.redact ?? [];

    const wrapped = new DynamicStructuredTool({
        name: original.name,
        description: original.description,
        // The schema is what the model sees; keep it identical or the tool call
        // the LLM produces will not match.
        schema: original.schema as never,
        func: async (input: unknown) => {
            const params = asRecord(input);

            if (policy.approve) {
                const spec: ApproveSpec = policy.approve === true ? {} : policy.approve;
                const answer = await askApproval(ctx, original.name, params, spec, redact);
                if (!answer) {
                    // Returning (not throwing) keeps the agent loop alive: the
                    // model sees a refusal it can respond to, which is what a
                    // LangChain tool observation is for.
                    return spec.denyMessage ?? `The user declined to run ${original.name}.`;
                }
            }

            const id = nextToolCallId(ctx);
            if (show) toolTrace(ctx, { id, name: original.name, status: "running", params: mask(params, redact) });

            try {
                // Journaled: on the replay pass after an interrupt this returns
                // the recorded value instead of invoking the tool again.
                const result = await ctx.step(`lc:${original.name}`, () => original.invoke(input as never));
                if (show) toolTrace(ctx, { id, name: original.name, status: "completed", result: maskValue(result, redact) });
                return result as never;
            } catch (err) {
                if (isInterruptLike(err)) throw err; // a pause is not a failure
                if (show) {
                    toolTrace(ctx, {
                        id,
                        name: original.name,
                        status: "error",
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
                throw err;
            }
        },
    });

    return wrapped as unknown as StructuredToolInterface;
}

// ── the agent loop ────────────────────────────────────────────────────────────

/** Options for one {@link runAgent} model↔tool loop. */
export interface RunAgentOptions {
    /** The system prompt that frames the node's role. */
    system: string;
    /** The user's message for this turn (usually `state.input`). */
    input: string;
    /** Tools the model may call. Wrapped with {@link withMekikTools} automatically. */
    tools?: readonly StructuredToolInterface[];
    /** Max model↔tool round-trips before the loop gives up. Default 6. */
    maxTurns?: number;
    /** Per-tool policies (visibility, approval, redaction) forwarded to {@link withMekikTools}. */
    policy?: ToolPolicyMap;
    /** Default policy for tools with no entry in {@link policy}. */
    defaultPolicy?: ToolPolicy;
    /** Stream text deltas live (one growing bubble via `mekik.text`). Default true. */
    stream?: boolean;
    /** Reply when the model settles with neither text nor a tool call. */
    emptyReply?: string;
    /** Reply when `maxTurns` is exhausted without the model settling. */
    budgetReply?: string;
}

interface AgentToolCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
}

/**
 * The agentic model↔tool loop, packaged. A node hands its prompt, the user input
 * and a tool set to `runAgent`; the model drives — calling tools until it answers —
 * and the reply comes back as a string to return as the node's `reply`. Mirror of
 * the .NET `Mekik.Agents.Agent.RunAsync`.
 *
 * What the loop owns, so callers don't re-derive it every node:
 * - tools are wrapped with {@link withMekikTools} — each call is a visible `tool_call`
 *   trace, gated by any approval policy, and journaled exactly-once across a resume;
 * - each model call runs inside `ctx.step`, so a resume replays the recorded decision
 *   instead of paying for (and possibly changing) it, and text is not re-streamed;
 * - with `stream` (default), text deltas stream live through `mekik.text` — one growing
 *   bubble — while the consolidated answer is the returned string.
 *
 * @example
 * ```ts
 * .node("answer", async (state, ctx) =>
 *   ({ reply: await runAgent(ctx, model, { system, input: state.input, tools }) }))
 * ```
 */
export async function runAgent(
    ctx: Context<any>,
    model: BaseChatModel,
    options: RunAgentOptions,
): Promise<string> {
    const {
        system,
        input,
        tools = [],
        maxTurns = 6,
        policy = {},
        stream = true,
        emptyReply = "(no reply)",
        budgetReply = "I could not finish that within my step budget — please try again.",
    } = options;

    if (typeof model.bindTools !== "function") {
        throw new TypeError("runAgent needs a tool-calling chat model (one with bindTools).");
    }

    // Wrap per run: each wrapper closes over *this* run's ctx, which is what lets a
    // tool emit its trace frame and journal itself.
    const wrapped = withMekikTools(ctx, tools, policy, options.defaultPolicy ? { defaultPolicy: options.defaultPolicy } : {});
    const byName = new Map(wrapped.map((t) => [t.name, t]));
    const bound = model.bindTools(wrapped);

    const messages: BaseMessage[] = [new SystemMessage(system), new HumanMessage(input)];

    for (let turn = 0; turn < maxTurns; turn++) {
        // Journaled: a resume replays this decision instead of re-calling the model,
        // so the replayed tool keys line up and text is not re-streamed.
        const decision = await ctx.step(`agent:llm:${turn}`, async (): Promise<{ text: string; toolCalls: AgentToolCall[] }> => {
            if (stream) {
                let acc: AIMessageChunk | undefined;
                for await (const chunk of await bound.stream(messages)) {
                    const delta = messageText(chunk);
                    if (delta) emitText(ctx, delta);
                    acc = acc === undefined ? chunk : acc.concat(chunk);
                }
                const ai = acc ?? new AIMessageChunk({ content: "" });
                return { text: messageText(ai), toolCalls: toolCallsOf(ai) };
            }
            const ai = await bound.invoke(messages);
            return { text: messageText(ai), toolCalls: toolCallsOf(ai) };
        });

        // Rebuild the assistant turn from the journal so the replay pass presents the
        // model with exactly the history the first pass did.
        messages.push(
            new AIMessage({
                content: decision.text,
                tool_calls: decision.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
            }),
        );

        if (decision.toolCalls.length === 0) {
            if (!decision.text) return emptyReply;
            // When streaming, the answer was already delivered live as the durable message
            // (streamed chunks are persisted and replayed). Returning it again would emit a
            // second, consolidated `text` frame — the client would show it twice. So the
            // stream IS the reply: return nothing.
            return stream ? "" : decision.text;
        }

        for (const call of decision.toolCalls) {
            const t = byName.get(call.name);
            // A wrapped tool may throw the interrupt that parks the graph; letting it
            // propagate is how the pause reaches the client.
            const result = t ? await t.invoke(call.args as never) : `Unknown tool ${call.name}.`;
            messages.push(
                new ToolMessage({
                    tool_call_id: call.id,
                    content: typeof result === "string" ? result : JSON.stringify(result),
                }),
            );
        }
    }

    return budgetReply;
}

/** One classification target for {@link route}: a node name and what it handles. */
export interface RouteChoice {
    name: string;
    description: string;
}

/**
 * Classify `input` into exactly one of `routes` and return the chosen route name — the
 * router-node pattern (classify → goto expert node) in one call. The classification is
 * journaled (a resume replays the same route) and normalized to a valid route name, falling
 * back to `options.fallback` (or the last route) when the model answers off-list.
 *
 * @example
 * ```ts
 * const r = await route(ctx, model, routes, state.input);
 * return command(update({ route: r }), r); // ilmek: set channel + goto node r
 * ```
 */
export async function route(
    ctx: Context<any>,
    model: BaseChatModel,
    routes: readonly RouteChoice[],
    input: string,
    options: { fallback?: string; stepKey?: string } = {},
): Promise<string> {
    if (routes.length === 0) throw new Error("route needs at least one route.");
    const choice = await ctx.step(options.stepKey ?? "route", async () => {
        const ai = await model.invoke([new SystemMessage(routePrompt(routes)), new HumanMessage(input)]);
        return messageText(ai);
    });
    return normalizeRoute(choice, routes, options.fallback);
}

function routePrompt(routes: readonly RouteChoice[]): string {
    return (
        "Assign the user's message to EXACTLY ONE category and reply with only the category name (one word):\n" +
        routes.map((r) => `- ${r.name}: ${r.description}`).join("\n") +
        "\nReply with only the category name — no explanation or punctuation."
    );
}

function normalizeRoute(modelOutput: string, routes: readonly RouteChoice[], fallback?: string): string {
    const text = modelOutput.trim().toLowerCase();
    for (const r of routes) if (text.includes(r.name.toLowerCase())) return r.name;
    return fallback ?? routes.at(-1)!.name;
}

/** The text of a message or streamed chunk — string content, or the text parts of an array. */
function messageText(ai: { content: unknown }): string {
    const c = ai.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
        return c
            .filter((p): p is { type?: string; text?: string } => typeof p === "object" && p !== null)
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text as string)
            .join("");
    }
    return "";
}

function toolCallsOf(ai: { tool_calls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }> }): AgentToolCall[] {
    return (ai.tool_calls ?? []).map((c) => ({ id: c.id ?? "", name: c.name, args: c.args ?? {} }));
}

async function askApproval(
    ctx: Context<any>,
    name: string,
    params: Record<string, unknown>,
    spec: ApproveSpec,
    redact: readonly string[],
): Promise<boolean> {
    const payload: Record<string, unknown> = {
        title: spec.title ?? `Run ${name}?`,
        tool: name,
        params: mask(params, redact),
    };
    const opts: { ui?: UiRef; actions?: MessageAction[]; key: string } = {
        // A stable, per-call key so a node that approves several tools keeps its
        // pauses distinct and replay-addressable (ilmek MODEL.md §5.4).
        key: `approve:${name}`,
        actions: spec.actions ?? [
            { label: "Approve", value: { approved: true } },
            { label: "Reject", value: { approved: false } },
        ],
    };
    if (spec.ui) opts.ui = spec.ui;

    const answer = await mekikApprove<unknown>(ctx, payload, opts);
    return isApproved(answer);
}

/** Accepts `{approved:true}`, `true`, or a yes-ish string — clients vary. */
function isApproved(answer: unknown): boolean {
    if (answer === true) return true;
    if (typeof answer === "string") return /^(y|yes|ok|approve|approved|true|evet|onay)/i.test(answer.trim());
    if (typeof answer === "object" && answer !== null) {
        const v = (answer as { approved?: unknown }).approved;
        if (typeof v === "boolean") return v;
    }
    return false;
}

function asRecord(input: unknown): Record<string, unknown> {
    return typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : { input };
}

function mask(value: Record<string, unknown>, redact: readonly string[]): Record<string, unknown> {
    if (redact.length === 0) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact.includes(k) ? REDACTED : maskValue(v, redact);
    return out;
}

function maskValue(value: unknown, redact: readonly string[]): unknown {
    if (redact.length === 0) return value;
    if (Array.isArray(value)) return value.map((v) => maskValue(v, redact));
    if (typeof value === "object" && value !== null) return mask(value as Record<string, unknown>, redact);
    return value;
}

/**
 * ilmek signals a pause by throwing a non-`Error` value; never swallow it.
 * Checked structurally so this package does not depend on ilmek's internals.
 */
function isInterruptLike(err: unknown): boolean {
    return typeof err === "object" && err !== null && "key" in err && "payload" in err && !(err instanceof Error);
}

// ── observability-only fallback ───────────────────────────────────────────────

/**
 * A LangChain callback handler that emits `tool_call` traces for tools you
 * cannot wrap (a prebuilt agent that owns them).
 *
 * **This gives visibility only.** It cannot journal the tool, so after a pause
 * and resume the agent will invoke its tools a second time. Prefer
 * `withMekikTools`; reach for this when wrapping is impossible, and keep the
 * tools behind it side-effect free.
 */
export function mekikCallbacks(ctx: Context<any>, policy: ToolPolicyMap = {}, options: WithMekikToolsOptions = {}) {
    const fallback = options.defaultPolicy ?? DEFAULT_POLICY;
    const open = new Map<string, { id: string; name: string; redact: readonly string[] }>();

    return {
        handleToolStart(
            tool: { name?: string } | undefined,
            input: string,
            runId: string,
            _parentRunId?: string,
            _tags?: string[],
            _metadata?: Record<string, unknown>,
            runName?: string,
        ): void {
            const name = tool?.name ?? runName ?? "tool";
            const p = policy[name] ?? fallback;
            if (p.show === false) return;
            const redact = p.redact ?? [];
            const id = nextToolCallId(ctx);
            open.set(runId, { id, name, redact });
            toolTrace(ctx, { id, name, status: "running", params: mask(parseMaybeJson(input), redact) });
        },

        handleToolEnd(output: unknown, runId: string): void {
            const entry = open.get(runId);
            if (!entry) return;
            open.delete(runId);
            toolTrace(ctx, { id: entry.id, name: entry.name, status: "completed", result: maskValue(output, entry.redact) });
        },

        handleToolError(err: unknown, runId: string): void {
            const entry = open.get(runId);
            if (!entry) return;
            open.delete(runId);
            toolTrace(ctx, {
                id: entry.id,
                name: entry.name,
                status: "error",
                error: err instanceof Error ? err.message : String(err),
            });
        },
    };
}

function parseMaybeJson(input: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(input);
        return asRecord(parsed);
    } catch {
        return { input };
    }
}

export type { ToolCall };
