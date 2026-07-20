# @mekik/langchain

LangChain integration for [mekik](https://github.com/AimTune/mekik). Run a
LangChain agent inside an ilmek node and get, per tool:

- **Visibility** — the agent's tool calls surface in the UI as `tool_call` traces
- **Approval** — a tool can pause for a human before it runs
- **Exactly-once** — tools are journaled, so a pause/resume doesn't re-run them

```ts
import { withMekikTools } from "@mekik/langchain";

.node("agent", async (state, ctx) => {
    const tools = withMekikTools(ctx, [getOrder, refundPayment, internalLookup, charge], {
        get_order:       { show: true },                        // trace shown
        refund_payment:  { show: true, approve: true },          // ask the human first
        internal_lookup: { show: false },                        // runs, not shown
        charge:          { show: true, redact: ["cardNumber"] }, // shown, masked
    });

    // `createAgent` from `langchain` v1 — the prebuilt `createReactAgent` it
    // replaced still works, but it is the legacy entry point.
    const agent = createAgent({ model, tools });
    const out = await agent.invoke({ messages: [new HumanMessage(state.input)] });
    return { reply: lastText(out) };
})
```

The wrapped tools keep their name, description and schema, so the agent binds
them to the model exactly as before.

## Why wrapping, not just callbacks

A LangChain agent invokes its own tools. That leaves two gaps mekik normally
closes for you with `mekik.tool(...)`:

1. Nothing emits a `tool_call` frame, so the UI never learns a tool ran.
2. **When a node pauses for a human and the graph resumes, the node re-runs from
   the top — and the agent calls its tools again.** Only `ctx.step` makes an
   effect survive that replay.

`withMekikTools` closes both, because it owns the invocation. A callback handler
can only close the first.

## Policy

```ts
interface ToolPolicy {
    show?: boolean;                   // surface the trace (default true)
    approve?: boolean | ApproveSpec;  // pause for a human first (default false)
    redact?: readonly string[];       // mask these fields in the surfaced trace
}
```

`redact` masks only what is *surfaced* — the tool itself still receives the real
values. When the human declines an `approve` tool, it is never executed and the
agent gets a plain observation back (`denyMessage`, default
`"The user declined to run <tool>."`) so its loop can continue.

Approvals reach the client as ordinary mekik `interrupt` frames: chativa renders
Approve/Reject chips, or a form if you pass `ui`. Each tool gets its own stable
interrupt key, so several approvals in one node stay separately addressable.

## `mekikCallbacks` — the fallback

When you cannot wrap the tools (a prebuilt agent that owns them):

```ts
const out = await agent.invoke(input, { callbacks: [mekikCallbacks(ctx, policy)] });
```

**Visibility only.** It cannot journal the tool, so after a pause and resume the
agent will invoke its tools a second time. Prefer `withMekikTools`; keep the
tools behind this one side-effect free.

## Install

```bash
pnpm add @mekik/langchain @mekik/core
```

`@langchain/core` is a peer dependency — bring your own version.

MIT
