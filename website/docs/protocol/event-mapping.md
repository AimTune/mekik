---
sidebar_position: 4
title: Event mapping
description: The canonical IlmekEvent → mekik frame table that eventToFrames implements — the fixture-checked core of the protocol — plus interrupt payload wrapping, the reply frame, and resume routing.
---

# Event mapping

The server side of mekik reduces to one pure function: **`eventToFrames`** (the `TurnMapper`) consumes the `IlmekEvent` stream of a single run and produces mekik frames. This page is that contract. It is the closed, machine-checkable core — the [golden fixtures](../parity/conformance.md) pin it byte-for-byte across both languages, and where this prose and a fixture disagree, the fixture wins.

## What the mapper is

The `TurnMapper` is **turn-stateful** but **conversation-stateless**:

- It owns the current turn's GenUI `streamId` and the per-stream chunk counter.
- It is *handed* the conversation's persistent-`seq` allocator and a deterministic id minter.

That split is deliberate. Because the conversation state (seq, ids) is injected, the mapper is a pure function of `(events, seqAllocator, minter, clock)` — which is exactly what makes it reproducible across languages. Production passes a random minter and the wall clock; the fixtures pass a deterministic minter and a fixed clock. Only those injected pieces differ.

## The `IlmekEvent` variants

mekik consumes ilmek's typed event stream (`@ilmek/core` / `Ilmek.Core`). The variants:

```
run_start · step_start · node_start · custom{payload} · node_end{node,update} ·
node_error{node,error} · node_retry · state{channels} · checkpoint{id} ·
interrupt{pending: Pending[]} · run_end{status: done|interrupted|error|aborted, …}
```

Most of these produce **nothing** in v1. The mapper cares about four: `run_start`, `custom`, `interrupt`, and `run_end`. The rest (`node_*`, `step_start`, `state`, `checkpoint`) are reserved for a future `debug` stream mode.

## The mapping table

| `IlmekEvent` | condition | frame(s) emitted |
|---|---|---|
| `run_start` | — | `run{started}` |
| `custom` | `isToken(payload)` (ilmek `{type:"token",text,meta?}`) | a `genui` text chunk `{type:"text", content: payload.text, id: nextChunkId}`, `done:false` |
| `custom` | `payload.$mekik == "genui"` | a `genui` frame with `chunk = payload.chunk`; assign `chunk.id = nextChunkId` if absent; `done:false` |
| `custom` | `payload.$mekik == "tool"` | a `tool_call` frame `{data: payload.call}` (upsert by `call.id`) |
| `custom` | otherwise | nothing (reserved for the `onCustom` extension hook) |
| `node_*`, `step_start`, `state`, `checkpoint` | — | nothing in v1 |
| `interrupt` | for each `p` in `pending` | one `interrupt` frame `{id: p.id, data: unwrapInterrupt(p.payload)}` |
| `run_end` | `status == "interrupted"` | `run{interrupted}` |
| `run_end` | `status == "done"` | close the turn stream if open (`genui {done:true, chunk:{type:"event", name:"stream_done"}}`); then, if the run produced a reply, a `bot` `text` frame; then `run{finished}` |
| `run_end` | `status == "error"` | a `bot` `text` `{text:"⚠️ " + message}` then `run{error}` |
| `run_end` | `status == "aborted"` | `run{aborted}` (no text; the last checkpoint stands) |

Order within a run is the order ilmek yields events; the mapper preserves it. The terminal `run{...}` frame is always the last frame of its run.

## Why authoring helpers exist

You never write those `custom` payloads by hand. The [authoring helpers](../authoring/helpers.md) produce them:

| Helper | Emits the `custom` payload… | …which maps to |
|---|---|---|
| `mekik.text(ctx, content)` | ilmek token event | `genui` text chunk |
| `mekik.ui(ctx, component, props)` | `{$mekik:"genui", chunk:{type:"ui",…}}` | `genui` ui chunk |
| `mekik.event(ctx, name, payload)` | `{$mekik:"genui", chunk:{type:"event",…}}` | `genui` event chunk |
| `mekik.tool(ctx, name, params, fn)` | `{$mekik:"tool", call:{…}}` (running → completed/error) | `tool_call` upsert |
| `mekik.approve(ctx, payload, opts)` | `ctx.interrupt` with `$mekik:{ui,actions}` | `interrupt` frame |

