---
sidebar_position: 2
title: Frames
description: Every mekik/1 frame — client→server and server→client — with its shape, persistence, and a wire example.
---

# Frames

Every message on a mekik socket is a **frame**: a flat JSON object with a `type` discriminator. This page is the catalogue. Shapes here match [`PROTOCOL.md §3`](https://github.com/AimTune/mekik/blob/main/PROTOCOL.md) and the [golden fixtures](../parity/conformance.md) — the fixtures are authoritative.

Frames are flat (no nested envelope). Persistent server→client frames carry a `seq`; some carry a `timestamp` (ms since epoch). Transient frames carry neither.

## Client → server

| `type` | shape | meaning |
|---|---|---|
| `hello` | `{type, userId?, conversationId?, watermark?, token?, meta?}` | Handshake. May instead travel as the WS query string. `meta` is a client-supplied context map. All fields optional. |
| `text` | `{type, data:{text}, meta?}` | One user turn → starts a run (or is refused `busy` / `interrupted`). |
| `resume` | `{type, answers:{[interruptId]: any}}` | Answer the open interrupts, keyed by thread-scoped interrupt `id`. Must cover **every** open interrupt. |
| `genui_event` | `{type, streamId, eventType, payload}` | An interaction from a mounted GenUI component. A `submit` whose `payload.id` names an open interrupt is coerced to a `resume`. |
| `abort` | `{type}` | Cancel the in-flight run at the next superstep boundary. The last checkpoint stands. |

A malformed inbound frame (bad JSON, missing `type`) draws `error{code:"bad_request"}` and is otherwise ignored — the connection stays open.

### `hello`

Sent first on a new socket. Identity may be asserted here or omitted for an anonymous connect:

```jsonc
{ "type": "hello", "userId": "u-1", "conversationId": "conv-9", "watermark": 12,
  "token": "eyJhbGc…", "meta": { "locale": "tr" } }
```

The transport also accepts these as query-string params (`?userId=…&conversationId=…&watermark=…&token=…`) and merges them; the `hello` frame wins on conflict. See [Transport](../serving/transport.md).

### `text`

One user turn:

```jsonc
{ "type": "text", "data": { "text": "ORD-42" } }
```

### `resume`

Answer open interrupts, keyed by the interrupt `id` the `interrupt` frame carried:

```jsonc
{ "type": "resume", "answers": { "gate:interrupt#0": { "approved": true } } }
```

Answering by `id` (not ilmek's `key`) and covering *every* open interrupt are both required — see [Human-in-the-loop](../authoring/human-in-the-loop.md#answering).

## Server → client

| `type` | persistent | shape |
|---|---|---|
| `welcome` | no | `{type, data:{protocol, conversationId, userId, connectionId, watermark, pending: PendingView[]}}` |
| `text` | **yes** | `{type, id, seq, from:"bot"\|"user", data:{text}, timestamp}` |
| `tool_call` | **yes** | `{type, seq, data:{id, name, status:"running"\|"completed"\|"error", params?, result?, error?}}` |
| `genui` | **yes** | `{type, seq, streamId, done, chunk: AIChunk}` |
| `interrupt` | **yes** | `{type, seq, id, data:{payload, ui?, actions?}}` |
| `interrupt_resolved` | **yes** | `{type, seq, id, data:{answer?}}` |
| `run` | no | `{type, data:{status:"started"\|"finished"\|"interrupted"\|"error"\|"aborted"}}` |
| `error` | no | `{type, data:{code, message}}` |

### Persistent frames

These carry `seq` and are the durable transcript — exactly what reconnect replays.

**`text`** — a chat bubble. `from` is `"bot"` (the run's reply) or `"user"` (the fan-out/replay copy of a user's own turn to their *other* connections):

```jsonc
{ "type": "text", "id": "msg-1", "seq": 13, "from": "bot",
  "data": { "text": "Refund complete: ORD-42" }, "timestamp": 1750000000000 }
```

**`tool_call`** — a tool lifecycle, **upserted by `data.id`**. The same id is re-sent as status advances; the client updates the existing entry rather than adding a new one:

```jsonc
{ "type": "tool_call", "seq": 6, "data": {
    "id": "call-1", "name": "get_order", "status": "running", "params": { "id": "ORD-42" } } }
{ "type": "tool_call", "seq": 7, "data": {
    "id": "call-1", "name": "get_order", "status": "completed", "result": { "total": 249.9 } } }
```

**`genui`** — one `AIChunk` under a turn `streamId`. `done:false` while the stream is open; the mapper closes it at run end with a `stream_done` event chunk (`done:true`):

```jsonc
{ "type": "genui", "seq": 8, "streamId": "stream-1", "done": false,
  "chunk": { "type": "ui", "component": "order-card", "props": { "id": "ORD-42" }, "id": 0 } }
```

**`interrupt`** — a human-in-the-loop pause. `id` is the thread-scoped interrupt id a `resume` answers; `data.payload` is the question; `ui` and `actions` are optional presentation:

```jsonc
{ "type": "interrupt", "seq": 9, "id": "gate:interrupt#0", "data": {
    "payload": { "title": "Refund $249.9 for ORD-42?" },
    "ui": { "component": "approval-form", "props": { "orderId": "ORD-42" } },
    "actions": [ { "label": "Approve", "value": { "approved": true } },
                 { "label": "Reject",  "value": { "approved": false } } ] } }
```

**`interrupt_resolved`** — acknowledges an answered pause so every tab and future replay learns it's closed:

```jsonc
{ "type": "interrupt_resolved", "seq": 10, "id": "gate:interrupt#0",
  "data": { "answer": { "approved": true } } }
```

### Transient frames

Live-only. Never stored, never replayed.

**`welcome`** — sent on every connect, before any replay:

```jsonc
{ "type": "welcome", "data": {
    "protocol": "mekik/1", "conversationId": "conv-9", "userId": "u-1",
    "connectionId": "connection-abc", "watermark": 12, "pending": [] } }
```

`pending` is a `PendingView[]` re-announcing open interrupts so a reconnecting UI can re-render approval forms. A `PendingView` is `{id, data:{payload, ui?, actions?}}` — an `interrupt` frame minus `seq`/`timestamp`.

**`run`** — the turn's lifecycle signal; always the last frame of its run:

```jsonc
{ "type": "run", "data": { "status": "interrupted" } }
```

Statuses: `started`, `finished`, `interrupted`, `error`, `aborted`. See [Engine → terminal states](../engine.md#the-four-terminal-states).

**`error`** — a coded, non-fatal error to one sender (the socket stays open unless it's an auth reject):

```jsonc
{ "type": "error", "data": { "code": "interrupted", "message": "answer the open interrupt(s) first" } }
```

## Error codes

| `code` | Cause | Socket |
|---|---|---|
| `busy` | a `text` arrived while a run is in flight | stays open |
| `interrupted` | a `text` (not `resume`) arrived while the thread is parked | stays open |
| `incomplete_resume` | a `resume` omitted an open interrupt | stays open |
| `bad_request` | malformed inbound frame | stays open |
| `unauthorized` | the authenticator rejected the connection | **closes** with WS code 4401 |
| `internal` | a handler threw | stays open if it can |

## Shared payload types

**`AIChunk`** (the `genui` payload; identical to chativa's):

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
type AIChunk =
  | { type: "ui"; component: string; props?: Record<string, unknown>; id?: string | number }
  | { type: "text"; content: string; id?: string | number }
  | { type: "event"; name: string; payload?: unknown; id?: string | number };
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
// .NET frames/chunks are Dictionary<string, object?> (parity §2) — same wire JSON,
// no typed AIChunk. A "text" chunk, for example:
new Dictionary<string, object?> { ["type"] = "text", ["content"] = "Hi" };
```

</TabItem>
</Tabs>

**`MessageAction`** (an interrupt/quick-reply chip):

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
type MessageAction = { label: string; value?: unknown };
// value omitted → the answer is the label string
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
// value omitted → the answer is the label string.
new Dictionary<string, object?> { ["label"] = "Approve", ["value"] = new Dictionary<string, object?> { ["approved"] = true } };
```

</TabItem>
</Tabs>

## Where to go next

- [**Identity & resume**](./identity.md) — how `seq`, `watermark`, and the four ids drive replay.
- [**Event mapping**](./event-mapping.md) — which ilmek event produces each of these frames.
- [**Authoring → Helpers**](../authoring/helpers.md) — how to emit these frames from a node.
