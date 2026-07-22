---
sidebar_position: 3
title: Tools
description: mekik.tool — surface a side effect as a tool_call trace and run it exactly once across an interrupt/resume, plus the trace lifecycle and the low-level primitives.
---

# Tools

`mekik.tool` does two things at once: it surfaces a side effect to the client as a `tool_call` trace, and it runs that side effect **exactly once** across an interrupt/resume cycle. The second is the one that matters — it's the difference between a refund that charges once and one that charges twice.

```ts
const order = await mekik.tool(ctx, "get_order", { id }, () => Orders.get(id));
```

Signature:

```ts
function tool<T>(
  ctx: Context<any>,
  name: string,
  params: Record<string, unknown>,
  fn: () => T | Promise<T>,
): Promise<T>;
```

## The trace lifecycle

`mekik.tool` emits a `tool_call` frame at each stage, all sharing one `id` so the client **upserts** — updates the existing entry rather than adding a new one:

```jsonc
{ "type": "tool_call", "seq": 6, "data": {
    "id": "task:tool:0", "name": "get_order", "status": "running", "params": { "id": "ORD-42" } } }
{ "type": "tool_call", "seq": 7, "data": {
    "id": "task:tool:0", "name": "get_order", "status": "completed", "result": { "total": 249.9 } } }
```

If `fn` throws, the final frame is `status:"error"` carrying the message instead of a result. The client sees a spinner turn into a result (or an error) in place — no duplicate rows.

## Exactly-once — the whole point

A paused node **re-runs from the top** on resume. So this node, without journaling, would look up the order twice:

```ts
// ❌ re-runs on resume — get_order fires again
.node("refund", async (s, ctx) => {
  const order = await Orders.get(s.input);          // runs on BOTH passes
  const ok = await ctx.interrupt({ title: "Refund?" });
  // …
})
```

`mekik.tool` fixes it by running `fn` inside ilmek's `ctx.step`, which journals the result:

```ts
// ✅ get_order runs once; the resume pass returns the journaled order
.node("refund", async (s, ctx) => {
  const order = await mekik.tool(ctx, "get_order", { id: s.input }, () => Orders.get(s.input));
  const ok = await mekik.approve(ctx, { title: "Refund?" });
  // …
})
```

On the first pass `fn` runs and its result is recorded. On the resume pass the node re-executes down to the same `ctx.step`, which returns the recorded value — `Orders.get` is never called again. The `tool_call` trace *does* re-emit on the resume pass, but because it's an upsert by `id`, the client just re-updates the existing entry. No second lookup, no duplicate spinner.

> **The rule of thumb:** anything before a pause re-runs (and must be journaled with `mekik.tool`); put a side effect that should happen *once, after the human agrees* on the far side of the `approve`.

The full authoring contract is in [Human-in-the-loop → exactly-once](./human-in-the-loop.md#the-exactly-once-rule-the-whole-point).

## Interrupts are not tool failures

If a tool's `fn` triggers a pause (say it calls `ctx.interrupt` internally), `mekik.tool` **rethrows** the interrupt untouched rather than reporting it as a `tool_call{error}`. A pause is a control-flow signal, not a failure. In .NET this is the load-bearing rethrow rule — an interrupt propagates as `InterruptSignalException`, and a blanket `catch (Exception)` in a tool wrapper would swallow the pause. `Shuttle.Tool` rethrows it; so does `mekik.tool` in TS (via `isInterrupt`). See [Parity](../parity/languages.md#the-four-deliberate-divergences).

## Journaled results must round-trip

Because the result is recorded and replayed from the journal, it must survive a serializer round-trip — the same constraint any ilmek `ctx.step` return value has. Return plain data (objects, arrays, primitives), not class instances with behaviour or non-serializable handles. If you need a live handle after the pause, re-derive it *after* the `approve`, not before.

## Low-level primitives

When an integration executes the tool itself — a LangChain or Semantic Kernel agent invoking its own functions — you can't wrap the call in `mekik.tool`. mekik exports the primitives behind it so the same trace is producible:

```ts
import { nextToolCallId, toolTrace } from "@mekik/core";

const id = nextToolCallId(ctx);                                    // replay-stable id
toolTrace(ctx, { id, name, status: "running", params });
try {
  const result = await ctx.step(name, () => runTool());           // journal it yourself
  toolTrace(ctx, { id, name, status: "completed", result });
} catch (err) {
  if (isInterrupt(err)) throw err;
  toolTrace(ctx, { id, name, status: "error", error: String(err) });
  throw err;
}
```

You rarely write this by hand — the [agent integrations](../integrations/overview.md) do it for you, wrapping each of an agent's tools so they emit traces, journal through `ctx.step`, and optionally pause for approval. Reach for the primitives only when wrapping a runner mekik doesn't already integrate.

## Redaction (via integrations)

`mekik.tool` itself surfaces `params` and `result` as-is. The agent integrations add a per-tool `redact` policy that masks named fields in the *surfaced* trace while the tool still receives the real values:

```ts
// @mekik/langchain
withMekikTools(ctx, [charge], { charge: { show: true, redact: ["cardNumber"] } });
```

Masking applies only to what's shown on the wire — the tool sees `cardNumber` intact. See [LangChain integration](../integrations/langchain.md) and [Microsoft.Extensions.AI](../integrations/dotnet-agents.md).

## Where to go next

- [**Human-in-the-loop**](./human-in-the-loop.md) — the pause that makes exactly-once matter.
- [**Agent integrations**](../integrations/overview.md) — tool tracing for LangChain / M.E.AI / Semantic Kernel agents.
- [**Protocol → Frames**](../protocol/frames.md#persistent-frames) — the `tool_call` frame and its upsert semantics.
