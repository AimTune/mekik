---
sidebar_position: 2
title: Generative UI
description: Stream interactive components inline with mekik.ui, mekik.text, and mekik.event — the AIChunk model, the streamId lifecycle, and the bidirectional genui_event path.
---

# Generative UI

Generative UI (GenUI) is how a mekik turn renders more than a text bubble: a node streams a sequence of typed **chunks** — prose deltas, component mounts, events — that the client assembles into one evolving message. The chunk shape is identical to chativa's `AIChunk`, so the widget renders it with no mekik-specific code.

## The three chunk helpers

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.text(ctx, "Analyzing… ");                            // a prose delta
mekik.ui(ctx, "weather-card", { city: "Ankara", c: 18 });  // mount/update a component
mekik.event(ctx, "highlight", { rowId: 3 });               // dispatch an event to a mounted component
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
Shuttle.Text(ctx, "Analyzing… ");                          // a prose delta
Shuttle.Ui(ctx, "weather-card", new Dictionary<string, object?> { ["city"] = "Ankara", ["c"] = 18 }); // mount/update
Shuttle.Event(ctx, "highlight", new Dictionary<string, object?> { ["rowId"] = 3 });                   // dispatch an event
```

</TabItem>
</Tabs>

Each emits one `genui` frame carrying an `AIChunk` — the same JSON shape on the wire in either language:

```ts
type AIChunk =
  | { type: "ui"; component: string; props?: Record<string, unknown>; id?: string | number }
  | { type: "text"; content: string; id?: string | number }
  | { type: "event"; name: string; payload?: unknown; id?: string | number };
```

- **`ui`** names a component from the client's registry and hands it `props`. Re-emitting the same component with new props updates it.
- **`text`** streams a prose fragment. The client concatenates fragments within a stream — this is how token-by-token model output renders.
- **`event`** fires a named signal at a mounted component (highlight a row, advance a step) without re-mounting it.

## The stream lifecycle

All chunks of one turn share a single `streamId`, minted by the mapper at the turn's first chunk. Chunk `id`s are how a client groups what it renders: **consecutive `text` deltas share one `id`**, so they concatenate into a single growing bubble instead of one bubble per token; a `ui` or `event` chunk takes its own `id` and closes the open text run, so the next `text` delta starts a fresh bubble. The frame carries `done:false` while the stream is open:

```jsonc
{ "type": "genui", "seq": 6, "streamId": "stream-1", "done": false,
  "chunk": { "type": "text", "content": "Analy", "id": 1 } }
{ "type": "genui", "seq": 7, "streamId": "stream-1", "done": false,
  "chunk": { "type": "text", "content": "zing… ", "id": 1 } }   // same id → appended to the same bubble
{ "type": "genui", "seq": 8, "streamId": "stream-1", "done": false,
  "chunk": { "type": "ui", "component": "weather-card", "props": { "city": "Ankara" }, "id": 2 } }
```

At `run_end{done}` the mapper **auto-closes** the stream with a terminal event chunk:

```jsonc
{ "type": "genui", "seq": 9, "streamId": "stream-1", "done": true,
  "chunk": { "type": "event", "name": "stream_done", "id": 3 } }
```

You never emit `stream_done` yourself — the mapper does it whenever a stream was opened during the run. (Fixture `tokens` pins this auto-close.)

## Streamed text is not the reply

A subtlety that trips people up:

> `mekik.text` chunks are **transient** generative UI. They are **not** the conversation's durable reply.

The durable reply is the single consolidated `bot` `text` frame the mapper emits at run end from your `MekikOptions.reply` selector. So a node that streams prose *and* returns a reply produces both — live `genui` text chunks during the run, one persistent `text` bubble at the end. On reconnect, only the bubble replays.

The pattern for streaming model output — `mekik.streamText` / `Shuttle.StreamText` drives the source through `text`/`Text` for you and returns the joined string to hand back as the reply:

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
.node("answer", async (state, ctx) => {
  const full = await mekik.streamText(ctx, model.stream(state.input)); // live, transient
  return { reply: full };                                             // durable — what replay shows
})
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
.Node("answer", async (State state, IContext ctx) =>
{
    var full = await Shuttle.StreamText(ctx, Model.StreamAsync(state.Get<string>("input")), ctx.CancellationToken);
    return Update.Of("reply", full);   // durable — what replay shows
})
```

</TabItem>
</Tabs>

When the source yields structured chunks rather than raw strings, pass a selector — `mekik.streamText(ctx, model.stream(input), (u) => u.text)` / `Shuttle.StreamText(ctx, chat.GetStreamingResponseAsync(…), u => u.Text)`. For full control you can still emit each delta yourself with `mekik.text` / `Shuttle.Text` and accumulate the reply by hand — `streamText` is just that loop.

If you *only* stream and never return a reply, the run has no persistent text — the genui chunks were the whole answer, and there's nothing for replay to show as a bubble. That's a valid choice for a purely visual turn (a card, a chart), less so for prose.

## A streaming reply, end to end

