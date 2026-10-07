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

import {
    approve as mekikApprove,
    callClientTool,
    clientTools,
    loadSkill,
    nextToolCallId,
    skillResource,
    skillResourcesAvailable,
    skills,
    skillsPrompt,
    text as emitText,
    toolTrace,
} from "@mekik/core";
import type { ClientToolDefinition, ClientToolFilter, MessageAction, SkillFilter, ToolCall, UiRef } from "@mekik/core";
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

// ── client-declared tools (PROTOCOL.md §11) ───────────────────────────────────

/**
 * The **client's** declared tools as LangChain tools, so a model can call the
 * UI the same way it calls a server tool (PROTOCOL.md §11).
 *
 * @remarks
 * Reads `mekik.clientTools(ctx, filter)` — the tools the connected frontend
 * declared and the server accepted — and wraps each one in a
 * `DynamicStructuredTool` whose executor is `mekik.callClientTool`. A
 * `"call"`-mode tool parks the run until the client's handler answers (the
 * pause is durable, like any mekik interrupt); a `"notify"`-mode tool streams
 * the invocation and returns a delivery note the model can read. A handler
 * error comes back as an error observation (the agent loop stays alive), and
 * the `tool_call` running → completed/error trace is emitted for you.
 *
 * Use `filter.tags` to scope which of the client's tools this node exposes:
 *
 * ```ts
 * const tools = [
 *     ...withMekikTools(ctx, serverTools, policy),
 *     ...withClientTools(ctx, { tags: ["billing"] }),
 * ];
 * ```
 */
export function withClientTools(ctx: Context<any>, filter: ClientToolFilter = {}): StructuredToolInterface[] {
    return clientTools(ctx, filter).map((def) => wrapClientTool(ctx, def));
}

function wrapClientTool(ctx: Context<any>, def: ClientToolDefinition): StructuredToolInterface {
    const wrapped = new DynamicStructuredTool({
        name: def.name,
        description: def.description ?? `Invoke the client's "${def.name}" tool.`,
        // The declared JSON Schema is what the model sees. LangChain ≥0.3
        // accepts a JSON schema object here directly.
        schema: (def.parameters ?? { type: "object", properties: {} }) as never,
        func: async (input: unknown) => {
            try {
                const result = await callClientTool(ctx, def.name, asRecord(input));
                if (result === undefined) return `Delivered ${def.name} to the client.`;
                return typeof result === "string" ? result : JSON.stringify(result);
            } catch (err) {
                if (isInterruptLike(err)) throw err; // the pause IS the mechanism - never swallow it
                // A failed client handler is an observation, not a crash: the
                // model reads the error and can route around it.
                return `Error from client tool ${def.name}: ${err instanceof Error ? err.message : String(err)}`;
            }
        },
    });
    return wrapped as unknown as StructuredToolInterface;
}

// ── MCP servers as tools (PROTOCOL.md §13) ────────────────────────────────────

/**
 * What {@link withMcpTools} needs from a connected MCP server — the shape of
 * `@ilmek/mcp`'s `McpToolbox`, structurally, so that package is not a
 * dependency here: a name, the exposed tool list, and the raw (unjournaled)
 * invoke. Journaling, the `tool_call` trace and approval come from
 * {@link withMekikTools}.
 */
export interface McpToolboxLike {
    readonly name: string;
    tools(): ReadonlyArray<{ readonly name: string; readonly description?: string; readonly inputSchema: Record<string, unknown> }>;
    invoke(name: string, args: Record<string, unknown>): Promise<{ readonly text: string; readonly structured?: Record<string, unknown>; readonly isError: boolean }>;
}

/**
 * An MCP server's tools as LangChain tools, with the mekik treatment
 * (PROTOCOL.md §13): each call is a `tool_call` trace, runs exactly once across
 * an interrupt/resume, and may require human approval — the same {@link ToolPolicy}
 * map as server tools, keyed by the **exposed** tool name (`github__search`).
 *
 * @remarks
 * The observation the model reads is the result's `text`; when the server
 * returned only `structuredContent`, that is serialized instead. A result the
 * server flagged `isError` comes back as `Error from <tool>: …` — an
 * observation, not a crash. The toolbox's own `call` is not used because
 * {@link withMekikTools} already journals under `lc:<name>`; double-journaling
 * would only add entries.
 *
 * @example
 * ```ts
 * const github = await McpToolbox.connect(client, { name: "github" });   // @ilmek/mcp
 * const tools = [
 *     ...withMekikTools(ctx, serverTools, policy),
 *     ...withMcpTools(ctx, github, { github__create_issue: { approve: true } }),
 * ];
 * ```
 */
