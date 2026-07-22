# mekik/1 - the wire protocol

> Normative. This document is to mekik what `MODEL.md` is to ilmek: the two
> implementations (TypeScript reference + .NET port) MUST agree with it
> byte-for-byte on the wire. Where prose and the golden fixtures in
> `conformance/fixtures/` disagree, the fixtures win.

mekik is the realtime serving layer for **ilmek** graphs. It turns a running
ilmek graph into a live conversation: a client (the chativa widget) sends user
turns and interrupt answers over a persistent connection; the server drives the
graph and streams back text, generative UI, tool traces, and human-in-the-loop
pauses. One graph run == one conversational turn.

```
chativa ⇄ @chativa/connector-mekik ⇄ WebSocket ⇄ ConversationEngine ⇄ IlmekAdapter ⇄ ilmek graph
                                                    │ HistoryStore                     │ Checkpointer
                                                    │ ConversationStore                │ (ilmek's own)
                                                    │ Authenticator
```

`PROTOCOL_VERSION = "mekik/1"`. It is announced in `welcome.data.protocol`. A
major bump is breaking; within a major, receivers MUST ignore unknown fields and
unknown frame `type`s so additive changes never break an older peer.

mekik/1 replaces the standalone 4-language connector that preceded it. The breaking
changes from that predecessor: interrupts are first-class `interrupt` / `resume` /
`interrupt_resolved` frames instead of a `text`+`actions` convention answered by
the next user message; the `run` frame gains `interrupted`/`error`/`aborted`
states; `welcome` re-announces open interrupts. Frame names that chativa already
renders (`text`, `tool_call`, `genui`) are unchanged.

---

## 1. Identity model (§1)

Four ids - chativa already speaks them:

| id               | lifetime      | owns                                                                                                           |
| ---------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `userId`         | permanent     | the user's cross-conversation store (`user:{userId}`)                                                          |
| `conversationId` | until deleted | transcript (HistoryStore), conversation store, ilmek **thread** - `conversationId` **is** the ilmek `threadId` |
| `connectionId`   | one socket    | nothing; a routing handle for one live connection                                                              |
| `watermark`      | per client    | the highest persistent-frame `seq` this client has durably seen                                                |

A conversation may have many live connections at once (multi-tab, multi-device).
Every persistent frame is broadcast to all of them. A user's own `text` turn is
**not** echoed back to the connection that sent it, but it **is** delivered to the
conversation's other connections and written to the transcript (so a second tab
sees what the first tab typed, and reconnect replay is complete).

Anonymous connect is allowed: if the client asserts no `userId`/`conversationId`,
the server mints them and returns them in `welcome`. A client that asserts ids
adopts whatever the server returns - if the server hands back a _different_
`conversationId` than requested, the client MUST reset its watermark to 0 (the
asserted conversation did not exist / was not resumable).

When an `Authenticator` is configured, connect requires a valid credential and a
**verified `userId` overrides any client-asserted one** (anti-spoofing). See §7.

---

## 2. Transport & framing (§2)

Frames are JSON objects with a `type` discriminator. The reference transport is
**WebSocket** (`ws://` / `wss://`), one frame per message, UTF-8 text. The frame
shapes are transport-agnostic; other transports (SSE, Socket.IO, SignalR) MAY be
added later carrying the identical frames.

**Envelope.** Frames are flat. Server→client frames that are
_persistent_ carry a 1-based, per-conversation, strictly monotonic `seq` with no
gaps, plus a `timestamp` (ms since epoch) where noted. Transient frames carry
neither.

```
PERSISTENT_FRAME_TYPES = ["text", "tool_call", "genui", "interrupt", "interrupt_resolved"]
```

Persistent frames are appended to the transcript and are what reconnect replays.
Transient frames (`welcome`, `run`, `error`) are live-only: never stored, never
replayed. On (re)connect the server sends `welcome`, then replays every persistent
frame with `seq > watermark` in order, then resumes live delivery.

> **Two seq spaces - do not conflate.** ilmek stamps every `IlmekEvent` with its
> own per-_run_ `seq` (internal, resets each run). mekik's persistent-frame `seq`
> is per-_conversation_ and spans every run of that conversation; it is the
> watermark. The adapter never forwards ilmek's `seq`; the engine assigns
> mekik's.

---

## 3. Frames

### 3.1 Client → server

