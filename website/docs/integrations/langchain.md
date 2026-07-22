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

## Where to go next

- [**Agent integrations → Overview**](./overview.md) — the shared policy shape and the three integrations.
- [**Tools**](../authoring/tools.md) — the `mekik.tool` mechanism these mirror.
- [**Examples**](../examples.md) — `sql-agent`, `weather-agent`, and `concierge` drive real LangChain-style agents through this.