export function withMcpTools(
    ctx: Context<any>,
    toolbox: McpToolboxLike,
    policy: ToolPolicyMap = {},
    options: WithMekikToolsOptions = {},
): StructuredToolInterface[] {
    const raw = toolbox.tools().map(
        (t) =>
            new DynamicStructuredTool({
                name: t.name,
                description: t.description ?? `The ${t.name} tool of MCP server ${toolbox.name}.`,
                schema: t.inputSchema as never,
                func: async (input: unknown) => {
                    const result = await toolbox.invoke(t.name, asRecord(input));
                    const text = result.text.length > 0 ? result.text : result.structured !== undefined ? JSON.stringify(result.structured) : "";
                    if (result.isError) return `Error from ${t.name}: ${text.length > 0 ? text : "the tool reported an error"}`;
                    return text.length > 0 ? text : "(empty result)";
                },
            }) as unknown as StructuredToolInterface,
    );
    return withMekikTools(ctx, raw, policy, options);
}

// ── skills (PROTOCOL.md §12) ──────────────────────────────────────────────────

/** The tool name a model calls to read a skill's instructions (level 2). */
export const LOAD_SKILL_TOOL = "load_skill";
/** The tool name a model calls to read one of a skill's bundled files (level 3). */
export const READ_SKILL_RESOURCE_TOOL = "read_skill_resource";

/** Options for {@link withSkills}. */
export interface WithSkillsOptions {
    /**
     * Skill name → the names of the tools held under it ({@link RunAgentOptions.skillTools}).
     * Loading such a skill tells the model which tools it just unlocked.
     */
    toolNames?: Readonly<Record<string, readonly string[]>>;
}

/** The `load_skill` observation: the instructions, plus the tools the load unlocked. */
export function loadSkillObservation(name: string, instructions: string, tools?: readonly string[]): string {
    const body = instructions.length > 0 ? instructions : `(skill ${name} has no instructions)`;
    return tools && tools.length > 0 ? `${body}\n\nTools now available from skill ${name}: ${tools.join(", ")}.` : body;
}

/**
 * The turn's skills as LangChain tools — progressive disclosure, wired
 * (PROTOCOL.md §12). Pair it with `skillsPrompt(ctx, filter)` in the system
 * prompt: the prompt lists names and descriptions (level 1), and these tools
 * let the model pull one skill's instructions (`load_skill`) and, when the
 * server's catalog has files behind it, a bundled file
 * (`read_skill_resource`) — only what the task needs enters the context.
 *
 * @remarks
 * Each load surfaces as a `skill` frame, so the conversation shows which skill
 * the agent is following. An unknown name comes back as an error observation
 * (the loop stays alive) after the `status: "error"` trace. The `filter` scopes
 * which skills this node exposes, exactly like {@link withClientTools}; the
 * `load_skill` tool refuses a name the filter hides, so the prompt and the tool
 * agree on the toolbox. Returns `[]` when the turn has no skills, so it is safe
 * to spread unconditionally.
 *
 * @example
 * ```ts
 * const system = base + "\n\n" + skillsPrompt(ctx, { tags: ["docs"] });
 * const tools = [...withMekikTools(ctx, serverTools), ...withSkills(ctx, { tags: ["docs"] })];
 * ```
 */