A complete server whose one node streams a model's answer token by token and then returns the consolidated reply. `model` is your own LLM client:

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
// server.ts
import { graph, channel, START, END } from "@ilmek/core";
import { mekik } from "@mekik/core";
import { serveWs } from "@mekik/ws";

const g = graph("assistant")
  .channel("input", channel.lastWrite<string>(""))
  .channel("reply", channel.lastWrite<string>(""))
  .node("answer", async (s, ctx) => {
    const full = await mekik.streamText(ctx, model.stream(s.input)); // one genui text chunk per delta — transient
    return { reply: full };                                         // the durable bubble replay shows
  })
  .edge(START, "answer").edge("answer", END)
  .compile();

const app = mekik({ graph: g, reply: (s) => s.reply as string });
serveWs(app, { port: 8800, path: "/ws" });
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
// Program.cs
using Ilmek.Core;
using Mekik.Core;
using Mekik.AspNetCore;

var g = Graph.Create("assistant")
    .Channel("input", Channels.LastWrite(""))
    .Channel("reply", Channels.LastWrite(""))
    .Node("answer", async (State state, IContext ctx) =>
    {
        // one genui text chunk per delta — transient; the return value is the durable reply.
        var full = await Shuttle.StreamText(ctx, Model.StreamAsync(state.Get<string>("input")), ctx.CancellationToken);
        return Update.Of("reply", full);
    })
    .Edge(Graph.Start, "answer")
    .Edge("answer", Graph.End)
    .Compile();

var web = WebApplication.CreateBuilder(args).Build();
web.UseWebSockets();
web.MapMekik("/ws", new MekikApp(new MekikOptions
{
    Graph = g,
    Reply = s => s.GetValueOrDefault("reply") as string,
}));
web.Run();
```

</TabItem>
</Tabs>

Streaming `"Hel"`, `"lo, "`, `"how can I help?"` puts this on the wire:

```jsonc
{ "type": "run",   "data": { "status": "started" } }
{ "type": "genui", "seq": 3, "streamId": "stream-1", "done": false, "chunk": { "type": "text", "content": "Hel", "id": 1 } }
{ "type": "genui", "seq": 4, "streamId": "stream-1", "done": false, "chunk": { "type": "text", "content": "lo, ", "id": 1 } }
{ "type": "genui", "seq": 5, "streamId": "stream-1", "done": false, "chunk": { "type": "text", "content": "how can I help?", "id": 1 } }
{ "type": "genui", "seq": 6, "streamId": "stream-1", "done": true,  "chunk": { "type": "event", "name": "stream_done", "id": 2 } }
{ "type": "text",  "seq": 7, "id": "msg-1", "from": "bot", "data": { "text": "Hello, how can I help?" }, "timestamp": 1750000000000 }
{ "type": "run",   "data": { "status": "finished" } }
```

Every text delta carries the **same** `id: 1`: the mapper keeps one open text run, so a client concatenates them into a single growing bubble instead of three. The `stream_done` event and the durable `text` reply each take their own id/frame. (Fixture [`tokens`](https://github.com/AimTune/mekik/blob/main/conformance/fixtures/tokens.json) pins exactly this.)

## The component contract

`mekik.ui(ctx, "weather-card", props)` names a component the **client** must have registered. mekik doesn't ship components — it streams instructions to render ones the client knows. In chativa, that's a GenUI component registered in `GenUIRegistry`; the sandbox already registers `order-card`, `approval-form`, `data-table`, and `weather-card`, which is why the repo's examples render end-to-end against it.

The division of labour:

| Side | Owns |
|---|---|
| **mekik (server)** | *when* to mount a component and *what* props it gets |
| **client (chativa)** | *how* the component looks and behaves |

An unknown component name is the client's call — chativa renders nothing for one unless a `debug` flag is set. Keep server and client registries in sync.

## Bidirectional events — `genui_event`

GenUI is two-way over the same socket. When a mounted component fires an interaction (a form submit, a card button), the client sends a `genui_event` frame back:

```jsonc
{ "type": "genui_event", "streamId": "stream-1", "eventType": "submit",
  "payload": { "email": "a@b.com" } }
```

Two things can happen with it:

1. **Ordinary component event** — routed to your `onCustom` hook or handled app-side. The base engine has no built-in reaction beyond the interrupt-coercion below.
2. **Interrupt answer** — if `eventType == "submit"` and `payload.id` names an open interrupt, the engine coerces it to a `resume{answers:{[id]: answer}}`. This lets a form mounted by an `interrupt` frame answer the pause by firing a submit event, without any server-side stream↔interrupt binding. See [Human-in-the-loop](./human-in-the-loop.md#answering).

## Where to go next

- [**Human-in-the-loop**](./human-in-the-loop.md) — mounting a form as an interrupt's `ui` and answering it.
- [**Protocol → Frames**](../protocol/frames.md#persistent-frames) — the `genui` frame shape.
- [**Protocol → Event mapping**](../protocol/event-mapping.md) — how token and `$mekik:"genui"` customs become `genui` frames.