The `$mekik` key is the reserved namespace the mapper keys on. It's an implementation detail of the helpers — but knowing it exists explains the fixtures.

## Interrupt payload wrapping (`unwrapInterrupt`)

`mekik.approve` attaches presentation metadata under `$mekik` before calling `ctx.interrupt`:

```jsonc
// what the node passed to ctx.interrupt(...)
{ "title": "249.90₺ refund",
  "$mekik": { "ui": { "component": "approval-form", "props": {…} },
              "actions": [ { "label": "Approve", "value": { "approved": true } } ] } }
```

`unwrapInterrupt(payload)` splits it into the `interrupt` frame's `data`:

```jsonc
{ "payload": { "title": "249.90₺ refund" },                     // $mekik stripped
  "ui":      { "component": "approval-form", "props": {…} },     // present only if given
  "actions": [ { "label": "Approve", "value": { "approved": true } } ] } // present only if given
```

A plain `ctx.interrupt(x)` with no `$mekik` key yields `{payload: x}` with no `ui`/`actions` — the client falls back to default Approve/Cancel chips. (Fixture `plain-interrupt` pins this.)

## The reply text frame

At `run_end{done}` the adapter selects the run's reply from final channel state via `MekikOptions.reply`. If it returns a non-empty string, the mapper emits **one** persistent `bot` `text` frame carrying it. If it returns `undefined` or empty, no text frame is emitted — the run's genui/tool frames were the whole answer.

A crucial distinction:

> Streaming tokens (`ctx.emitToken` / `mekik.text`) are **not** the persistent reply. They are transient `genui` text chunks. The consolidated `text` frame at run end is the durable record that replay will show.

So a node that streams prose token-by-token *and* returns a reply produces both: live `genui` text chunks during the run, and one persistent `text` bubble at the end. On reconnect, only the `text` bubble replays — which is what you want. (Fixture `reply-text` pins the consolidated frame; `tokens` pins the streaming chunks.)

## Resume routing

A `resume` frame maps to ilmek's `resumeKeyedStream(g, answers, {threadId: conversationId})`. Two rules the engine enforces:

- **Route by the thread-scoped interrupt `id`, never ilmek's task-scoped `key`.** Answering by `key` silently collapses concurrent pauses (ilmek `MODEL.md §6.1`). [Conformance scenario 6](../parity/conformance.md) proves it.
- When the resume run starts, the engine first emits an `interrupt_resolved` frame for each answered `id`, then the new run's frames.

There's a convenience path: a `genui_event{eventType:"submit", payload:{id, answer}}` whose `id` names an open interrupt is coerced by the engine to `resume{answers:{[id]: answer}}`. A form mounted by an `interrupt` frame's `ui` already knows its interrupt id, so it can either answer with a plain `resume` on submit (the ordinary path) or fire a `submit` event — no server-side stream↔interrupt binding is needed either way.

## Extending the mapping (reserved)

`custom` payloads the mapper doesn't recognise are **dropped** by default — the core mapping is closed so the [golden fixtures](../parity/conformance.md) stay authoritative. [`PROTOCOL.md §8`](https://github.com/AimTune/mekik/blob/main/PROTOCOL.md) reserves an `onCustom(payload, emit)` seam for mapping them to extra frames, kept deliberately outside that closed core.

It's a documented extension point rather than a shipped option in v1. To produce custom frames today, emit a payload the mapper already recognises (`$mekik: "genui"` or `$mekik: "tool"`) from your node via the [authoring helpers](../authoring/helpers.md) — that's what `mekik.ui` / `mekik.tool` do.

## Where to go next

- [**Parity → Conformance**](../parity/conformance.md) — the fixtures that pin every row of this table.
- [**Authoring → Helpers**](../authoring/helpers.md) — the helpers that produce these events.
- [**Frames**](./frames.md) — the shapes on the right-hand side of the table.