export function withSkills(ctx: Context<any>, filter: SkillFilter = {}, options: WithSkillsOptions = {}): StructuredToolInterface[] {
    const visible = skills(ctx, filter);
    if (visible.length === 0) return [];
    const names = new Set(visible.map((s) => s.name));

    const load = new DynamicStructuredTool({
        name: LOAD_SKILL_TOOL,
        description:
            "Load the full instructions of one of the available skills by name. Call this before acting on a task that matches a skill's description.",
        schema: {
            type: "object",
            properties: { name: { type: "string", description: "The skill's name, exactly as listed in <available_skills>." } },
            required: ["name"],
        } as never,
        func: async (input: unknown) => {
            const name = String(asRecord(input).name ?? "");
            if (!names.has(name)) return `Unknown skill ${JSON.stringify(name)}. Available: ${[...names].join(", ")}.`;
            try {
                const skill = loadSkill(ctx, name);
                return loadSkillObservation(name, skill.instructions, options.toolNames?.[name]);
            } catch (err) {
                return `Error loading skill ${name}: ${err instanceof Error ? err.message : String(err)}`;
            }
        },
    });

    const tools: StructuredToolInterface[] = [load as unknown as StructuredToolInterface];

    if (skillResourcesAvailable(ctx)) {
        const read = new DynamicStructuredTool({
            name: READ_SKILL_RESOURCE_TOOL,
            description: "Read one file bundled with a loaded skill, by the path the skill's instructions give (relative to the skill).",
            schema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "The skill's name." },
                    path: { type: "string", description: "The bundled file's path, e.g. references/forms.md." },
                },
                required: ["name", "path"],
            } as never,
            func: async (input: unknown) => {
                const args = asRecord(input);
                const name = String(args.name ?? "");
                const path = String(args.path ?? "");
                if (!names.has(name)) return `Unknown skill ${JSON.stringify(name)}.`;
                try {
                    return await skillResource(ctx, name, path);
                } catch (err) {
                    return `Error reading ${path} from skill ${name}: ${err instanceof Error ? err.message : String(err)}`;
                }
            },
        });
        tools.push(read as unknown as StructuredToolInterface);
    }
    return tools;
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
    /**
     * Max model↔tool round-trips — how many times the model may run again after
     * calling tools. Default 25. Individual tool invocations do NOT consume turns:
     * a round that fires five tools still costs one turn. Cap raw tool usage with
     * {@link maxToolCalls} instead.
     */
    maxTurns?: number;
    /** Max total tool invocations across the run. Default 25. */
    maxToolCalls?: number;
    /** Per-tool policies (visibility, approval, redaction) forwarded to {@link withMekikTools}. */
    policy?: ToolPolicyMap;
    /** Default policy for tools with no entry in {@link policy}. */
    defaultPolicy?: ToolPolicy;
    /** Stream text deltas live (one growing bubble via `mekik.text`). Default true. */
    stream?: boolean;
    /** Reply when the model settles with neither text nor a tool call. */
    emptyReply?: string;
    /** Reply when `maxTurns` or `maxToolCalls` is exhausted without the model settling. */
    budgetReply?: string;
    /**
     * Give the model the turn's skills (PROTOCOL.md §12): `true` for all of them,
     * or a {@link SkillFilter} to scope by tag/origin. The `<available_skills>`
     * block is appended to `system` and the {@link withSkills} tools join
     * `tools`. Off by default — a node that never mentions skills is unchanged.
     */
    skills?: boolean | SkillFilter;
    /**
     * Tools held *under* a skill, keyed by skill name — progressive disclosure for the
     * toolbox, not only the instructions. A skill's tools are NOT offered to the model
     * until it calls `load_skill` for that skill; from the next model round on they join
     * `tools` for the rest of the run, and the `load_skill` observation names them.
     *
     * Needs {@link skills}; an entry whose skill is not visible to this node is ignored.
     * Tools are wrapped with {@link withMekikTools} like `tools` (same `policy`). The
     * active set is derived from the journaled calls, so a resume rebuilds the same
     * toolbox per round. A call to a tool whose skill is not loaded yet is answered with
     * an observation asking the model to load the skill first. Mirror of the .NET
     * `AgentRunOptions.SkillTools`.
     */
    skillTools?: Readonly<Record<string, readonly StructuredToolInterface[]>>;
}

/** The tools held under skills for one run: owners per tool, wrapped tools per skill. */
interface SkillToolbox {
    bySkill: Map<string, StructuredToolInterface[]>;
    skillsOf: Map<string, string[]>;
}

function buildSkillToolbox(
    ctx: Context<any>,
    options: RunAgentOptions,
    filter: SkillFilter,
    alwaysOn: readonly StructuredToolInterface[],
): SkillToolbox {
    const box: SkillToolbox = { bySkill: new Map(), skillsOf: new Map() };
    const held = options.skillTools;
    if (!held) return box;
    const visible = new Set(skills(ctx, filter).map((s) => s.name));
    const baseNames = new Set(alwaysOn.map((t) => t.name));
    const originals = new Map<string, StructuredToolInterface>();
    for (const [skill, list] of Object.entries(held)) {
        if (!visible.has(skill) || !list || list.length === 0) continue;
        for (const t of list) {
            if (baseNames.has(t.name)) throw new Error(`Tool "${t.name}" is both always-on and held under skill "${skill}".`);
            const seen = originals.get(t.name);
            if (seen && seen !== t) throw new Error(`Two different tools named "${t.name}" are held under skills.`);
            originals.set(t.name, t);
            const owners = box.skillsOf.get(t.name) ?? [];
            if (!owners.includes(skill)) owners.push(skill);
            box.skillsOf.set(t.name, owners);
        }
        box.bySkill.set(
            skill,
            withMekikTools(ctx, list, options.policy ?? {}, options.defaultPolicy ? { defaultPolicy: options.defaultPolicy } : {}),
        );
    }
    return box;
}

