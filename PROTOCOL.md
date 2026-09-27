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
| `hello`       | `{type, userId?, conversationId?, watermark?, token?, meta?, componentsHash?, tools?, skillsHash?, skills?}` | handshake; may also travel as WS query string. `meta` is a client-supplied context map (see §6); `tools` declares this client's callable tools (§11.1); `skillsHash` is the server skill catalog the client has cached and `skills` declares the client's own skills (§12). |
| `text`        | `{type, data:{text}, meta?}`                                  | one user turn → starts a run (or is refused `busy`, §5).                                                                                                                                                       |
| `resume`      | `{type, answers:{[interruptId]: any}}`                        | answer the open interrupts, keyed by thread-scoped interrupt `id`. Must cover **every** open interrupt (ilmek's `resumeKeyed` requires it); a resume that omits one draws `error{incomplete_resume}`.          |
| `genui_event` | `{type, streamId, eventType, scope?, component?, payload}`     | an interaction from a mounted GenUI component. `scope` is `"component"` (from `component-event`), `"graph"` (from `mekik-event`), or absent (from `data-event`) and decides who receives it — the node parked on `onEvent`, the app's handler, or whichever answers first (§10.4). A `submit` naming an open interrupt is coerced to a `resume` regardless (§4.4). |
| `client_tools` | `{type, tools: ClientToolDefinition[]}`                      | replace this connection's declared client tools (§11.1). The list is the connection's whole new set; `[]` withdraws every tool. Inert unless the server opted in.                                              |
| `client_skills` | `{type, skills: ClientSkillDefinition[]}`                   | replace this connection's declared client skills (§12.4). The list is the connection's whole new set; `[]` withdraws every skill. Inert unless the server opted in.                                          |
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
| `skill`              | yes        | `{type, seq, data:{id, name, status:"loaded"\|"error", source?, error?}}` - a skill use (§12.5), upsert by `data.id`   |
| `genui`              | yes        | `{type, seq, streamId, done, chunk: AIChunk}`                                                                          |
| `interrupt`          | yes        | `{type, seq, id, data:{payload, ui?, actions?, event?, tool?}}`                                                        |
| `interrupt_resolved` | yes        | `{type, seq, id, data:{answer?}}`                                                                                      |
| _rich message_ (§4.5) | yes       | `{type: <rendererName>, id, seq, from:"bot"\|"user", data, timestamp}` - `type` is a client message-renderer name      |
| `genui_components`   | no         | `{type, hash, unchanged?, components?: ComponentDefinition[]}` — the server-defined component catalog (§10)              |
| `skills`             | no         | `{type, hash, unchanged?, skills?: SkillSummary[]}` — the server's skill catalog, level 1 only (§12.2)                   |
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

`mekik.callClientTool()` (§11.3) uses the envelope a third way, with
`$mekik: {tool: {name, params?}}`, which surfaces as the split-out `tool` field:

```jsonc
{ "payload": {}, "tool": { "name": "pick_date", "params": { "min": "2026-08-01" } } }
```

`tool` says the pause is a **client tool call**: the client runs the named tool
and answers with the result envelope (§11.3) — again, no default chips.

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
- `meta.clientTools` - the turn's client tool snapshot (§11.2), present only when
  the server opted in via `MekikOptions.clientTools` and something is declared.
- `meta.skills` - the turn's skill source (§12.3): the server catalog merged with
  the accepted client declarations, present only when the app configured
  `MekikOptions.skills` or a client skill was accepted. Read it through the
  helpers, not directly.

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
| `mekik.clientTools(ctx, {tags?, mode?})` / `Shuttle.ClientTools`     | the turn's client tool snapshot, filtered by tag/mode (§11.2)                               |
| `mekik.callClientTool(ctx, name, params?, {key?})` / `Shuttle.CallClientToolAsync` | invoke a client tool — a durable interrupt round-trip, or a fire-and-forget chunk for a `notify` tool (§11.3) |
| `mekik.skills(ctx, {tags?, source?})` / `Shuttle.Skills`            | the turn's skill summaries — level 1, filtered by tag/origin (§12.3)                        |
| `mekik.skillsPrompt(ctx, filter?, {intro?})` / `Shuttle.SkillsPrompt` | the `<available_skills>` block for a system prompt; `""` when there is nothing to list (§12.3) |
| `mekik.loadSkill(ctx, name)` / `Shuttle.LoadSkill`                  | one skill's instructions — level 2 — **and** a `skill` trace (§12.5); unknown name ⇒ error trace + throw |
| `mekik.skillResource(ctx, name, path)` / `Shuttle.SkillResourceAsync` | one bundled file — level 3 — when the source has files behind it (§12.5)                    |
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
| client tools read | `mekik.clientTools`                 | `Shuttle.ClientTools`                            |
| client tool call  | `mekik.callClientTool`              | `Shuttle.CallClientToolAsync`                    |
| skills read       | `mekik.skills` / `mekik.skillsPrompt` | `Shuttle.Skills` / `Shuttle.SkillsPrompt`      |
| skill load        | `mekik.loadSkill` / `mekik.skillResource` | `Shuttle.LoadSkill` / `Shuttle.SkillResourceAsync` |
| skill source port | `SkillSource`                       | `ISkillSource`                                   |
| MCP server        | `MekikMcpServer` / `serveMcp` (`@mekik/mcp`) | `MekikMcpServer` / `MapMekikMcp` (`Mekik.AspNetCore`) |
| MCP tools wrap    | `withMcpTools` (`@mekik/langchain`) | `McpFunctions.Wrap` (`Mekik.Agents`)          |
| A2A agent         | `MekikA2aServer` / `serveA2a` (`@mekik/a2a`) | `MekikA2aServer` / `MapMekikA2a` (`Mekik.AspNetCore`) |

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

---

## 11. Client tools (§11)

§10 lets the server ship a widget to the client. §11 is the mirror image: the
**client declares what it can do** — render a card, open a picker, read the
device — as *tools*, described well enough for a server-side model to call. The
server exposes them to a node (or a model) exactly like server tools, and an
invocation either round-trips a result or fires and forgets. The frontend's own
UI becomes part of the agent's toolbox without a server deploy.

Everything here is **additive** within `mekik/1`: an older server ignores the
declarations, an older client never receives an invocation it did not declare.

### 11.1 Declaration

```ts
interface ClientToolDefinition {
  /** Unique per connection; a redeclared name replaces the earlier one. */
  name: string;
  /** What the tool does — this is what a model reads. */
  description?: string;
  /** JSON Schema for the tool's parameters (a model's input_schema). */
  parameters?: Record<string, unknown>;
  /** Server-side filter labels (§11.2). */
  tags?: string[];
  /** "call" (round-trip, default) or "notify" (fire-and-forget) — §11.3. */
  mode?: "call" | "notify";
}
```

Tools travel client → server two ways, both carrying the connection's **whole
set** (replace, never merge):

- `hello.tools` — declared at the handshake, like `componentsHash`;
- a `client_tools` frame `{type, tools}` — redeclared mid-session. `[]`
  withdraws everything. A `client_tools` whose `tools` is not an array draws
  `error{bad_request}`.

**Sanitization.** The server drops any entry that is not an object with a
non-empty string `name`, keeps only the known, correctly-typed fields
(`description` string, `parameters` object, `tags` non-empty strings, `mode`
one of the two literals), and dedupes by `name` — the last declaration of a
name wins.

**Opt-in.** Declarations are **ignored entirely by default** — the same posture
as `acceptClientMeta`, because a declaration is client-controlled input that a
model will read (names, descriptions and schemas are a prompt-injection
surface). `MekikOptions.clientTools` turns them on: `true` accepts every
well-formed declaration; a function is the allowlist form — it sees the
sanitized list and returns the subset to accept (pin names, strip tags, cap the
count). This is also the off switch: leave the option unset and the whole
feature is inert, wire and all.

**Declarations are per-connection state.** They are not persisted, not part of
the transcript, and vanish with the socket — a reconnecting client re-declares
in its next `hello`, exactly as it re-presents `componentsHash`.

### 11.2 The turn snapshot and tags

At run start the engine snapshots the union of every live connection's declared
tools into `meta.clientTools` (§6): deduped by `name`, ordered by first
appearance, the **most recent declaration of a name wins**. The snapshot is
taken once per turn, so a set that changes mid-run does not shift under the
node's feet; a `client_tools` frame takes effect on the next turn.

Nodes read the snapshot with `mekik.clientTools(ctx, {tags?, mode?})` /
`Shuttle.ClientTools`. The tag rule:

- a tool with **no tags is unrestricted** — every query returns it;
- a **tagged** tool is returned only by queries whose `tags` intersect its own;
- no `tags` filter ⇒ everything.

So a frontend tags the tools it wants scoped ("only the billing node should
call this") and leaves general-purpose ones untagged — one node sees a tool
another does not, without the server hard-coding either. The returned
definitions are ready to hand to a model as its tool list; `@mekik/langchain`'s
`withClientTools(ctx, {tags?})` does exactly that.

### 11.3 Invocation

`mekik.callClientTool(ctx, name, params?, {key?})` / `Shuttle.CallClientToolAsync`.
Both modes surface the call as an ordinary `tool_call` running →
completed/error trace (upsert by a replay-stable id), so the conversation shows
client-side work exactly like server-side work.

**`"call"` (default) — a durable round-trip.** The call is an ordinary ilmek
interrupt wearing tool metadata: the node parks, and the `interrupt` frame
(and, after a reconnect, `welcome.pending`) carries

```jsonc
{ "type": "interrupt", "seq": 12, "id": "call/0:tool:pick_date",
  "data": { "payload": {}, "tool": { "name": "pick_date", "params": { "min": "2026-08-01" } } } }
```

`data.tool` says this pause is answered by the client's tool handler, not by a
human — a client MUST NOT render default Approve/Cancel chips for it. The
client runs the handler and answers with a `resume` keyed by the interrupt id,
carrying the **result envelope**:

```jsonc
{ "type": "resume", "answers": { "call/0:tool:pick_date": { "ok": true,  "result": { "date": "2026-08-15" } } } }
{ "type": "resume", "answers": { "call/0:tool:pick_date": { "ok": false, "error": "user closed the picker" } } }
```

`{ok:true}` resolves the call with `result`; `{ok:false}` makes it **throw**
(the trace ends `error`) — the node, or the agent loop around it, decides what
the model sees. An answer that is not the envelope is taken as the bare result,
so a human answering the pause from another tab cannot wedge the run. Because
the pause is a real interrupt it inherits everything §4/§5 guarantee: the wait
survives a disconnect or restart, `welcome.pending` re-announces it (a
reconnecting client re-executes the still-open call — handlers should be
idempotent or cheap), concurrent pauses resume all-at-once, and the node
re-runs from the top on resume — journal pre-call side effects in `mekik.tool`.
The default journal key is `tool:{name}`.

**`"notify"` — fire and forget.** No pause: the invocation streams in the
turn's genui stream as an event chunk under the **reserved chunk name**
`client_tool`,

```jsonc
{ "type": "genui", "seq": 9, "streamId": "stream-1", "done": false,
  "chunk": { "type": "event", "name": "client_tool",
             "payload": { "name": "show_confetti", "params": { "level": 3 } }, "id": "task:tool:0" } }
```

and the call resolves immediately (with no result). The chunk's `id` is the
trace id, so a resume pass upserts instead of re-firing, and — being an
ordinary persistent chunk — a fresh tab replaying history sees it again: right
for "render this card", which is what notify is for. A client routes
`client_tool`-named event chunks to its tool registry, not to mounted
components; connectors should dedupe by chunk id within a session.

Calling a name that is not in the snapshot is not an error at call time (the
snapshot may lag a reconnect); the call takes the default `"call"` mode and
parks until some connection answers it.

### 11.4 Security model

- **A declaration is capability, not authority.** It changes what the server
  *may ask the client to do*, never what the server itself does. Authorization,
  balances, side effects stay server-side; a client tool result is client input
  and must be validated like any other.
- **Off by default, allowlist on.** §11.1's opt-in is the server's kill switch;
  the function form pins the accepted names so a manipulated client cannot
  smuggle extra tools or descriptions to the model.
- **Injection surface.** Tool names, descriptions and schemas reach the model's
  context. Treat them as untrusted: prefer the allowlist form, and never
  interpolate them into privileged instructions.
- **Client-side hardening.** A client library SHOULD keep its tool registry and
  handlers unreachable from page-level script (chativa's connector holds them
  in true-private fields, deep-clones the definitions at construction, and
  refuses runtime mutation unless explicitly enabled) so console access or an
  XSS cannot silently rewire what the model can trigger.

---

## 12. Skills (§12)

A **skill** is a folder with a `SKILL.md` — YAML frontmatter that names and
describes it, then markdown instructions — the Agent Skills format, read by
ilmek's `@ilmek/skills` / `Ilmek.Skills`. §12 is how a mekik app gives its
nodes a catalog of them, shows a client which one the agent is following, and
lets a frontend declare skills of its own. The organising idea is **progressive
disclosure**: a model sees every skill's name and description up front (level
1), reads one skill's instructions when a task matches (level 2), and opens a
bundled file only when the instructions point at it (level 3). Only what the
task needs enters the context.

Everything here is **additive** within `mekik/1`: an older client ignores the
`skills` catalog and the `skill` trace (unknown frame types are ignored), and
an older server ignores a client's declarations.

### 12.1 The shapes

```ts
/** Level 1 — what a model sees before choosing (the catalog frame, mekik.skills). */
interface SkillSummary {
  /** 1–64 lowercase letters, digits and single hyphens — the Agent Skills name rule. */
  name: string;
  /** What the skill does and when to use it — the whole trigger surface. */
  description: string;
  /** Server-side filter labels; the client-tool tag rule (§11.2). */
  tags?: string[];
  /** Stamped by the turn snapshot: "server" | "client". */
  source?: "server" | "client";
}

/** Level 2 — as a source hands it back. */
interface SkillEntry extends SkillSummary { instructions: string }

/** A client's inline declaration (§12.4). */
interface ClientSkillDefinition { name: string; description: string; instructions: string; tags?: string[] }

/** One skill use, as it travels on a `skill` frame (§12.5). */
interface SkillUse { id: string; name: string; status: "loaded" | "error"; source?: "server" | "client"; error?: string }
```

The server side reads skills through a **source** — `SkillSource` /
`ISkillSource`: `list()` (level 1, sorted by name), `get(name)` (level 2),
and an optional `readResource(name, path)` (level 3). `@ilmek/skills`'
`SkillCatalog` is one; a plain list of entries is wrapped into one; a database
or a remote registry can implement it. mekik never reads folders itself.

### 12.2 The server catalog and its handshake

`MekikOptions.skills` is the server's catalog. On connect, right after
`welcome` (and after `genui_components` when both exist), the server sends the
transient `skills` frame:

```jsonc
{ "type": "skills", "hash": "9f3a…", "skills": [
    { "name": "brand-voice", "description": "Write in the house voice.", "source": "server" },
    { "name": "pdf", "description": "Fill, merge and read PDF forms.", "tags": ["docs"], "source": "server" } ] }
```

Level 1 only — instructions never travel here. `hash` is `sha256` over the
canonical JSON of the summaries (`name`, `description`, `tags`; never
`source`) sorted by name, so both implementations mint the same hash for the
same catalog. A client that cached the catalog hands the hash back in
`hello.skillsHash`; a match draws `{type:"skills", hash, unchanged:true}` and
no list — the same handshake as `genui_components` (§10.2). No configured
skills ⇒ no frame at all. Client-declared skills are never echoed here: a
client already knows what it declared, and the catalog frame is about what the
*server* offers.

### 12.3 The turn snapshot, tags and origin

At run start the engine places one **skill source** at `meta.skills` (§6):
the server catalog merged with the client declarations the app accepted, taken
once per turn so a set that changes mid-run does not shift under the node's
feet. Every summary it lists is stamped with its `source`. A client skill whose
name collides with a server skill is **dropped** — the server's definition is
authoritative, and a client must not be able to rewrite what a server skill
tells the model.

Nodes read it with `mekik.skills(ctx, {tags?, source?})` / `Shuttle.Skills`.
The tag rule is §11.2's: an untagged skill is unrestricted and matches every
query; a tagged skill matches only when its tags intersect the query's. The
`source` filter narrows to one origin. `mekik.skillsPrompt(ctx, filter,
{intro?})` / `Shuttle.SkillsPrompt` renders the filtered list as the block a
system prompt carries — byte-identical to ilmek's own renderer:

```text
<intro sentence>

<available_skills>
  <skill>
    <name>pdf</name>
    <description>Fill, merge and read PDF forms.</description>
  </skill>
</available_skills>
```

`&`, `<` and `>` in a name or description are XML-escaped; an empty list
renders `""`. The default intro tells the model to load a skill by name before
acting on a matching task; `intro: null` renders the block alone.

### 12.4 Client-declared skills

A frontend may declare skills **inline** — it has no folder to serve, so the
whole skill travels in the declaration — in `hello.skills` or a
`client_skills` frame `{type, skills}`. Both carry the connection's **whole
set** (replace, never merge); `[]` withdraws everything; a `client_skills`
whose `skills` is not an array draws `error{bad_request}`.

**Sanitization.** The server keeps an entry only if `name` satisfies the name
rule, `description` is a non-empty string of at most 1024 characters (trimmed),
and `instructions` is a string; it keeps only the known fields (`tags` as
non-empty strings, deduped) and dedupes by name — the last declaration of a
name wins, keeping the position of its first appearance.

**Opt-in.** Declarations are **ignored entirely by default** — the same posture
as `clientTools` (§11.1) and `acceptClientMeta`, because a skill's description
and instructions are text a model will follow: a prompt-injection surface by
construction. `MekikOptions.clientSkills` turns them on: `true` accepts every
well-formed declaration; a function is the allowlist form — it sees the
sanitized list and returns the subset to accept (pin names, cap instruction
length, strip tags). Unset, the whole feature is inert, wire and all.

**Declarations are per-connection state**, like client tools: not persisted,
not in the transcript, gone with the socket; a reconnecting client re-declares
in its next `hello`. The turn snapshot (§12.3) is the union across the
conversation's live connections, ordered by first appearance, the most recent
declaration of a name winning.

### 12.5 Loading and the `skill` frame

`mekik.loadSkill(ctx, name)` / `Shuttle.LoadSkill` returns the entry
(instructions included) and emits a **persistent** `skill` frame, upsert by
`data.id`:

```jsonc
{ "type": "skill", "seq": 7, "data": { "id": "conv-1:ckpt-a:agent/0:skill:0", "name": "pdf", "status": "loaded", "source": "server" } }
```

An unknown name emits `{status:"error", error}` and **throws** — the node, or
the agent loop around it, decides what the model sees (the `@mekik/langchain`
and `Mekik.Agents` wrappers return an error observation and keep the loop
alive). A load is a catalog read, not a side effect, so it is **not journaled**;
the id is replay-stable (`taskId` + call order, exactly like a tool id), so a
resume pass re-emits the same id and the client upserts instead of duplicating.
Being persistent, the frame replays on reconnect: the transcript shows which
skills the agent followed.

`mekik.skillResource(ctx, name, path)` / `Shuttle.SkillResourceAsync` is level
3: the text of one bundled file, when the source has files behind it. Only
server skills can — client skills travel inline — and a folder-backed source
confines `path` to the skill folder (`..` and absolute paths are refused).
`skillResourcesAvailable(ctx)` / `Shuttle.SkillResourcesAvailable` says
whether the turn's source supports it, so an agent wrapper can offer the tool
only when it works.

### 12.6 Agent wrappers

`@mekik/langchain`: `withSkills(ctx, filter?)` returns a `load_skill` tool
(schema `{name}`) and, when resources are available, `read_skill_resource`
(`{name, path}`). `runAgent({ skills: true | filter })` appends the prompt
block to `system` and adds the tools. `Mekik.Agents`: `SkillFunctions.Wrap(ctx,
tags?, source?)` and `AgentRunOptions.Skills` / `SkillTags` / `SkillSource`.
Both refuse a name their filter hides, so the prompt and the tool agree on the
toolbox, and both return errors as observations. The skill tools are not
wrapped with the tool-policy machinery: a load emits its own trace.

### 12.7 Security model

- **Off by default for the client side, allowlist on.** §12.4's opt-in is the
  kill switch; the function form pins the accepted names and can cap sizes.
- **The server's catalog is the trusted one.** A client declaration can never
  shadow a server skill, and every summary says where it came from.
- **Injection surface.** Descriptions and instructions reach the model's
  context by design. Treat client-declared ones as untrusted: prefer the
  allowlist form, scope them by tag to the nodes that should see them, and
  never interpolate them into privileged instructions.
- **Level 3 is sandboxed.** A folder-backed source resolves resource paths
  inside the skill folder only.

---

## 13. MCP (§13)

mekik meets the Model Context Protocol in both directions. Neither adds a
frame to `mekik/1`: consuming an MCP server produces ordinary `tool_call`
traces (§6), and serving a graph as MCP tools is a second door into the same
engine, beside the WebSocket one.

### 13.1 Consuming — an MCP server's tools in a node

ilmek owns the connection: `@ilmek/mcp` / `Ilmek.Mcp` list a server's tools
once, expose them under a stable prefix (`<server>__<tool>`), normalize
results to `{text, structured?, isError, content}`, and journal every call
through `ctx.step` so a pause/resume never re-invokes a remote tool. mekik adds
the agent wrappers — `withMcpTools(ctx, toolbox, policy?)` in
`@mekik/langchain`, `McpFunctions.Wrap(ctx, tools, invoke, policies?)` in
`Mekik.Agents` — which route each exposed tool through the same machinery as a
server tool (§6, `withMekikTools` / `MekikTools.Wrap`):

- every call is a `tool_call` trace, running → completed/error, upsert by a
  replay-stable id;
- the invocation runs inside the wrapper's own `ctx.step` (key `lc:<name>`),
  so the toolbox's *raw* `invoke` is used — journaling twice would only add
  journal entries;
- the tool policy map applies by **exposed** name — `approve` gates a
  destructive remote tool behind an ordinary interrupt;
- the model's observation is the result's `text` (or its structured content,
  serialized, when there is no text); a result the server flagged `isError`
  reads `Error from <tool>: …` — an observation, never a thrown error.

With the official .NET SDK, its `McpClientTool`s are already `AIFunction`s and
go straight into `MekikTools.Wrap`.

### 13.2 Serving — a graph as MCP tools

`MekikMcpServer(app, {name, description?, serverInfo?, userId?, includeFrames?})`
exposes an app as **two tools**:

| tool | `inputSchema` (required) | effect |
| --- | --- | --- |
| `<name>` | `{message: string, conversationId?: string}` | one turn — the `text` frame of a fresh or existing conversation |
| `<name>__resume` | `{conversationId: string, answers: object}` | the `resume` frame of a paused conversation, `answers` keyed by interrupt id |

`name` MUST match `^[A-Za-z0-9_-]{1,64}$`. A call opens an in-process
connection as user `userId` (default `"mcp"`) with the given `conversationId`
(an unknown id starts a fresh conversation, per §1 adoption; the result reports
the id actually used), sends the frame, collects the turn's frames until the
engine returns, and disconnects. Conversations are ordinary: persisted, shared
with the WebSocket side, resumable from either door.

**The result** (MCP `CallToolResult`) is the pure reduction of the turn's frames
— `summarize` / `Summarize`, pinned identically in both suites:

```jsonc
{ "content": [{ "type": "text", "text": "<see below>" }],
  "structuredContent": {
    "conversationId": "conv-…",
    "status": "finished" | "interrupted" | "error" | "aborted" | "refused",
    "reply": "<bot text frames joined by newline; else the streamed text chunks; the error frame's text when refused>",
    "pending": [{ "id": "…", "payload": {…}, "actions"?: [...], "tool"?: "pick_date" }],
    "toolCalls": [{ "id": "…", "name": "get_order", "status": "completed" }],   // last status per id
    "skills": ["brand-voice"],                                                  // loaded skills
    "frames"?: [ ...persistent frames... ]                                      // includeFrames only
  },
  "isError"?: true }
```

`status` is the last `run` frame's status; `refused` when no run happened
because the engine answered with an `error` frame (`busy`, `interrupted`,
`not_interrupted`). `content[0].text` per status:

- `finished` — the reply, or `(no reply)`;
- `interrupted` — `The agent paused and needs input before it can continue:`,
  one line per pending interrupt (`- interrupt "<id>": <payload JSON> — options: <action values>`,
  or `a client tool call (<tool>) that only the conversation's own UI can answer`),
  then `Call <name>__resume with conversationId "<id>" and an answers object keyed by those ids.`;
- `error` — the run's error text; `isError: true`;
- `aborted` — `The run was aborted; the conversation can be continued.`;
- `refused` — `<code>: <message>` from the error frame; `isError: true`.

**JSON-RPC.** The server answers `initialize` (`protocolVersion` echoed when it
is one of `2025-06-18`, `2025-03-26`, `2024-11-05`, else the first;
`capabilities: {tools: {}}`; `serverInfo`), `ping` (`{}`), `tools/list`,
`tools/call`; a notification (no `id`) gets no response. Anything else is
`-32601`. A non-object or a message without `jsonrpc: "2.0"` and a `method` is
`-32600`; a `tools/call` without `name`, of an unknown tool, or with the wrong
argument shape is `-32602`; an unexpected failure is `-32603`. A failure
*inside the graph* is not an RPC error but a result with `isError` — the tool
ran, the agent failed. The exact exchanges are pinned by
`conformance/mcp/rpc.json`.

**Transport.** `@mekik/mcp`'s `serveMcp` and `Mekik.AspNetCore`'s
`MapMekikMcp` implement the stateless half of Streamable HTTP: one JSON-RPC
message per `POST` → `200` with the response, `202` for a notification, `400`
for unparseable JSON (`-32700`), `413` over 1 MiB; `GET` → `405` (no
server-to-client stream); `DELETE` → `200`. Sessions are not tracked — a
conversation is addressed by `conversationId` in the tool arguments.

### 13.3 Security model

- **The MCP endpoint carries no authorization of its own.** Put it behind a
  gateway (a bearer token the calling agent presents, an allowlisted network)
  like any internal tool endpoint. All MCP conversations belong to one mekik
  user (`userId`), so nothing an MCP caller does can reach a human user's
  conversation.
- **The graph's guardrails still apply.** An approval pauses the run and the
  caller gets `status: "interrupted"` — it cannot proceed until something
  answers, which is the point of the pause.
- **Consumed tools are untrusted input.** Names, descriptions and schemas of a
  remote server reach the model; results are client-ish input. Scope with
  `allow` at connect time and gate destructive tools with `approve`.

---

## 14. A2A (§14)

Where §13 makes a graph a *tool*, §14 makes it a *peer*: an Agent2Agent (A2A
0.3) agent with an Agent Card, addressed by messages, answering with tasks.
`MekikA2aServer(app, {name, description?, url, version?, skills?, userId?, tasks?})`
does the mapping over any JSON-RPC transport; `@mekik/a2a`'s `serveA2a` and
`Mekik.AspNetCore`'s `MapMekikA2a` put it behind HTTP. Calling A2A agents
*from* a graph is ilmek's job (`@ilmek/a2a` / `Ilmek.A2A`). Nothing here adds
a frame to `mekik/1`.

### 14.1 The Agent Card

Served at `/.well-known/agent-card.json`:

```jsonc
{ "protocolVersion": "0.3.0", "name", "description", "url", "preferredTransport": "JSONRPC", "version",
  "capabilities": { "streaming": false, "pushNotifications": false, "stateTransitionHistory": false },
  "defaultInputModes": ["text/plain"], "defaultOutputModes": ["text/plain"],
  "skills": [ { "id": "chat", "name": <name>, "description": <description>, "tags": ["chat"] },
              …one { id: name, name, description, tags } per SkillSummary in options.skills… ] }
```

`description` defaults to `The <name> agent, served by mekik.`; `version` to
`"0"`. The agent itself is always the first skill.

### 14.2 Turns as tasks

**One conversation is one `contextId`; one turn is one task.** `message/send`
takes `{message: {role, parts, messageId?, taskId?, contextId?}}` — `role` MUST
be `user` or `agent`, `parts` a non-empty list of text, data or file parts
(else `-32602`); a message with no text part is `-32005`.

- **No `taskId`** — a new task: connect as user `userId` (default `"a2a"`) on
  the conversation `contextId` names (fresh when absent or unknown; the task
  reports the id used), send a `text` frame with the text parts joined by
  newlines, collect the turn, disconnect (the `driveTurn` of §13.2).
- **`taskId` of an `input-required` task** — the resume (§14.3). A `taskId`
  that is unknown is `-32001`; one whose task is not `input-required` is
  `-32602` (`task "…" is completed and takes no more input`).

The task is built from the turn's summary (§13.2, `summarize`):

| turn status | `status.state` | `status.message` | artifacts |
| --- | --- | --- | --- |
| `finished` | `completed` | none | + `{artifactId, name: "reply", parts: [{kind: "text", text: reply}]}` when the reply is non-empty |
| `interrupted` | `input-required` | agent message: a text part describing each pending interrupt and how to answer, plus a data part `{pending: […]}` | unchanged |
| `error` | `failed` | agent message: the error text | unchanged |
| `refused` | `rejected` | agent message: the engine's `<code>: <message>` | unchanged |
| `aborted` | `canceled` | agent message: `The run was aborted; the conversation can be continued.` | unchanged |

Every task carries `kind: "task"`, `id`, `contextId` (the conversation),
`status.timestamp` (ISO 8601), `artifacts` (accumulated across the task's
turns), `history` (the user messages and agent status messages, in order, each
stamped with `taskId` and `contextId`), and `metadata.mekik = {conversationId,
status, toolCalls, skills}`; an `input-required` task also carries
`metadata.pending` — the §13.2 `pending[]` views.

### 14.3 Answering a pause

A message sent with the `taskId` of an `input-required` task becomes the
`resume` frame's `answers`:

- a data part carrying `answers` (an object keyed by interrupt id) is used
  as-is — the form for several open interrupts;
- otherwise exactly one interrupt must be open (else `-32602`: `the task has N
  open interrupts; answer them all with a data part {"answers": {<id>: <answer>}}`);
  a data part answers it with the part's `data`; else the text answers it — the
  **value** of the action whose `label` equals the text (its label when it has
  no value), or the text itself.

A pause that is a client tool call (§11.3) is listed with its `tool` and cannot
be answered from A2A. The continued task keeps its `id`, appends to `history`
and `artifacts`, and takes the new turn's state.

### 14.4 tasks/get, tasks/cancel, everything else

`tasks/get {id, historyLength?}` returns the task, its history truncated to the
last `historyLength` messages when given (`0` ⇒ none); unknown ⇒ `-32001`.
`tasks/cancel {id}` marks an `input-required` task `canceled` (a new
`status` with no message) and returns it; any other state is `-32002`. **The
conversation stays parked** — mekik never discards a pause on a caller's
behalf — so a later message on that context is `rejected` with the engine's
`interrupted` text until a mekik client answers it.

`message/stream` and `tasks/resubscribe` are `-32004` (`this agent does not
stream`); the `tasks/pushNotificationConfig/*` methods are `-32004` (`does not
push notifications`); a notification (no `id`) gets no response; anything else
is `-32601`. A non-object request, or one without `jsonrpc: "2.0"` and a
`method`, is `-32600`. The Agent Card and these exchanges are pinned by
`conformance/a2a/rpc.json`.

**Transport.** `GET` on the card path returns the card; `POST` on the endpoint
carries one JSON-RPC message → `200` with the response, `202` for a
notification, `400` for unparseable JSON (`-32700`), `413` over 1 MiB;
`GET` on the endpoint and `POST` on the card path are `405`.

### 14.5 Security model

As §13.3: the endpoint carries no authorization of its own and belongs behind a
gateway; all A2A conversations belong to one mekik user; the graph's approvals
still gate what a calling agent can make happen. Task stores are per-process
by default (`InMemoryA2aTaskStore`); a durable `A2aTaskStore` /
`IA2aTaskStore` is a two-method port.
