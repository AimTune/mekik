---
sidebar_position: 1
title: Authoring helpers
description: The five node-authoring helpers — mekik.text, mekik.ui, mekik.event, mekik.tool, mekik.approve — that emit generative UI, tool traces, and human-in-the-loop pauses from inside an ilmek node.
---

# Authoring helpers

Inside an ilmek node you shape the conversation with five helpers. They're the entire authoring surface — everything a turn can produce on the wire comes from one of them. Each takes ilmek's `ctx` (no ambient storage; ilmek already threads `ctx` through every node) and emits a `custom` event the [mapper](../protocol/event-mapping.md) turns into a frame.

```ts
import { mekik } from "@mekik/core";

.node("desk", async (state, ctx) => {
  const order = await mekik.tool(ctx, "get_order", { id }, () => Orders.get(id));  // journaled tool
  mekik.text(ctx, "Looking that up…");                                            // streamed prose
  mekik.ui(ctx, "order-card", { id: order.id, total: order.total });              // mount a component
  const ok = await mekik.approve<{ approved: boolean }>(                          // pause for a human
    ctx, { title: `Refund ${order.total}?` },
    { ui: { component: "approval-form", props: { orderId: order.id } } },
  );
  return { reply: ok.approved ? "done" : "cancelled" };
})
```

## The one name, two ways

The single `mekik` export is both the **app factory** and the **helpers**:

```ts
mekik({ graph })       // app factory — called once, at the top level
mekik.ui(ctx, …)       // helper — called inside a node
```

They're the same object. `index.ts` folds the helper functions onto the callable factory, so both read naturally at their call sites. The helpers are also available as named imports (`import { ui, tool, approve } from "@mekik/core"`) for callers who prefer them.

In .NET the helpers live on a static `Shuttle` class — `Shuttle.Ui(ctx, …)`, `Shuttle.Tool(ctx, …)` — because a static class named `Mekik` would clash with the namespace. See [Parity](../parity/languages.md#the-four-deliberate-divergences).

## The five helpers

| Helper | Emits | Awaits? | Guide |
|---|---|---|---|
| `mekik.text(ctx, content)` | a `genui` **text** chunk (streaming prose) | no | [Generative UI](./generative-ui.md) |
| `mekik.ui(ctx, component, props?)` | a `genui` **ui** chunk (mount a component) | no | [Generative UI](./generative-ui.md) |
| `mekik.event(ctx, name, payload?)` | a `genui` **event** chunk | no | [Generative UI](./generative-ui.md) |
| `mekik.tool(ctx, name, params, fn)` | a `tool_call` trace **and** runs `fn` exactly once | **yes** — returns `fn`'s result | [Tools](./tools.md) |
| `mekik.approve(ctx, payload, opts?)` | an `interrupt` frame; the run pauses | **yes** — returns the human's answer | [Human-in-the-loop](./human-in-the-loop.md) |

The first three are fire-and-forget: they emit a chunk and return `void`. The last two are the interesting ones — they `await` because they wrap ilmek machinery (`ctx.step` for `tool`, `ctx.interrupt` for `approve`).

### `mekik.text` / `mekik.ui` / `mekik.event`

Stream a chunk of generative UI. `text` streams prose deltas; `ui` mounts or updates a registered component by name; `event` dispatches a named event to a mounted component:

```ts
mekik.text(ctx, "Analyzing your order… ");
mekik.ui(ctx, "data-table", { rows, columns });
mekik.event(ctx, "highlight", { rowId: 3 });
```

All three carry the same `AIChunk` shape chativa renders. Chunks under one turn share a `streamId`; the mapper assigns each an incrementing `id` and closes the stream at run end. Details and the component contract: [Generative UI](./generative-ui.md).

### `mekik.tool`

Run a side effect exactly once and surface it as a `tool_call` trace:

```ts
const order = await mekik.tool(ctx, "get_order", { id }, () => Orders.get(id));
```

It emits `tool_call{running}`, runs `fn` inside ilmek's `ctx.step` (which journals the result), then emits `tool_call{completed, result}` — or `tool_call{error}` if `fn` throws. The journaling is the point: on a resume pass the node re-runs, but `fn` returns its recorded value instead of executing again. This is what stops a refund from charging twice. Full story: [Tools](./tools.md).

### `mekik.approve`

Pause the run for a human and resume with their answer:

```ts
const ok = await mekik.approve<{ approved: boolean }>(
  ctx,
  { title: "Deploy to production?" },
  {
    ui: { component: "approval-form", props: { env: "prod" } }, // a rich form…
    actions: [                                                  // …or chip fallback
      { label: "Approve", value: { approved: true } },
      { label: "Cancel",  value: { approved: false } },
    ],
  },
);
```

The node **suspends** at that `await` on the first pass — it never returns. The engine emits an `interrupt` frame and ends the run `interrupted`. When the client answers, the graph re-runs the node from the top and the `await` returns the answer. The authoring contract for this — and why anything before the `await` must be journaled — is [Human-in-the-loop](./human-in-the-loop.md).

`ApproveOptions`:

```ts
interface ApproveOptions {
  ui?: UiRef;               // mount a form instead of relying on chips
  actions?: MessageAction[]; // chips; omit both ui and actions for default Approve/Cancel
  key?: string;             // journal key, when a node pauses more than once
}
```

## Low-level trace primitives

For integrations that execute tools themselves (a LangChain or Semantic Kernel agent calling its own functions), mekik exports the primitives behind `mekik.tool` so the same trace can be produced without re-deriving the reserved payload shape:

```ts
import { nextToolCallId, toolTrace } from "@mekik/core";

const id = nextToolCallId(ctx);
toolTrace(ctx, { id, name: "search", status: "running", params });
// … the integration runs the tool itself …
toolTrace(ctx, { id, name: "search", status: "completed", result });
```

`toolTrace` emits one `tool_call` frame (upsert by `id`); `nextToolCallId` mints a replay-stable id. You rarely call these directly — the [agent integrations](../integrations/overview.md) use them internally. Reach for them only when you're wrapping a tool runner mekik doesn't already have an integration for.

## Reading per-conversation context

Helpers *emit*; to *read* per-conversation data (a user id, a locale, auth claims), use ilmek's `ctx.meta`, which mekik populates:

```ts
.node("desk", async (state, ctx) => {
  const locale = (ctx.meta.mekik as { locale?: string })?.locale ?? "en";
  const claims = ctx.meta.auth; // verified auth claims, if an Authenticator ran
  // …
})
```

`ctx.meta.mekik` is your `MekikOptions.context(conv, turn)` output; `ctx.meta.client` is the allowlisted client meta; `ctx.meta.auth` is the auth verdict's claims. See [Concepts → Graph context](../concepts.md#7-graph-context-as-a-parameter).

## Where to go next

- [**Generative UI**](./generative-ui.md) — the chunk model and the component contract.
- [**Tools**](./tools.md) — exactly-once, redaction, and the trace lifecycle.
- [**Human-in-the-loop**](./human-in-the-loop.md) — the durable-pause authoring rules.
