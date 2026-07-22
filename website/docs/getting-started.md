---
sidebar_position: 2
title: Getting started
description: Install mekik, serve a compiled ilmek graph over WebSocket, connect a client, and add generative UI, tools, and a human-in-the-loop pause — in about 5 minutes.
---

# Getting started

This page takes you from an empty folder to a running mekik server that streams generative UI, runs a journaled tool, and pauses for a human — then connects a real client to it. If you read one page, read this one.

## Prerequisites

- **Node ≥ 22** (mekik is developed on Node 26 and uses the built-in TypeScript runner — no build step to run a `.ts` file). For .NET, see the [.NET section](#net-in-parallel).
- A compiled **ilmek** graph, or willingness to write a three-line one. If ilmek is new to you, its [MODEL.md](https://github.com/AimTune/ilmek) is the reference; mekik only needs a `compile()`d graph.

## Step 1 — Install

```bash
pnpm add @mekik/core @mekik/ws @ilmek/core
```

`@mekik/core` is the engine, mapper, helpers, stores, and auth port. `@mekik/ws` is the WebSocket transport. `@ilmek/core` is the graph runtime mekik serves — it's a peer you already depend on to author graphs.

## Step 2 — Serve a graph

The smallest useful server is a graph plus `serveWs`:

```ts
// server.ts
import { graph, channel, START, END } from "@ilmek/core";
import { mekik } from "@mekik/core";
import { serveWs } from "@mekik/ws";

const g = graph("echo")
  .channel("input", channel.lastWrite<string>(""))
  .channel("reply", channel.lastWrite<string>(""))
  .node("reply", (s) => ({ reply: `You said: ${s.input}` }))
  .edge(START, "reply").edge("reply", END)
  .compile();

const app = mekik({
  graph: g,
  reply: (s) => s.reply as string, // pick the run's reply text from final state
});

serveWs(app, { port: 8800, path: "/ws" });
console.log("mekik on ws://localhost:8800/ws");
```

```bash
node server.ts
```

`mekik({ graph })` builds a [`MekikApp`](./concepts.md#3-the-app--mekik-graph-) with in-memory defaults for everything (checkpointer, history, conversations). `serveWs` turns each socket into a connection the app drives. Omit `path` to accept the upgrade on **any** path — handy when a client points at `/chat` while you were thinking `/ws`.

### What a client sees

On connect, the server sends a `welcome` frame announcing the protocol and the minted identity. Each `text` frame the client sends starts one run:

```jsonc
// client → server
{ "type": "text", "data": { "text": "hello" } }

// server → client
{ "type": "run", "data": { "status": "started" } }
{ "type": "text", "id": "msg-1", "seq": 1, "from": "bot",
  "data": { "text": "You said: hello" }, "timestamp": 1750000000000 }
{ "type": "run", "data": { "status": "finished" } }
```

That's the whole loop. Everything below adds richer frames to it.

## Step 3 — Add generative UI, a tool, and a pause

The three authoring helpers are the reason to use mekik over a raw socket. Here's a node that uses all three:

```ts
import { mekik } from "@mekik/core";

// inside .node("refund", async (s, ctx) => { ... })
const order = await mekik.tool(ctx, "get_order", { id: s.input }, () =>
  Orders.get(s.input),                              // ← runs exactly once, journaled
);

mekik.ui(ctx, "order-card", { id: order.id, total: order.total }); // ← stream a component

const ok = await mekik.approve<{ approved: boolean }>(              // ← pause for a human
  ctx,
  { title: `Refund ${order.total}?` },
  { ui: { component: "approval-form", props: { orderId: order.id } } },
);

return { reply: ok.approved ? "Refunded." : "Cancelled." };
```

Each helper maps to a frame on the wire:

| Helper | Emits | Read more |
|---|---|---|
| `mekik.tool(ctx, name, params, fn)` | `tool_call` running → completed/error, and journals `fn` | [Tools](./authoring/tools.md) |
| `mekik.ui(ctx, component, props)` | a `genui` `ui` chunk | [Generative UI](./authoring/generative-ui.md) |
| `mekik.text(ctx, content)` | a `genui` `text` chunk (streaming prose) | [Generative UI](./authoring/generative-ui.md) |
| `mekik.approve(ctx, payload, opts)` | an `interrupt` frame; the run ends `interrupted` | [Human-in-the-loop](./authoring/human-in-the-loop.md) |

The **exactly-once** guarantee is the point of `mekik.tool`: because a paused node re-runs from the top on resume, anything before the pause happens twice — unless it's journaled. `mekik.tool` journals it through ilmek's `ctx.step`, so the resume pass returns the recorded value instead of charging the card again. See [Human-in-the-loop → exactly-once](./authoring/human-in-the-loop.md#the-exactly-once-rule-the-whole-point).

## Step 4 — Configure the app

`mekik(options)` takes a handful of options; all but `graph` have sensible defaults.

```ts
const app = mekik({
  graph: g,

  // Map an inbound text turn to the graph's input update. Default: { input: text }.
  input: (frame) => ({ input: frame.data.text }),

  // Pick the run's consolidated reply text from final channel state.
  reply: (state) => state.reply as string,

  // Per-turn server context, placed at ctx.meta.mekik for nodes to read.
  context: (conv, turn) => ({ userId: conv.userId, locale: "en" }),

  // A one-time bot message when a fresh conversation first connects.
  greeting: (conv) => "Hi! Send an order number to start a refund.",

  // Opt in to connect-time auth (see the Authentication guide).
  authenticator: undefined,
});
```

The full option list, with types, is in [Concepts → The app](./concepts.md#3-the-app--mekik-graph-). For durability, swap the in-memory checkpointer for a real one (see [Persistence](./persistence.md)) — an interrupt lives in the checkpoint, so an in-memory one loses parked pauses on restart.

## Step 5 — Connect a real client

The client end is chativa's [`@chativa/connector-mekik`](https://github.com/AimTune/chativa/blob/main/docs/connectors/mekik.md), which already speaks `mekik/1`:

```ts
import { MekikConnector } from "@chativa/connector-mekik";
import { ConnectorRegistry, chatStore } from "@chativa/core";

ConnectorRegistry.register(
  new MekikConnector({ url: "ws://localhost:8800/ws", resumeConversation: true }),
);
chatStore.getState().setConnector("mekik");
```

It renders `text` bubbles, mounts your GenUI components, shows `tool_call` traces, renders `interrupt` frames as approval chips (or a mounted form), and answers them with a `resume` — all with no per-app glue. See chativa's [MekikConnector docs](https://github.com/AimTune/chativa/blob/main/docs/connectors/mekik.md) for the client-side options.

Prefer to drive it from a script? Any WebSocket client works — the wire is plain JSON frames. See [Protocol → Frames](./protocol/frames.md) for the shapes.

## .NET in parallel

The .NET port is the same shape. Serve a graph from ASP.NET Core:

```csharp
using Mekik.Core;
using Mekik.AspNetCore;

var builder = WebApplication.CreateBuilder(args);
var web = builder.Build();

web.UseWebSockets();
web.MapMekik("/ws", new MekikApp(new MekikOptions { Graph = graph }));
web.Run();
```

The authoring helpers are `Shuttle.Ui`, `Shuttle.Tool`, `Shuttle.Approve` (the class is `Shuttle`, not `Mekik`, to avoid a namespace clash — see [Parity](./parity/languages.md)). The wire is byte-identical to TypeScript's.

## Try the examples

The repo ships runnable examples that each exercise the whole stack. The `refund` example is the canonical showcase — a tool trace, a GenUI card, a form approval, a resume, and the exactly-once assertion, in one graph:

```bash
node ts/examples/refund.ts            # in-memory self-test, asserts the exact wire trace
node ts/examples/refund.ts --serve    # a real ws://localhost:8800 server (any path)
```

The `--serve` mode renders end-to-end against chativa's sandbox, whose component registry already has the `order-card`, `approval-form`, `data-table`, and `weather-card` these examples emit. See [Examples](./examples.md) for the full tour, including the LLM-driven agents.

## Where to go next

- [**Concepts**](./concepts.md) — the app, engine, mapper, and ports, and how they compose.
- [**Protocol → Overview**](./protocol/overview.md) — the wire in one screen.
- [**Authoring → Helpers**](./authoring/helpers.md) — every helper, in depth.
- [**Human-in-the-loop**](./authoring/human-in-the-loop.md) — the durable-pause authoring contract.