/** The tools of the given skills, deduplicated by name. */
function toolsOf(box: SkillToolbox, active: ReadonlySet<string>): StructuredToolInterface[] {
    const out = new Map<string, StructuredToolInterface>();
    for (const skill of active) for (const t of box.bySkill.get(skill) ?? []) if (!out.has(t.name)) out.set(t.name, t);
    return [...out.values()];
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
        maxTurns = 25,
        maxToolCalls = 25,
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

    // Skills (§12): level 1 goes in the prompt, levels 2–3 become tools. The skill
    // tools are not wrapped with withMekikTools — a load is a catalog read that
    // emits its own `skill` trace, not a side effect to journal.
    let systemText = system;
    let box: SkillToolbox = { bySkill: new Map(), skillsOf: new Map() };
    if (options.skills) {
        const filter: SkillFilter = options.skills === true ? {} : options.skills;
        const block = skillsPrompt(ctx, filter);
        if (block) systemText = systemText ? `${systemText}\n\n${block}` : block;
        box = buildSkillToolbox(ctx, options, filter, wrapped);
        const toolNames = Object.fromEntries([...box.bySkill].map(([k, v]) => [k, v.map((t) => t.name)]));
        wrapped.push(...withSkills(ctx, filter, { toolNames }));
    }

    // Every tool — the always-on ones and every skill's — is dispatchable from the start;
    // only what the model is OFFERED changes as skills load.
    const byName = new Map(wrapped.map((t) => [t.name, t]));
    for (const list of box.bySkill.values()) for (const t of list) if (!byName.has(t.name)) byName.set(t.name, t);

    const activeSkills = new Set<string>();
    let bound = model.bindTools(wrapped);

    const messages: BaseMessage[] = [new SystemMessage(systemText), new HumanMessage(input)];

    // `turn` counts model rounds, not tool invocations — a round that fires
    // several tools still costs one turn. `toolCallsUsed` tracks the raw tool
    // budget separately for callers that set maxToolCalls.
    let toolCallsUsed = 0;

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

        toolCallsUsed += decision.toolCalls.length;
        if (toolCallsUsed > maxToolCalls) return budgetReply;

        let activated = false;
        for (const call of decision.toolCalls) {
            const owners = box.skillsOf.get(call.name);
            const locked = owners && !owners.some((s) => activeSkills.has(s)) ? owners[0] : undefined;
            let result: unknown;
            if (locked !== undefined) {
                // Offered only once its skill is loaded — never run it before, or the model
                // would act without the skill's instructions.
                result = `Tool ${call.name} belongs to skill "${locked}". Call ${LOAD_SKILL_TOOL} with name "${locked}" first.`;
            } else {
                const t = byName.get(call.name);
                // A wrapped tool may throw the interrupt that parks the graph; letting it
                // propagate is how the pause reaches the client.
                result = t ? await t.invoke(call.args as never) : `Unknown tool ${call.name}.`;
            }

            // Derived from the journaled call (not live state), so a resume pass rebuilds
            // exactly the toolbox each round had the first time.
            const skill = call.args.name;
            if (call.name === LOAD_SKILL_TOOL && typeof skill === "string" && box.bySkill.has(skill) && !activeSkills.has(skill)) {
                activeSkills.add(skill);
                activated = true;
            }

            messages.push(
                new ToolMessage({
                    tool_call_id: call.id,
                    content: typeof result === "string" ? result : JSON.stringify(result),
                }),
            );
        }

        if (activated) bound = model.bindTools([...wrapped, ...toolsOf(box, activeSkills)]);
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
    // An exact answer (ignoring case and surrounding punctuation) wins outright.
    const bare = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    const exact = routes.find((r) => r.name.toLowerCase() === bare);
    if (exact) return exact.name;
    // Otherwise the longest route name the answer mentions — so "reporting" is
    // not captured by a route named "report" just because it was declared first.
    let best: RouteChoice | undefined;
    for (const r of routes) {
        if (text.includes(r.name.toLowerCase()) && (!best || r.name.length > best.name.length)) best = r;
    }
    return best?.name ?? fallback ?? routes.at(-1)!.name;
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
