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

## Stream the answer, or return it — not both

Streamed `genui` **text** chunks are **persisted and replayed** like any other persistent frame (PROTOCOL.md §2): the streamed bubble is durable, not a throwaway preview. So a streamed answer *is* the turn's message — you do **not** also return it as a consolidated `text` reply. Doing both shows the answer **twice** (and both replay on reconnect).

Pick one shape per turn:

- **Stream it** — `mekik.streamText` / `Shuttle.StreamText` drive an async delta source through `text`/`Text`. The growing bubble is the durable message; return **no** separate reply. (The higher-level `runAgent` / `Agent.RunAsync` do exactly this — they stream and return an empty reply.)
- **Return it** — don't stream; return the full string and the mapper emits it as one `text` frame from your `reply` selector (see [the app's reply option](../getting-started.md)).

Streaming shape:

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
.node("answer", async (state, ctx) => {
  await mekik.streamText(ctx, model.stream(state.input)); // the stream IS the durable message
  return {};                                              // no separate reply → no duplicate
})
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
.Node("answer", async (State state, IContext ctx) =>
{
    await Shuttle.StreamText(ctx, Model.StreamAsync(state.Get<string>("input")), ctx.CancellationToken);
    return new Dictionary<string, object?>(); // no separate reply → no duplicate
})
```

</TabItem>
</Tabs>

When the source yields structured chunks rather than raw strings, pass a selector — `mekik.streamText(ctx, model.stream(input), (u) => u.text)` / `Shuttle.StreamText(ctx, chat.GetStreamingResponseAsync(…), u => u.Text)`. `streamText` also **returns** the joined string, so you can keep it for logging or state — just don't hand it back as the reply while streaming. For full manual control, emit each delta yourself with `mekik.text` / `Shuttle.Text`.

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
    await mekik.streamText(ctx, model.stream(s.input)); // the stream IS the durable message
    return {};                                          // no separate reply → no duplicate
  })
  .edge(START, "answer").edge("answer", END)
  .compile();

const app = mekik({ graph: g });
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
        // The stream IS the durable message — return no separate reply (no duplicate).
        await Shuttle.StreamText(ctx, Model.StreamAsync(state.Get<string>("input")), ctx.CancellationToken);
        return new Dictionary<string, object?>();
    })
    .Edge(Graph.Start, "answer")
    .Edge("answer", Graph.End)
    .Compile();

var web = WebApplication.CreateBuilder(args).Build();
web.UseWebSockets();
web.MapMekik("/ws", new MekikApp(new MekikOptions { Graph = g }));
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
{ "type": "run",   "data": { "status": "finished" } }
```

Every text delta carries the **same** `id: 1`: the mapper keeps one open text run, so a client concatenates them into a single growing bubble instead of three. That streamed bubble is the durable message (it replays on reconnect), so there is **no** separate consolidated `text` frame — returning one too would show the answer twice. The `stream_done` event closes the stream. (Fixture [`tokens`](https://github.com/AimTune/mekik/blob/main/conformance/fixtures/tokens.json) pins the id-sharing.)

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
{ "type": "genui_event", "streamId": "stream-1", "eventType": "rate_delivery",
  "scope": "component", "payload": { "stars": 5 } }
```

**The markup picks the addressee.** That is the whole routing model:

| markup | `scope` | who receives it |
| --- | --- | --- |
| `component-event="rate_delivery"` | `"component"` | the node parked on `onEvent` waiting for that name — nothing else |
| `mekik-event="track_order"` | `"graph"` | your `onGenUiEvent` handler, which may start a turn |
| `data-event="…"` | absent | tries the component route first, then the graph one (the original form, still supported) |

Ahead of both sits one special case: a `submit` whose `payload.id` names an open interrupt is coerced to a `resume{answers:{[id]: answer}}`, whatever the scope says. A payload id is a direct address. That is how a form mounted by an `interrupt` frame's `ui` answers its pause — see [Human-in-the-loop](./human-in-the-loop.md#answering).

**A frame that matches nothing is accepted and dropped** — no handler configured, or a `component-event` whose widget outlived the turn that mounted it. That is the right cost for a decorative button, and the first thing to check when a button appears dead.

### `component-event` — a node waiting on its own widget

`onEvent` is `approve` for widgets: the run parks, but a button on a component already on screen answers it instead of chips in the chat.

```ts
deliveryCard(ctx, props, { id: "card-1" });                 // mount it first
const rating = await mekik.onEvent<{ stars: number }>(ctx, "rate_delivery");
```

```csharp
Shuttle.Ui(ctx, "delivery-card", props, id: "card-1");
var rating = await Shuttle.OnEvent<IReadOnlyDictionary<string, object?>>(ctx, "rate_delivery");
```

It is an ordinary interrupt, so it inherits everything a pause already gives you: the run ends `interrupted`, the thread is checkpointed, the wait survives a disconnect or a restart, and `welcome.pending` re-announces it on reconnect. Its `interrupt` frame carries `data.event` — the name it is waiting for — so a client knows to wait for the widget rather than render default Approve/Cancel chips.

The pause the node holds *is* the binding, so nothing has to carry an interrupt id. The node re-runs from the top on resume, so journal your side effects and use literal chunk ids, exactly as around any other pause. While several pauses are open, ilmek requires them all answered at once — an interaction arriving then draws `error{incomplete_resume}`.

### `mekik-event` — a click the graph should answer

For the other case: a widget whose turn is long over, and a click that should start a new one.

```ts
mekik({
    graph,
    onGenUiEvent: (ev) =>
        ev.eventType === "track_order" ? { input: `track ${(ev.payload as { id: string }).id}` } : undefined,
});
```

```csharp
new MekikOptions
{
    Graph = graph,
    OnGenUiEvent = ev => ev switch
    {
        { EventType: "track_order", Payload: IReadOnlyDictionary<string, object?> p }
            when p.GetValueOrDefault("id") is string id =>
                new Dictionary<string, object?> { ["input"] = $"track {id}" },
        _ => null,
    },
};
```

The handler is `input` for components: a mapper, not a place to do work. Side effects belong in the node the turn reaches, where the journal makes them exactly-once. The turn it starts is an ordinary turn — one at a time (`error{busy}`), never over an open pause (`error{interrupted}`), and it writes no `text` frame on the user's behalf, because a click is not something they said.

The event carries `conversationId`, `userId`, `streamId`, `eventType`, the originating `component` when the client knows it, and the parsed `payload`.

## Where to go next

- [**Typed components**](./components.md) — bind a component name once so its props are compiler-checked, update an instance in place, and a worked example of all 13 components chativa registers out of the box.
- [**Rich messages**](./messages.md) — the other rendering path: standalone transcript entries (image, card, carousel, file…) rather than chunks of one evolving message.
- [**Human-in-the-loop**](./human-in-the-loop.md) — mounting a form as an interrupt's `ui` and answering it.
- [**Protocol → Frames**](../protocol/frames.md#persistent-frames) — the `genui` frame shape.
- [**Protocol → Event mapping**](../protocol/event-mapping.md) — how token and `$mekik:"genui"` customs become `genui` frames.
