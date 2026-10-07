---
sidebar_position: 2
title: LangChain
description: "@mekik/langchain — wrap a LangChain agent's tools so each gets a tool_call trace, optional human approval, and exactly-once across an interrupt/resume."
---

# LangChain

:::note TypeScript integration
LangChain is a TypeScript library, so this page is TypeScript-only by nature. On **.NET**, the equivalents are [Microsoft.Extensions.AI](./dotnet-agents.md) and [Semantic Kernel](./semantic-kernel.md) — same policy shape, same three capabilities.
:::

`@mekik/langchain` runs a LangChain agent inside an ilmek node and gives each of its tools the mekik treatment: a `tool_call` trace, optional human approval, and exactly-once across a pause/resume. You wrap the tools once before handing them to the agent; the wrappers keep their name, description, and schema, so the model binds them exactly as before.

```bash
pnpm add @mekik/langchain @mekik/core
```

`@langchain/core` is a **peer dependency** — bring your own version.

## `runAgent` — the loop, packaged

Most nodes don't need to hand-roll the model↔tool loop. `runAgent` drives it: it wraps your tools with [`withMekikTools`](#withmekiktools), runs each model call inside `ctx.step` (a resume replays the decision instead of re-paying for it), streams text deltas live as one growing bubble, and returns the consolidated reply for you to hand back:

```ts
import { runAgent } from "@mekik/langchain";

.node("agent", async (state, ctx) => ({
  reply: await runAgent(ctx, model, {
    system: SYSTEM,
    input: state.input,
    tools: [getOrder, refundPayment, internalLookup],
    policy: {
      get_order:      { show: true },
      refund_payment: { show: true, approve: true }, // pauses the graph for a human
    },
  }),
}))
```

```ts
function runAgent(
  ctx: Context<any>,
  model: BaseChatModel,          // any tool-calling chat model (bindTools)
  options: {
    system: string;
    input: string;
    tools?: readonly StructuredToolInterface[];
    maxTurns?: number;           // model↔tool round-trips; default 25. Tool calls don't consume turns —
                                 // a round that fires five tools still costs one turn.
    maxToolCalls?: number;       // total tool invocations across the run; default 25
    policy?: Readonly<Record<string, ToolPolicy>>;
    defaultPolicy?: ToolPolicy;
    stream?: boolean;            // live text deltas; default true
    emptyReply?: string;
    budgetReply?: string;
    skills?: boolean | SkillFilter; // append <available_skills> to system + add the withSkills tools; default off
    skillTools?: Readonly<Record<string, readonly StructuredToolInterface[]>>; // extra tools held under a skill (per-request ones) — merged with SkillEntry.tools
  },
): Promise<string>;
```

The loop is budgeted twice. `maxTurns` counts **model rounds** — how many times the model may run again after calling tools, default 25. Individual tool invocations do **not** consume turns: a round that fires five tools still costs one turn. `maxToolCalls` (default 25) separately caps total tool invocations across the run; rather than cutting a batch off halfway, the loop settles with `budgetReply` before executing a batch that would overrun the cap. Node-level looping stays budgeted by ilmek's `recursionLimit`, which tool calls never consume.

**A failing tool call is an observation, not a crash.** A call to a tool the agent does not have reads `Unknown tool <name>.`; a call whose arguments fail the tool's schema, or a tool that throws, reads `Error from <tool>: <message>` — the tool does not run (or its error is caught), the call is traced `running → error`, and the model gets another round to react. Only an interrupt (an approval, a client tool call) leaves the loop, by parking the run.

You return the result as your node's reply (`{ reply }`). When **streaming** (the default), the answer is delivered live as the durable message (streamed chunks persist and replay), so `runAgent` returns an **empty string** — `{ reply: "" }` emits nothing extra, no duplicate. With `stream: false`, it returns the full text for the consolidated `text` reply. Reach for [`withMekikTools`](#withmekiktools) directly when you need to drive the loop yourself (a custom agent framework, a non-standard message shape).

## `withMekikTools`

```ts
import { withMekikTools } from "@mekik/langchain";

.node("agent", async (state, ctx) => {
  const tools = withMekikTools(ctx, [getOrder, refundPayment, internalLookup, charge], {
    get_order:       { show: true },                        // trace shown
    refund_payment:  { show: true, approve: true },          // ask the human first
    internal_lookup: { show: false },                        // runs, not shown
    charge:          { show: true, redact: ["cardNumber"] }, // shown, masked
  });

  // `createAgent` from langchain v1 — the prebuilt `createReactAgent` it
  // replaced still works, but it is the legacy entry point.
  const agent = createAgent({ model, tools });
  const out = await agent.invoke({ messages: [new HumanMessage(state.input)] });
  return { reply: lastText(out) };
})
```

Signature:

