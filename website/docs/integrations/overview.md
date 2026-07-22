---
sidebar_position: 1
title: Agent integrations
description: Run a model-driven agent inside an ilmek node and get tool visibility, human approval, and exactly-once for free — LangChain, Microsoft.Extensions.AI, and Semantic Kernel.
---

# Agent integrations

When a node runs a **model-driven agent** — LangChain, Microsoft.Extensions.AI, Semantic Kernel — the agent invokes its *own* tools. That bypasses [`mekik.tool`](../authoring/tools.md), and with it the two things `mekik.tool` gives you for free. The integrations close that gap: wrap the agent's tools once and each one, when the agent calls it, gets the full mekik treatment.

## The gap they close

An agent calling its own tool leaves two holes:

1. **No visibility.** Nothing emits a `tool_call` frame, so the UI never learns a tool ran.
2. **No exactly-once.** When a node pauses for a human and the graph resumes, the node re-runs from the top — and the agent calls its tools *again*. Only `ctx.step` makes a tool survive that replay.

Each integration owns the tool's invocation, so it can close both — plus add a third capability: pausing for human approval before a sensitive tool runs.

| Capability | What it does |
|---|---|
| **Visibility** | the tool call surfaces as a `tool_call` running → completed/error trace |
| **Approval** | the tool can pause the graph for a human before it runs |
| **Exactly-once** | the tool executes inside `ctx.step`, so a pause/resume doesn't re-run it |
| **Redaction** | named fields are masked in the surfaced trace; the tool still gets real values |

## The one policy shape

All three integrations share the same per-tool policy, so you learn it once:

```ts
interface ToolPolicy {
  show?: boolean;                   // surface the trace (default true)
  approve?: boolean | ApproveSpec;  // pause for a human first (default false)
  redact?: readonly string[];       // mask these fields in the surfaced trace
}
```

```ts
{
  get_order:       { show: true },                        // trace shown
  refund_payment:  { show: true, approve: true },          // ask the human first
  internal_lookup: { show: false },                        // runs, not shown
  charge:          { show: true, redact: ["cardNumber"] }, // shown, masked
}
```

`redact` masks only what is *surfaced* — the tool itself always receives the real values. When a human declines an `approve` tool, it's never executed and the agent gets a plain refusal observation (`denyMessage`) so its loop can continue rather than crash.

## The three integrations

| Integration | Package | Wrap point | Guide |
|---|---|---|---|
| **LangChain** (TS) | `@mekik/langchain` | `withMekikTools(ctx, tools, policy)` | [LangChain](./langchain.md) |
| **Microsoft.Extensions.AI** (.NET) | `Mekik.Agents` | `MekikTools.Wrap(ctx, funcs, policy)` | [Microsoft.Extensions.AI](./dotnet-agents.md) |
| **Semantic Kernel** (.NET) | `Mekik.SemanticKernel` | `kernel.UseMekik(ctx, policy)` (a filter) | [Semantic Kernel](./semantic-kernel.md) |

The LangChain and Microsoft.Extensions.AI integrations **wrap** the tools (each becomes a new tool that owns its invocation). Semantic Kernel uses a **filter** — the seam every SK call funnels through — so one registration covers direct calls, auto function calling, `ChatCompletionAgent`, and planners without converting plugins.

## Wrapping vs. callbacks (the fallback)

There's a fallback for when you *cannot* wrap the tools (a prebuilt agent that owns them): a callback/observer that emits `tool_call` traces. But it's **visibility only** — it cannot journal the tool, so after a pause and resume the agent invokes its tools a second time. Prefer wrapping; reach for callbacks only when wrapping is impossible, and keep the tools behind it side-effect free. See [LangChain → `mekikCallbacks`](./langchain.md#mekikcallbacks--the-fallback).

## Approval renders as an ordinary interrupt

When a policy marks a tool `approve`, the pause is a normal mekik `interrupt` frame — chativa renders Approve/Reject chips (or a form if you pass `ui`), and the pause lives in ilmek's checkpoint, so it survives a restart like any other. Each tool gets its own stable interrupt key, so several approvals in one node stay separately addressable. See [Human-in-the-loop](../authoring/human-in-the-loop.md#approval-from-an-agents-tools).

## Where to go next

- [**LangChain**](./langchain.md) — `withMekikTools` and the callback fallback.
- [**Microsoft.Extensions.AI**](./dotnet-agents.md) — `MekikTools.Wrap` and the relationship to `ApprovalRequiredAIFunction`.
- [**Semantic Kernel**](./semantic-kernel.md) — the one filter that covers agents and planners.