| `type`        | shape                                                         | meaning                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`       | `{type, userId?, conversationId?, watermark?, token?, meta?}` | handshake; may also travel as WS query string. `meta` is a client-supplied context map (see §6).                                                                                                               |
| `text`        | `{type, data:{text}, meta?}`                                  | one user turn → starts a run (or is refused `busy`, §5).                                                                                                                                                       |
| `resume`      | `{type, answers:{[interruptId]: any}}`                        | answer the open interrupts, keyed by thread-scoped interrupt `id`. Must cover **every** open interrupt (ilmek's `resumeKeyed` requires it); a resume that omits one draws `error{incomplete_resume}`.          |
| `genui_event` | `{type, streamId, eventType, payload}`                        | an interaction from a mounted GenUI component. If the component was bound to an interrupt and `eventType == "submit"`, the server treats it as a `resume` for that interrupt (§4.4). |
| `abort`       | `{type}`                                                      | cancel the in-flight run. The graph stops at the next superstep boundary; the last checkpoint stands, so the thread stays resumable.                                                                           |

Malformed frames (bad JSON, missing `type`, unknown required fields) draw an
`error` frame `{code:"bad_request"}` and are otherwise ignored (the connection
stays open).

### 3.2 Server → client

| `type`               | persistent | shape                                                                                                                  |
| -------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `welcome`            | no         | `{type, data:{protocol, conversationId, userId, connectionId, watermark, pending: PendingView[]}}`                     |
| `text`               | yes        | `{type, id, seq, from:"bot"\|"user", data:{text}, timestamp}`                                                          |
| `tool_call`          | yes        | `{type, seq, data:{id, name, status:"running"\|"completed"\|"error", params?, result?, error?}}` - upsert by `data.id` |
| `genui`              | yes        | `{type, seq, streamId, done, chunk: AIChunk}`                                                                          |
| `interrupt`          | yes        | `{type, seq, id, data:{payload, ui?, actions?}}`                                                                       |
| `interrupt_resolved` | yes        | `{type, seq, id, data:{answer?}}`                                                                                      |
| `run`                | no         | `{type, data:{status:"started"\|"finished"\|"interrupted"\|"error"\|"aborted"}}`                                       |
| `error`              | no         | `{type, data:{code, message}}`                                                                                         |

`PendingView` (re-announced in `welcome.data.pending` so a reconnecting UI can
re-render open approval forms) = `{id, data:{payload, ui?, actions?}}` - the same
shape as an `interrupt` frame's `id` + `data`, minus `seq`/`timestamp`.

`AIChunk` (identical to chativa's `AIChunk`, so the widget renders it unchanged):

```ts
type AIChunk =
  | {
      type: "ui";
      component: string;
      props?: Record<string, unknown>;
      id?: string | number;
    }
  | { type: "text"; content: string; id?: string | number }
  | { type: "event"; name: string; payload?: unknown; id?: string | number };
```

`MessageAction` (interrupt/chip fallback): `{ label: string; value?: unknown }`.
When `value` is omitted the answer is the `label` string.

---

## 4. ilmek event → frame mapping (§4)

This is the canonical, tested contract. The **`eventToFrames` mapper** consumes
the ilmek `IlmekEvent` stream of one run and produces mekik frames. It is
**turn-stateful**: it owns the current turn's `streamId`, the per-stream chunk
counter, and it is handed the conversation's persistent-`seq` allocator plus a
deterministic id minter (so the golden fixtures are reproducible across
languages; see `conformance/README.md`).

ilmek `IlmekEvent` variants (from the ilmek repo — `ts/packages/core/src/engine.ts`,
`dotnet/src/Ilmek.Core/Events.cs`; mekik consumes `@ilmek/core` / `Ilmek.Core`):

`run_start` · `step_start` · `node_start` · `custom{payload}` · `node_end{node,update}` ·
`node_error{node,error}` · `node_retry` · `state{channels}` · `checkpoint{id}` ·
`interrupt{pending: Pending[]}` · `run_end{status: done|interrupted|error|aborted, …}`

### 4.1 The mapping table

| `IlmekEvent`                                                                              | condition                                              | frame(s) emitted                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_start`                                                                               | -                                                      | `run{started}`                                                                                                                                                                                                                   |
| `custom`                                                                                  | `isToken(payload)` (ilmek `{type:"token",text,meta?}`) | `genui` chunk `{type:"text", content: payload.text, id: nextChunkId}` under the turn stream, `done:false`                                                                                                                        |
| `custom`                                                                                  | `payload.$mekik == "genui"`                           | `genui` frame with `chunk = payload.chunk` (an `AIChunk`); assign `chunk.id = nextChunkId` if absent; `done:false`                                                                                                               |
| `custom`                                                                                  | `payload.$mekik == "tool"`                            | `tool_call` frame `{data: payload.call}` (upsert by `call.id`)                                                                                                                                                                   |
| `custom`                                                                                  | otherwise                                              | nothing (reserved for an extension hook, §8)                                                                                                                                                                                     |
| `node_start`, `node_end`, `node_error`, `node_retry`, `step_start`, `state`, `checkpoint` | -                                                      | nothing in v1 (a future `debug` stream mode may surface them)                                                                                                                                                                    |
| `interrupt`                                                                               | for each `p` in `pending`                              | one `interrupt` frame `{id: p.id, data: unwrapInterrupt(p.payload)}`                                                                                                                                                             |
| `run_end`                                                                                 | `status == "interrupted"`                              | `run{interrupted}`                                                                                                                                                                                                               |
| `run_end`                                                                                 | `status == "done"`                                     | close the turn stream if open (`genui` `{done:true, chunk:{type:"event", name:"stream_done", id:nextChunkId}}`); then, if the run produced a reply (see §4.3), a `text` `{from:"bot", data:{text: reply}}`; then `run{finished}` |
| `run_end`                                                                                 | `status == "error"`                                    | `text` `{from:"bot", data:{text:"⚠️ " + message}}` then `run{error}`                                                                                                                                                             |
| `run_end`                                                                                 | `status == "aborted"`                                  | `run{aborted}` (no text; the last checkpoint stands)                                                                                                                                                                             |

