---
sidebar_position: 2
title: Generative UI
description: Stream interactive components inline with mekik.ui, mekik.text, and mekik.event — the AIChunk model, the streamId lifecycle, and the bidirectional genui_event path.
---

# Generative UI

Generative UI (GenUI) is how a mekik turn renders more than a text bubble: a node streams a sequence of typed **chunks** — prose deltas, component mounts, events — that the client assembles into one evolving message. The chunk shape is identical to chativa's `AIChunk`, so the widget renders it with no mekik-specific code.

## The three chunk helpers

```ts
mekik.text(ctx, "Analyzing… ");                       // a prose delta
mekik.ui(ctx, "weather-card", { city: "Ankara", c: 18 }); // mount/update a component
mekik.event(ctx, "highlight", { rowId: 3 });          // dispatch an event to a mounted component
```

Each emits one `genui` frame carrying an `AIChunk`:

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

All chunks of one turn share a single `streamId`, minted by the mapper at the turn's first chunk. Each chunk gets an incrementing `id` (0, 1, 2, …) so the client can order and de-duplicate them. The frame carries `done:false` while the stream is open:

```jsonc
{ "type": "genui", "seq": 6, "streamId": "stream-1", "done": false,
  "chunk": { "type": "text", "content": "Analyzing… ", "id": 0 } }
{ "type": "genui", "seq": 7, "streamId": "stream-1", "done": false,
  "chunk": { "type": "ui", "component": "weather-card", "props": { "city": "Ankara" }, "id": 1 } }
```

At `run_end{done}` the mapper **auto-closes** the stream with a terminal event chunk:

```jsonc
{ "type": "genui", "seq": 8, "streamId": "stream-1", "done": true,
  "chunk": { "type": "event", "name": "stream_done", "id": 2 } }
```

You never emit `stream_done` yourself — the mapper does it whenever a stream was opened during the run. (Fixture `tokens` pins this auto-close.)

## Streamed text is not the reply

A subtlety that trips people up:

> `mekik.text` chunks are **transient** generative UI. They are **not** the conversation's durable reply.

The durable reply is the single consolidated `bot` `text` frame the mapper emits at run end from your `MekikOptions.reply` selector. So a node that streams prose *and* returns a reply produces both — live `genui` text chunks during the run, one persistent `text` bubble at the end. On reconnect, only the bubble replays.

The pattern for streaming model output:

```ts
.node("answer", async (state, ctx) => {
  let full = "";
  for await (const delta of model.stream(state.input)) {
    mekik.text(ctx, delta);   // live, transient
    full += delta;
  }
  return { reply: full };     // durable — what replay shows
})
```

If you *only* stream and never return a reply, the run has no persistent text — the genui chunks were the whole answer, and there's nothing for replay to show as a bubble. That's a valid choice for a purely visual turn (a card, a chart), less so for prose.

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