```ts
function withMekikTools<T extends StructuredToolInterface>(
  ctx: Context<any>,
  tools: readonly T[],
  policy?: Readonly<Record<string, ToolPolicy>>,
  options?: { defaultPolicy?: ToolPolicy }, // applied to tools with no entry; default { show: true }
): StructuredToolInterface[];
```

Each returned tool, when the agent calls it: emits a `tool_call` trace (unless `show:false`), optionally pauses for approval, then executes inside `ctx.step` so it runs exactly once across an interrupt/resume.

## `withClientTools` — the frontend's tools

The connected **client** can declare tools of its own — open its date picker, render one of its cards — via [client tools](../authoring/client-tools.md) (PROTOCOL.md §11). `withClientTools` turns the turn's accepted declarations into LangChain tools so the model calls the UI the same way it calls a server tool:

```ts
import { withMekikTools, withClientTools, runAgent } from "@mekik/langchain";

.node("agent", async (state, ctx) => {
  const tools = [
    ...withMekikTools(ctx, serverTools, policy),   // the server's own tools
    ...withClientTools(ctx, { tags: ["billing"] }), // the frontend's, scoped by tag
  ];
  return { reply: await runAgent(ctx, model(), { system: SYSTEM, input: state.input, tools }) };
})
```

Signature:

```ts
function withClientTools(
  ctx: Context<any>,
  filter?: { tags?: readonly string[]; mode?: "call" | "notify" },
): StructuredToolInterface[];
```

Each wrapper's executor is [`mekik.callClientTool`](../authoring/client-tools.md#calling): a `"call"`-mode tool **parks the loop durably** (the agent state is journaled, so the resume replays the model's decisions instead of re-paying for them), a `"notify"`-mode tool returns a delivery note the model can read, and a handler error comes back as an error *observation* — the loop stays alive and the model can route around it. The declared JSON Schema is handed to the model verbatim, so the tool call it produces binds to the client's handler unchanged.

`filter.tags` is the scoping lever: the frontend tags the tools it wants restricted to particular nodes, untagged tools are visible everywhere, and the server's `clientTools` policy has already allowlisted the whole set before this call ever sees it.

## `withSkills` — progressive disclosure

The app's [skills](../authoring/skills.md) (PROTOCOL.md §12) reach a model in three levels: the `<available_skills>` block in the system prompt lists names and descriptions, `load_skill` pulls one skill's instructions when a task matches, and `read_skill_resource` opens a bundled file when the instructions point at it. `withSkills` builds the tools; `skillsPrompt` (from `@mekik/core`) builds the block:

```ts
import { skillsPrompt } from "@mekik/core";
import { withMekikTools, withSkills, runAgent } from "@mekik/langchain";

.node("agent", async (state, ctx) => {
  const system = SYSTEM + "\n\n" + skillsPrompt(ctx, { tags: ["docs"] });
  const tools = [
    ...withMekikTools(ctx, serverTools, policy),
    ...withSkills(ctx, { tags: ["docs"] }),
  ];
  return { reply: await runAgent(ctx, model(), { system, input: state.input, tools }) };
})

// …or let runAgent do both with one option:
return { reply: await runAgent(ctx, model(), { system: SYSTEM, input: state.input, tools, skills: { tags: ["docs"] } }) };
```

Signature:

```ts
function withSkills(
  ctx: Context<any>,
  filter?: { tags?: readonly string[]; source?: "server" | "client" },
): StructuredToolInterface[];   // [] when the turn has no skills

const LOAD_SKILL_TOOL = "load_skill";                 // schema { name }
const READ_SKILL_RESOURCE_TOOL = "read_skill_resource"; // schema { name, path } — only when the catalog has files
```

`load_skill` returns the instructions as the observation and emits the persistent `skill` frame, so the conversation shows which skill the agent is following. An unknown name — or one the `filter` hides — comes back as an error observation listing what *is* available, so the loop stays alive and the prompt and the tool always agree. The skill tools are not wrapped with the tool policy: a load is a catalog read that emits its own trace, not a side effect to journal.

A skill **owns** its tools: declare the catalog as `SkillEntry<StructuredToolInterface>[]` and give an entry `tools`. With `skills` on, `runAgent` holds each visible entry's tools back — they are not offered to the model until it loads that skill successfully, then join `tools` for the rest of the run, and the `load_skill` observation names them. A premature call is refused with an observation; once unlocked, a call that fails reads `Error from <tool>: <message>` like any other (above); the tools themselves go through `withMekikTools` with the same `policy`, and a resume rebuilds each round's toolbox. The tools never reach the wire (catalog frame and hash are unchanged), and an entry holding something that is not a LangChain tool fails the run. `runAgent({ skillTools })` adds tools keyed by skill name for the ones that must be built per request; they merge with the entry's own. See [Skills → Tools under a skill](../authoring/skills.md#tools-under-a-skill). Wiring the loop yourself, `withSkills(ctx, filter, { toolNames, onLoaded })` names each entry's tools in the observation (plus any `toolNames`) and calls `onLoaded(name)` after each successful load; `mekik.skillTools(ctx, filter)` gives you the visible entries' tools. A tool built once (a catalog's) reads the calling run's `ctx` with `toolContext(config)` — `withMekikTools` passes it in the LangChain `config.configurable` on every call.