Order within a run is the order ilmek yields events; the mapper preserves it. The
`run{interrupted}`/`run{finished}`/… transient frame is always the last frame of
its run.

### 4.2 Interrupt payload wrapping (`unwrapInterrupt`)

`mekik.approve()` (the HITL helper, §6) attaches presentation metadata to the
interrupt payload under a reserved `$mekik` key before calling `ctx.interrupt`:

```jsonc
// what the node passed to ctx.interrupt(...)
{ "title": "249.90₺ refund", "$mekik": { "ui": {"component":"approval-form","props":{…}},
                                          "actions": [{"label":"Approve","value":{"approved":true}}] } }
```

`unwrapInterrupt(payload)` splits it:

```jsonc
{ "payload": { "title": "249.90₺ refund" },      // $mekik stripped
  "ui":      { "component":"approval-form", "props":{…} },   // present only if given
  "actions": [ {"label":"Approve","value":{"approved":true}} ] }  // present only if given
```

A plain `ctx.interrupt(x)` with no `$mekik` key yields `{payload: x}` with no
`ui`/`actions` - the client falls back to default Approve/Cancel chips.

### 4.3 The reply text frame

At `run_end{done}` the adapter selects the run's reply from final channel state
via the configured reply selector (`MekikOptions.reply`, §6). If it returns a
non-empty string, the mapper emits one persistent `bot` `text` frame carrying it;
if it returns `undefined`/empty, no text frame is emitted (the turn's genui/tool
frames were the whole answer). Streaming tokens (`ctx.emitToken`) are **not** the
persistent reply - they are transient `genui` text chunks; the consolidated
`text` frame at run end is the durable record replay will show.

### 4.4 Resume routing

A `resume` frame maps directly to `resumeKeyedStream(g, answers, {threadId:
conversationId, …})`. The engine MUST route by the thread-scoped interrupt `id`,
never by ilmek's task-scoped `key` - answering by `key` silently collapses
concurrent pauses (ilmek MODEL.md §6.1, conformance scenario 8). When the resume
run starts, the engine first emits an `interrupt_resolved` frame for each answered
`id` (so every tab, and future replay, learns the pause is closed), then the new
run's frames.

A form mounted by an `interrupt` frame's `ui` knows its interrupt `id` (the frame
carried it), so the ordinary path is for the client to answer with a plain
`resume{answers:{[id]: …}}` on submit. As a convenience, a
`genui_event{eventType:"submit", payload:{id, answer}}` whose `id` names an open
interrupt is coerced by the engine to `resume{answers:{[id]: answer}}` — no
server-side stream↔interrupt binding is needed.

---

## 5. Turn lifecycle & concurrency (§5)

One run per conversation at a time, guarded by a per-conversation turn lock:

1. Client sends `text` (or `resume`). If the conversation already has a run in
   flight, the server replies `error{code:"busy"}` to that sender only and drops
   the frame - no second run starts.
2. `run{started}` → the graph runs, streaming `genui`/`tool_call` frames.
3. Terminal: `run{finished}` (done), `run{interrupted}` (paused on interrupt(s)),
   `run{error}`, or `run{aborted}`.
4. A `text` frame that arrives while the thread is parked on an interrupt is
   **refused** with `error{code:"interrupted", message:"answer the open
interrupt(s) first"}` - mirroring ilmek's `ResumeError`, a plain new turn would
   drop the pause. The client must send `resume` instead.

The turn lock is process-local; horizontal scale (a distributed lock + cross-node
fan-out) is out of scope for v1 and requires sticky routing per `conversationId`.

