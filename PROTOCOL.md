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

`PERSISTENT_FRAME_TYPES` is the closed list; **rich message frames** (§4.5) are
the one open extension to it: a frame whose `type` is a client message-renderer
name (not one of the protocol's own types) and that carries the `text` frame's
envelope is persistent under the same rules.

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
| `hello`       | `{type, userId?, conversationId?, watermark?, token?, meta?, componentsHash?}` | handshake; may also travel as WS query string. `meta` is a client-supplied context map (see §6).                                                                                                               |
| `text`        | `{type, data:{text}, meta?}`                                  | one user turn → starts a run (or is refused `busy`, §5).                                                                                                                                                       |
| `resume`      | `{type, answers:{[interruptId]: any}}`                        | answer the open interrupts, keyed by thread-scoped interrupt `id`. Must cover **every** open interrupt (ilmek's `resumeKeyed` requires it); a resume that omits one draws `error{incomplete_resume}`.          |
| `genui_event` | `{type, streamId, eventType, scope?, component?, payload}`     | an interaction from a mounted GenUI component. `scope` is `"component"` (from `component-event`), `"graph"` (from `mekik-event`), or absent (from `data-event`) and decides who receives it — the node parked on `onEvent`, the app's handler, or whichever answers first (§10.4). A `submit` naming an open interrupt is coerced to a `resume` regardless (§4.4). |
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
| _rich message_ (§4.5) | yes       | `{type: <rendererName>, id, seq, from:"bot"\|"user", data, timestamp}` - `type` is a client message-renderer name      |
| `genui_components`   | no         | `{type, hash, unchanged?, components?: ComponentDefinition[]}` — the server-defined component catalog (§10)              |
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
counter, the id of the open text run (so consecutive text deltas share one chunk
id — one growing bubble, not one per token), and it is handed the conversation's
persistent-`seq` allocator plus a
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
| `custom`                                                                                  | `isToken(payload)` (ilmek `{type:"token",text,meta?}`) | `genui` chunk `{type:"text", content: payload.text, id: <text-run id>}` under the turn stream, `done:false`. Consecutive text deltas reuse the open text-run id, so a client renders one growing bubble instead of one per token. |
| `custom`                                                                                  | `payload.$mekik == "genui"`                           | `genui` frame with `chunk = payload.chunk` (an `AIChunk`), `done:false`. If `chunk.id` is absent: a `text` chunk joins the open text run (shared id); a `ui`/`event` chunk closes that run and takes a fresh `nextChunkId`.       |
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

`mekik.onEvent()` (§10.4.1) uses the same envelope with `$mekik: {event: "<name>"}`,
which surfaces as a third split-out field:

```jsonc
{ "payload": {}, "event": "rate_delivery" }
```

`event` says the pause is waiting for a **component interaction** rather than an
answer, so a client must not offer default Approve/Cancel chips for it. It is also
what the engine matches an incoming `genui_event` against.

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

### 4.5 Rich message frames

A chativa conversation is rendered out of *messages*, each dispatched to a
renderer by its `type` (`"image"`, `"card"`, `"buttons"`, `"carousel"`, … —
chativa's `MessageTypeRegistry`). mekik/1 carries one as a **rich message
frame**: the `text` frame's envelope under the renderer's name, with the
renderer's payload as `data`:

```jsonc
{ "type": "image", "id": "msg-7", "seq": 12, "from": "bot",
  "data": { "src": "https://…/receipt.png", "caption": "Your receipt" },
  "timestamp": 1750000000000 }
```

Authors emit them with `mekik.message(ctx, type, data, {id?})` /
`Shuttle.Message` (or the typed `mekik.messages.*` / `Messages.*` catalog, see
[`docs/GENUI.md`](docs/GENUI.md)); the mapper recognises the reserved
`{$mekik:"message", messageType, data, id?}` custom payload and mints the frame
(id from the `IdMinter` unless the author supplied one).

The **greeting** emits them too. It fires on connect, outside any run, so it has
no `ctx` to emit from — instead the app *describes* the messages
(`mekik.messages.card.spec(…)` / `Messages.CardSpec(…)`, the value form
`{type, data, id?}`) and the engine mints the frames itself, in order, before any
turn. A greeting is a string, one description, or a list mixing both. GenUI
chunks are not available there: a chunk belongs to a turn's stream.

The rules:

- **Persistent.** Same `seq`, transcript, replay, and watermark treatment as
  `text`. This is the one open extension to `PERSISTENT_FRAME_TYPES` (§2).
- **Additive.** A client with no renderer for the `type` ignores the frame — the
  standard unknown-frame rule from the preamble. chativa's mekik connector
  routes any frame it does not itself handle to the message layer, so
  registered renderers pick these up with no connector change.
- **Reserved types.** The `type` MUST NOT be one of the protocol's own frame
  types (either direction), with a single deliberate overlap: `"text"` is
  allowed and produces a regular `text` frame (its `data` may then carry the
  text renderer's extras, e.g. `urls` for link previews). The helpers throw on
  a reserved type; a hand-built payload naming one is dropped by the mapper.
  `"typing"` is also reserved (chativa's shared frame parser claims it).
- **Interaction comes back as input, not as a special frame.** A tapped button,
  chip, or card action arrives as the next user `text` turn (the action's
  `value` — or label — as `data.text`), or as the `resume` answer when the run
  is parked on an interrupt. `mekik.choose` is the interrupt-bound form.

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

| helper                                                                | effect                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `mekik.text(ctx, content, {id?})` / `Shuttle.Text`                   | emit a `genui` text chunk (streaming prose)                                                 |
| `mekik.ui(ctx, component, props, {id?})` / `Shuttle.Ui`              | emit a `genui` ui chunk (mount a component)                                                 |
| `mekik.mount(ctx, component, props, {id?})` / `Shuttle.Mount`        | mount a ui chunk and return a handle whose `update(props)` re-emits the **same** chunk id  |
| `mekik.event(ctx, name, payload?, {id?})` / `Shuttle.Event`          | emit a `genui` event chunk                                                                  |
| `mekik.tool(ctx, name, params, fn)` / `Shuttle.Tool`                 | `ctx.step(name, fn)` (exactly-once) **and** emit `tool_call` running→completed/error traces |
| `mekik.approve(ctx, payload, {ui?, actions?})` / `Shuttle.Approve`   | `ctx.interrupt` with `$mekik:{ui,actions}` attached                                        |
| `mekik.action(label, value?)` / `Shuttle.Action`                     | build one `MessageAction` chip (typed constructor; no hand-written JSON)                    |
| `mekik.choose(ctx, payload, options, {ui?, key?})` / `Shuttle.Choose` | `approve` sugar: options become `actions` chips; resolves to the picked option's `value` (its label string when it has none) |
| `mekik.message(ctx, type, data, {id?})` / `Shuttle.Message`          | emit a rich message frame (§4.5)                                                            |
| `mekik.component<P>(name)` / `GenUI.*`, `GenUI.Names.*`              | bind a GenUI component name once, typed — chativa's built-ins are `mekik.genui.*`          |
| `mekik.messageKind<D>(type)` / `Messages.*`                          | bind a message type once, typed — chativa's built-ins are `mekik.messages.*`               |

`mekik.tool` is the important one: the side effect is journaled by `ctx.step`, so
on an interrupt-replay pass it is **not** re-run, while the `tool_call` trace it
emits is idempotent (upsert by id) so re-emitting on replay is harmless.

The optional `{id}` on the chunk emitters is the chunk's client-side key: emitting
another chunk with the **same id updates that element in place** (and an explicit
id opts the chunk out of text-run coalescing, §4.1). Omitted, the mapper assigns
stream-scoped ids; `mekik.mount` mints replay-stable ones (`taskId` + call order,
like tool ids) so a resume pass upserts instead of duplicating.

The typed catalogs (`component`/`genui`, `messageKind`/`messages`, `action`) add
**nothing** to the wire — a component or message is always a client-registered
name plus a JSON payload, and these only bind the name and check the payload.
See [`docs/GENUI.md`](docs/GENUI.md).

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

---

## 10. Server-defined components (§10)

A `ui` chunk names a component the **client** registered. That makes every new
widget a client release: someone has to compile a component into the page before
the graph can mount it.

§10 inverts that. The server can define the component itself - markup, styles and
prop defaults - and ship it as **metadata**. The client registers each definition
under its `name` and mounts it from an ordinary `ui` chunk from then on. Adding a
widget becomes a server deploy.

What travels is markup, never code. A definition cannot carry script, and the
client sanitizes the rendered result before it reaches the DOM.

### 10.1 The definition

```ts
interface ComponentDefinition {
  /** Registry name a `ui` chunk mounts by, e.g. "order-card". */
  name: string;
  /** Markup with `{{…}}` placeholders (§10.3). */
  template: string;
  /** Optional CSS, scoped to the component on the client. */
  css?: string;
  /** Prop defaults; also the declaration the client makes reactive. */
  props?: Record<string, unknown>;
  /** Definition version - a change re-registers the component. */
  version?: string;
  /** Custom element tag on the client. Derived from `name` when omitted. */
  tag?: string;
}
```

A definition whose `name` is empty or whose `template` is not a string is dropped
by the client. A definition MUST NOT replace a component the client registered
itself: a server cannot redefine `genui-form` under an app's feet.

### 10.2 The handshake

The catalog is versioned by an opaque hash, so it travels once rather than on
every connect:

```
client → hello        { …, componentsHash?: "<cached hash>" }
server → welcome      { … }
server → genui_components
         same hash    { type, hash, unchanged: true }              // no markup
         otherwise    { type, hash, components: [ …definitions ] }
```

- The frame is sent **immediately after `welcome`**, before the replay tail, so a
  widget named by the first replayed or streamed chunk is already registered.
- It is **transient**: no `seq`, never persisted, never replayed (§2).
- A server that defines no components sends no frame at all.
- `componentsHash` is a field on the existing `hello` frame, so validating the
  cache costs no extra round trip. The client stores `{ hash, components }` and
  hands the hash back on its next connect.
- The client MAY render from its cache before the server answers; an `unchanged`
  frame confirms that cache, and a catalog frame replaces it.

**Hash.** `sha256` (lowercase hex) over the canonical JSON (§9) of the definitions
sorted by `name`, with absent optional fields omitted rather than null. Both
implementations mint the identical hash for identical definitions, so a client can
move between a TypeScript and a .NET server without re-downloading. The client
never computes it - the hash is opaque, like an ETag.

### 10.3 The template language

A strict subset - enough to be useful, not an expression evaluator on the client:

| form | meaning |
| --- | --- |
| `{{path.to.value}}` | HTML-escaped interpolation |
| `{{#if path}} … {{else}} … {{/if}}` | truthiness; empty string / empty array / 0 are false |
| `{{#each path}} … {{/each}}` | iteration, with `{{this}}`, `{{this.field}}`, `{{@index}}`, and the parent scope still reachable by name |

Every interpolation is escaped, so a prop value can never inject markup. An unknown
path renders as the empty string; an unbalanced block closes at the end of the
template. Rendering never throws.

### 10.4 Interaction

A definition's markup declares its events instead of registering handlers. **The
attribute picks the addressee**, and that is the whole routing model:

| attribute | scope on the wire | who receives it |
| --- | --- | --- |
| `component-event="<name>"` | `"component"` | the node parked on `onEvent` / `OnEvent` waiting for that name - and nothing else |
| `mekik-event="<name>"` | `"graph"` | the app's `onGenUiEvent` / `OnGenUiEvent`, which may start a turn |
| `data-event="<name>"` | absent | tries the component route first, then the graph one |
| `data-payload='<json>'` | - | parsed and sent as the payload; invalid JSON travels as the raw string |
| `<form component-event="…">` | as above | the submit is intercepted and the named fields are sent, merged over `data-payload` |

The distinction is *who the click is talking to*, not what it does:
`component-event` addresses the widget's own conversation with the node that mounted
it, `mekik-event` addresses the app. `data-event` predates both and stays supported.

Those arrive at the server as an ordinary `genui_event` frame (§3.1), with `scope`
set from the attribute - a server-defined component gets the same round trip a
client-registered one does.

**What the server does with one.** Three rules, in order:

1. `eventType == "submit"` whose `payload.id` names an **open interrupt** is coerced
   to a `resume` (§4.4). A payload id is a direct address, so it outranks `scope`.
2. Unless the scope is `"graph"`: if a node is parked on `onEvent` waiting for this
   event name, the frame resolves that pause and its `payload` becomes the value the
   node's `await` returns. The pause is the binding, so nothing has to carry an id.
3. Unless the scope is `"component"`: the app's handler gets it and returns a graph
   input update to run a turn on, or nothing to ignore it.

**A frame that matches none of the three is accepted and dropped** - no handler
configured, or a `component-event` whose widget outlived the turn that mounted it. A
decorative button should cost nothing.

### 10.4.1 Waiting for a component event

`onEvent` is `approve` for widgets: the run parks, but a button on a component
already on screen answers it instead of chips in the chat.

```ts
deliveryCard(ctx, props, { id: "card-1" });                 // mount it first
const rating = await mekik.onEvent<{ stars: number }>(ctx, "rate_delivery");
```

```csharp
Shuttle.Ui(ctx, "delivery-card", props, id: "card-1");
var rating = await Shuttle.OnEvent<IReadOnlyDictionary<string, object?>>(ctx, "rate_delivery");
```

It is an ordinary ilmek interrupt, so it inherits everything §4 already guarantees:
the run ends `interrupted`, the thread is checkpointed, the wait survives a
disconnect or a restart, and `welcome.pending` re-announces it on reconnect. Its
`interrupt` frame carries **`data.event`** - the name it is waiting for - which is
how a client knows to wait for the widget rather than render default Approve/Cancel
chips. The node re-runs from the top on resume, so the usual rules apply: journal
side effects, and give pre-pause chunks literal ids.

While several pauses are open ilmek requires them all answered at once, so an
interaction arriving while another pause is also open draws
`error{incomplete_resume}` (§4.4) - the same rule the `submit` shortcut plays by.

### 10.4.2 Handling a graph-wide event

| | TypeScript | .NET |
| --- | --- | --- |
| handler | `onGenUiEvent: (ev) => …` | `OnGenUiEvent = ev => …` |
| ignore | return `undefined` | return `null` |
| the event | `{conversationId, userId, streamId, eventType, component?, payload?}` | `GenUiEvent` record, same fields |

```ts
mekik({
    graph,
    components: [orderCard],
    onGenUiEvent: (ev) =>
        ev.eventType === "track_order" ? { input: `track ${(ev.payload as { id: string }).id}` } : undefined,
});
```

It is a mapper, not a place to do work - the same role `input` plays for a `text`
turn. Side effects belong in the node the turn reaches, where the journal makes them
exactly-once (§9). The turn it starts obeys §5: one at a time (`error{busy}`), never
over a pause (`error{interrupted}`). It writes no `text` frame on the user's behalf -
a click is not an utterance, and the transcript already carries the widget it came
from.

### 10.5 Authoring

| | TypeScript | .NET |
| --- | --- | --- |
| define | `defineComponent({name, template, css?, props?})` | `new ComponentSpec { Name, Template, Css, Props }` |
| as a class | `class X extends GenUiComponent` | `class X : GenUiComponent` |
| register | `mekik({ graph, components: [x] })` | `new MekikOptions { Components = [x] }` |
| emit | the `defineComponent` result is the typed emitter | `component.Emit(ctx, props)` / `Shuttle.Ui(ctx, name, props)` |

Duplicate names throw at startup - a catalog with two `order-card`s is a
configuration error, not a runtime surprise.

### 10.6 Driving a defined component

A definition is markup; the chunk stream is what makes it move. Nothing here is
specific to §10 - a server-defined component is driven exactly like a
client-registered one - but the two rules below are where demos go wrong.

**Re-send the id to update in place.** A `ui` chunk whose `id` is already on
screen replaces that element instead of appending another:

```
ui  {component:"order-card", id:"card-1", props:{status:"Preparing"}}    → mounted
ui  {component:"order-card", id:"card-1", props:{status:"In transit"}}   → same element, new props
ui  {component:"strip",      id:"strip-1", props:{step:"Picked up"}}     → a second element below it
```

The client keeps one element instance per id, so the DOM node survives the
update - internal state, focus and scroll position stay put.

**Pace it.** Two emissions in the same millisecond are one render as far as the
user is concerned: the widget just appears in its final state. If the point is to
*show* progress, put real time between the chunks.

**Journal what happens before a pause.** An interrupt resumes by replaying the
node from the top. Emitting a chunk is a side effect, so wrap each pre-pause
beat in `ctx.step` (`ctx.StepAsync` in .NET) - on the replay pass the recorded
value comes back and the body does not run, so the client is not walked back
through states it already rendered. Use literal chunk ids across a pause for the
same reason: an id minted by a counter drifts once its call site stops running.

```ts
const phase = (ctx, name, emit) =>
    ctx.step(name, async () => { await sleep(1800); emit(); return true; });

await phase(ctx, "packing",    () => card(ctx, props("Preparing"),  { id: "card-1" }));
await phase(ctx, "in_transit", () => card(ctx, props("In transit"), { id: "card-1" }));

// the widgets stay on screen while the chips render
const choice = await mekik.choose(ctx, "What should the courier do?", [
    mekik.action("Hand it to me", "handover"),
    mekik.action("Reschedule", "reschedule"),
] as const);

// …and the answer re-renders the element the user is already looking at
card(ctx, props(choice === "handover" ? "Delivered" : "Rescheduled"), { id: "card-1" });
```

Runnable: `ts/examples/server-components.ts`,
`dotnet/examples/Mekik.ServerComponents`.