## Why wrapping, not just callbacks

A LangChain agent invokes its own tools. That leaves the two gaps [`mekik.tool`](../authoring/tools.md) normally closes:

1. Nothing emits a `tool_call` frame, so the UI never learns a tool ran.
2. When a node pauses for a human and the graph resumes, the node re-runs from the top — and the agent calls its tools **again**. Only `ctx.step` makes an effect survive that replay.

`withMekikTools` closes both because it owns the invocation. A callback handler can only close the first.

## Policy

```ts
interface ToolPolicy {
  show?: boolean;                   // surface the trace (default true)
  approve?: boolean | ApproveSpec;  // pause for a human first (default false)
  redact?: readonly string[];       // mask these fields in the surfaced trace
}
```

`redact` masks only what is *surfaced* — the tool itself receives the real values. When the human declines an `approve` tool, it's never executed and the agent gets a plain observation back (`denyMessage`, default `"The user declined to run <tool>."`) so its loop can continue.

### `ApproveSpec`

`approve: true` uses defaults; pass an `ApproveSpec` to customize:

```ts
interface ApproveSpec {
  title?: string;                // question shown to the human. Default: `Run <tool>?`
  actions?: MessageAction[];     // chips. Default: Approve/Reject carrying { approved: true|false }
  ui?: UiRef;                    // mount a form instead of chips
  denyMessage?: string;          // what the tool returns to the agent on decline
}
```

```ts
refund_payment: {
  approve: {
    title: "Approve this refund?",
    ui: { component: "approval-form", props: { kind: "refund" } },
    denyMessage: "Refund not approved by the operator.",
  },
},
```

Approvals reach the client as ordinary mekik `interrupt` frames — chativa renders chips, or a form if you pass `ui`. Each tool gets its own **stable interrupt key**, so several approvals in one node stay separately addressable across a resume.

## What the human sees

When an `approve` tool fires, the agent's own loop suspends inside the tool call while the graph pauses. The interrupt payload carries the tool name and its (redacted) params:

```jsonc
{ "type": "interrupt", "id": "…", "data": {
    "payload": { "title": "Run refund_payment?", "tool": "refund_payment",
                 "params": { "orderId": "ORD-42" } },
    "actions": [ { "label": "Approve", "value": { "approved": true } },
                 { "label": "Reject",  "value": { "approved": false } } ] } }
```

On `resume`, the node re-runs — but the tools that already completed are journaled, so only the approved tool proceeds to execute. The library accepts a range of answer shapes (`{approved:true}`, `true`, or a yes-ish string) since clients vary.

## `mekikCallbacks` — the fallback

When you cannot wrap the tools (a prebuilt agent that owns them), attach a callback handler instead:

```ts
import { mekikCallbacks } from "@mekik/langchain";

const out = await agent.invoke(input, { callbacks: [mekikCallbacks(ctx, policy)] });
```

**Visibility only.** It emits `tool_call` traces but cannot journal the tool, so after a pause and resume the agent will invoke its tools a second time. Prefer `withMekikTools`; keep the tools behind this one side-effect free.

| | `withMekikTools` | `mekikCallbacks` |
|---|---|---|
| tool_call traces | ✅ | ✅ |
| human approval | ✅ | ❌ |
| exactly-once across resume | ✅ | ❌ |
| requires wrapping the tools | yes | no |

## `route` — classify into one node

The router pattern (classify the turn, then `goto` a focused expert node) is one call. `route` builds a strict classification prompt from your route names + descriptions, journals the choice (a resume replays the same route), and normalizes the model's answer to a valid route — falling back when it answers off-list:

```ts
import { route } from "@mekik/langchain";

.node("router", async (state, ctx) => {
  const target = await route(ctx, model, [
    { name: "reporting", description: "sprint reports and metrics" },
    { name: "billing",   description: "invoices and charges" },
    { name: "general",   description: "everything else" },
  ], state.input, { fallback: "general" });
  return command(update({ route: target }), target); // set channel + goto node
})
```

Normalization is case- and punctuation-insensitive. An answer that *is* a route name wins outright; otherwise the **longest** route name the answer mentions wins, so with routes `report` and `reporting` an answer of `reporting` is never captured by `report`. An answer naming no route goes to `fallback`, or the last route.

## Where to go next

- [**Agent integrations → Overview**](./overview.md) — the shared policy shape and the three integrations.
- [**Tools**](../authoring/tools.md) — the `mekik.tool` mechanism these mirror.
- [**Examples**](../examples.md) — `sql-agent`, `weather-agent`, and `concierge` drive real LangChain-style agents through this.