---

## 6. Graph context as a parameter (§6)

The graph run receives context from three merged sources, placed on ilmek
`RunOptions.meta`:

- `meta.mekik` - the server-computed context: `MekikOptions.context(conv, turn)`
  evaluated per turn. `conv = {conversationId, userId}`, `turn = {text, meta}`.
- `meta.client` - the allowlisted subset of the client's `hello.meta` / frame
  `meta` (the server decides via `MekikOptions.acceptClientMeta`; default: drop
  everything).
- `meta.auth` - the verified `claims` from the Authenticator, if any.

Nodes read these via ilmek `ctx.meta`. This is how a graph is parameterized per
conversation without the graph knowing anything about mekik.

**Author helpers** (`@mekik/core`, `Mekik.Core`) - all take ilmek `ctx`, so no
ambient storage is needed (ilmek already threads `ctx` everywhere):

| helper                                                             | effect                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `mekik.text(ctx, content)` / `Mekik.Text`                        | emit a `genui` text chunk (streaming prose)                                                 |
| `mekik.ui(ctx, component, props)` / `Mekik.Ui`                   | emit a `genui` ui chunk (mount a component)                                                 |
| `mekik.event(ctx, name, payload?)` / `Mekik.Event`               | emit a `genui` event chunk                                                                  |
| `mekik.tool(ctx, name, params, fn)` / `Mekik.Tool`               | `ctx.step(name, fn)` (exactly-once) **and** emit `tool_call` running→completed/error traces |
| `mekik.approve(ctx, payload, {ui?, actions?})` / `Mekik.Approve` | `ctx.interrupt` with `$mekik:{ui,actions}` attached                                        |

`mekik.tool` is the important one: the side effect is journaled by `ctx.step`, so
on an interrupt-replay pass it is **not** re-run, while the `tool_call` trace it
emits is idempotent (upsert by id) so re-emitting on replay is harmless.

---

## 7. Auth (§7, opt-in)

Credential arrives via `hello.token`, WS
`?token=`, an `Authorization: Bearer` header, or a cookie. The `Authenticator`
port returns `{ok, userId?, claims?, reason?}`. On reject: send `error`
`{code:"unauthorized", message: reason}` then close with WS code **4401**
(`AUTH_CLOSE_CODE`). A verified `userId` overrides the client-asserted one;
`claims` land in `meta.auth`. Auth is connect-time only in v1 (no mid-session
refresh/expiry, no RBAC).

---

## 8. Extensibility & non-goals (§8)

- **Custom event mapping.** `custom` payloads the mapper doesn't recognise are
  dropped by default. `MekikOptions.onCustom(payload, emit)` MAY map them to
  extra frames (kept out of the core mapping so the golden fixtures stay closed).
- **Non-goals (v1):** horizontal scale / distributed turn lock; transports other
  than WebSocket; durable (Redis/Postgres) history stores (ports exist,
  in-memory only ships); a `debug` stream mode surfacing node/state/checkpoint
  frames; subgraph `ns` surfacing; Go/Python ports.

---

## 9. Language parity (§9)

The two implementations are held to the same wire by the golden fixtures in
`conformance/fixtures/` (shared JSON, both suites replay them through
`eventToFrames` and compare canonical output) plus the scenario list in
`conformance/README.md`. Canonical JSON = UTF-8, object keys sorted
ascending, no insignificant whitespace, numbers in shortest round-trip form.

Naming (extends MODEL.md §11):

| concept           | TypeScript                          | .NET                                             |
| ----------------- | ----------------------------------- | ------------------------------------------------ |
| app               | `mekik(options)` → `MekikApp`     | `new MekikApp(MekikOptions)`                   |
| serve             | `serveWs(app, {port, path})`        | `app.MapMekik(path)` on `IEndpointRouteBuilder` |
| engine            | `ConversationEngine`                | `ConversationEngine`                             |
| event→frame       | `eventToFrames` / `TurnMapper`      | `Mapper.EventToFrames` / `TurnMapper`             |
| helpers           | `mekik.text/ui/event/tool/approve` | `Shuttle.Text/Ui/Event/Tool/Approve`              |
| history port      | `HistoryStore`                      | `IHistoryStore`                                  |
| conversation port | `ConversationStore`                 | `IConversationStore`                             |
| auth port         | `Authenticator`                     | `IAuthenticator`                                 |

**.NET caveat (MODEL.md §11 divergence 2):** any `try/catch` in the adapter or
helpers that wraps node execution MUST rethrow when
`InterruptSignalException.IsInterrupt(ex)` - a blanket `catch (Exception)` would
swallow the pause.
