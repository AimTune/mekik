# mekik - Realtime layer over ilmek (Implementation Plan)

> Status: APPROVED & IMPLEMENTED. Planned with Fable, built with Opus.
> **Two decisions changed during the build** (see [README.md](README.md) for the
> as-built shape): (1) mekik lives in its **own standalone repo** (`mekik1/`),
> not inside ilmek's trees — §3 below is the earlier nested plan; the real layout
> is in the README, and mekik consumes ilmek from the sibling `mekik-elixir`
> repo. (2) TS tests use Node's built-in `node --test`, not vitest. The .NET HITL
> helper class is `Bot` (not `Mekik`) to avoid the namespace clash ilmek
> documents. Everything else below was built as planned.

## 1. What we are building

**mekik** is the realtime serving layer for **ilmek** graphs. It sits between the
chativa widget (client) and an ilmek `CompiledGraph` (server), and does three jobs:

1. **Realtime transport** - WebSocket sessions with identity (`userId` /
   `conversationId` / `connectionId`), watermark-based replay, multi-tab fan-out.
2. **GenUI** - stream `AIChunk`-shaped UI/text/event chunks emitted from graph
   nodes to the client, grouped into streams.
3. **Interactive HITL** - surface ilmek interrupts as first-class protocol frames
   (including form-driven GenUI approvals) and route answers back via
   `resumeKeyed`, addressed by thread-scoped interrupt `id`.

Both a **TypeScript** and a **.NET** implementation ship, speaking a **single,
byte-identical wire protocol** (`mekik/1`), verified by shared golden fixtures +
a language-neutral conformance scenario list (same pattern ilmek already uses).

The old `/Users/aimtune/Projects/opensource/botiva` repo (`botiva/1`, 4 languages,
generic Runtime port) is the predecessor; this project supersedes it. chativa's
`@chativa/connector-mekik` will be upgraded to `mekik/1` as a follow-up
workstream.

## 2. Why (lessons from botiva/1 - what this design fixes)

| botiva/1 pain point                                                                                                   | mekik/1 answer                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventToFrames` hand-mirrored "byte-for-byte" in 4 languages, no cross-language test                                  | 2 languages only; **golden wire fixtures** (recorded ilmek event sequence → expected frame sequence, canonical JSON) run by both test suites; language-neutral scenario doc in `conformance/mekik/`       |
| Fragile LangGraph interrupt detection (`isInterruptError()` sniffing error names/JSON, post-stream `getState()` pass) | ilmek is the native runtime: engine consumes the typed `IlmekEvent` stream; `interrupt` is a first-class event carrying `pending[]` with stable ids. No sniffing, no second pass                           |
| Single `pendingInterrupt` slot per conversation; concurrent pauses flattened to `pending[0]`                          | Protocol supports **N pending interrupts**; one `interrupt` frame each; resume frame answers by **thread-scoped `id`** (`resumeKeyed`) - never by `key` (ilmek §6.1 / conformance scenario 8)              |
| HITL rendered as `text` + `actions` chips; resume = "next user message" (ambiguous, can't do forms)                   | First-class `interrupt` / `resume` / `interrupt_resolved` frames; interrupt payload may embed a GenUI component (`ui: {component, props}`) → form-driven approvals; simple cases still get `actions` chips |
| Ambient `mekikEmit` via AsyncLocalStorage (needs per-language magic: contextvars, AsyncLocal, explicit ctx in Go)    | ilmek already passes `ctx` explicitly to every node; mekik ships helpers (`mekik.ui/text/tool`) that take `ctx` - no ambient machinery                                                                   |
| Examples escape the monorepo, no test framework on TS side                                                            | Everything self-contained in this repo; vitest (TS) + xunit-style (`dotnet test`) like ilmek already does                                                                                                  |
| Redis-parity gap, process-local turn lock                                                                             | v1 scope: in-memory stores behind ports (`HistoryStore`, `ConversationStore`); horizontal scale explicitly out of scope, documented                                                                        |

## 3. Repo layout (inside this repo)

Follow the existing ilmek convention - capability packages under the existing
`ts/` and `dotnet/` trees, conformance at top level:

```
mekik-elixir/
  MODEL.md                    # ilmek spec (unchanged)
  PROTOCOL.md                 # NEW - normative mekik/1 wire spec
  conformance/
    README.md                 # ilmek scenarios (unchanged)
    mekik/
      README.md               # mekik scenario list (language-neutral)
      fixtures/*.json         # golden event→frame fixtures (shared by both suites)
  ts/packages/
    core/                     # @ilmek/core (existing, untouched)
    checkpointers/…           # existing
    mekik/                   # NEW @mekik/core - engine, protocol types,
                              #   ilmek adapter, ports, in-memory stores, helpers
    mekik-ws/                # NEW @mekik/ws - WebSocket server transport (node `ws`)
  ts/examples/
    mekik-refund.ts          # NEW showcase server (see §7)
  dotnet/src/
    Ilmek.Core/               # existing, untouched
    Mekik.Core/              # NEW - mirror of @mekik/core
    Mekik.AspNetCore/        # NEW - `app.MapMekik("/ws", options)` transport
  dotnet/examples/
    Mekik.Examples/          # NEW refund showcase (same scenario as TS)
  dotnet/test/
    Mekik.Core.Tests/        # NEW conformance + fixtures
  ts/packages/mekik/test/    # NEW conformance + fixtures
```

Naming parity table (extends MODEL.md §11 conventions):

| Concept           | TypeScript                     | .NET                                        |
| ----------------- | ------------------------------ | ------------------------------------------- |
| app factory       | `mekik(options): MekikApp`   | `new MekikApp(MekikOptions)`              |
| serve             | `serveWs(app, {port, path})`   | `app.MapMekik(path, options)`              |
| engine            | `ConversationEngine`           | `ConversationEngine`                        |
| frame types       | `Frame` union, `parseIncoming` | `Frame` hierarchy, `Protocol.ParseIncoming` |
| event→frame map   | `eventToFrames(ev): Frame[]`   | `Protocol.EventToFrames(ev)`                |
| helpers           | `mekik.ui/text/tool/event`    | `Mekik.Ui/Text/Tool/Event` (static)        |
| history port      | `HistoryStore`                 | `IHistoryStore`                             |
| conversation port | `ConversationStore`            | `IConversationStore`                        |
| auth port         | `Authenticator`                | `IAuthenticator`                            |

## 4. The `mekik/1` wire protocol (draft - PROTOCOL.md will be normative)

JSON frames over WebSocket, `type` discriminator, flat envelope (botiva/1 style,
so chativa churn is minimal). Persistent frames carry a 1-based per-conversation
monotonic `seq`; on reconnect the server replays every frame with
`seq > watermark`. `PERSISTENT = ["text","tool_call","genui","interrupt","interrupt_resolved"]`.

**Identity model** (carried over from botiva/1 verbatim): `userId` (permanent) /
`conversationId` (= ilmek `threadId`) / `connectionId` (one socket) / `watermark`.
Anonymous connect allowed unless an `Authenticator` is configured; verified
`userId` overrides client-asserted; reject ⇒ `error{code:"unauthorized"}` +
WS close **4401**.

### Client → server

| Frame         | Shape                                                                 | Notes                                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`       | `{type:"hello", userId?, conversationId?, watermark?, token?, meta?}` | `meta` is NEW: client-supplied context, merged into graph run `ctx.meta.client` (server-side allowlist hook decides what passes)                                                         |
| `text`        | `{type:"text", data:{text}, meta?}`                                   | a user turn → starts a run (or is rejected `busy` if turn lock held)                                                                                                                     |
| `resume`      | `{type:"resume", answers: { [interruptId]: any }}`                    | NEW - maps directly to `resumeKeyed(g, answers, …)`; answering a subset is legal (still-pending ones remain)                                                                             |
| `genui_event` | `{type:"genui_event", streamId, eventType, payload}`                  | unchanged from botiva/1 (chativa already emits it). If the target component was bound to an interrupt (see below) and `eventType:"submit"`, the server treats it as `resume` for that id |
| `abort`       | `{type:"abort"}`                                                      | NEW - cancels the in-flight run via ilmek `AbortSignal`/`CancellationToken`; last checkpoint stands                                                                                      |

### Server → client

| Frame                | Shape                                                                                                                   | Persistent                       | Notes                                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --- | --------------------------------------------------------------------------------------- |
| `welcome`            | `{type:"welcome", data:{protocol:"mekik/1", conversationId, userId, connectionId, watermark, pending: PendingView[]}}` | no                               | `pending` is NEW: open interrupts re-announced on (re)connect so the UI can re-render approval forms                                                                                                    |
| `text`               | `{type:"text", id, seq, from:"bot"                                                                                      | "user", data:{text}, timestamp}` | yes                                                                                                                                                                                                     | complete messages; user frames replayed for multi-tab |
| `tool_call`          | `{type:"tool_call", seq, data:{id, name, status:"running"                                                               | "completed"                      | "error", params?, result?, error?}}`                                                                                                                                                                    | yes                                                   | upsert by `data.id` (chativa contract unchanged)                                                                  |
| `genui`              | `{type:"genui", seq, streamId, chunk: AIChunk, done}`                                                                   | yes                              | `AIChunk = {type:"ui",component,props,id?}                                                                                                                                                              | {type:"text",content,id?}                             | {type:"event",name,payload,id?}`- unchanged, chativa renders as-is; ilmek`emitToken`maps to`{type:"text"}` chunks |
| `interrupt`          | `{type:"interrupt", seq, id, data:{payload, ui?, actions?}}`                                                            | yes                              | NEW first-class frame. `id` = ilmek thread-scoped interrupt id. `ui: {component, props}` optionally mounts a GenUI form bound to this interrupt; `actions` gives chip fallback (default Approve/Cancel) |
| `interrupt_resolved` | `{type:"interrupt_resolved", seq, id, data:{answer?}}`                                                                  | yes                              | NEW - all tabs (and replay) learn the pause was answered; UI disables the form/chips                                                                                                                    |
| `run`                | `{type:"run", data:{status:"started"                                                                                    | "finished"                       | "interrupted"                                                                                                                                                                                           | "error"                                               | "aborted"}}`                                                                                                      | no  | superset of botiva/1 (chativa maps started/finished to typing; new states are additive) |
| `error`              | `{type:"error", data:{code, message}}`                                                                                  | no                               | auth reject, malformed frame, busy, etc.                                                                                                                                                                |

**Versioning:** `welcome.data.protocol = "mekik/1"`. Additive fields must be
ignored by receivers; major bump = breaking.

### ilmek event → frame mapping (the canonical table, tested by golden fixtures)

| `IlmekEvent`                                                | Frame(s)                                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `run_start`                                                 | `run{started}`                                                                                                               |
| `custom` with token payload (`{type:"token",text}`)         | `genui` chunk `{type:"text", content}` under the turn's stream                                                               |
| `custom` with mekik GenUI payload (emitted via helpers)    | `genui` chunk (ui/text/event)                                                                                                |
| `custom` with tool-trace payload (via `mekik.tool` helper) | `tool_call` upsert                                                                                                           |
| `custom` (anything else)                                    | dropped by default; extension hook may map it                                                                                |
| `interrupt` (`pending[]`)                                   | one `interrupt` frame **per pending entry** + `run{interrupted}`                                                             |
| `run_end{done}`                                             | final consolidated `text` frame (if the run produced a reply channel value) + `genui done:true` auto-close + `run{finished}` |
| `run_end{error}`                                            | `text` "⚠️ …" + `run{error}`                                                                                                 |
| `run_end{aborted}`                                          | `run{aborted}`                                                                                                               |
| `node_start/node_end/state/checkpoint/step_start`           | not mapped in v1 (debug mode later)                                                                                          |

Two seq spaces exist and must not be conflated: ilmek's per-run event `seq`
(internal) vs mekik's per-conversation persistent-frame `seq` (the watermark).

## 5. Core architecture

```
chativa ⇄ @chativa/connector-mekik ⇄ WS transport ⇄ ConversationEngine ⇄ IlmekAdapter ⇄ ilmek graph
                                        (mekik-ws /              │                        │
                                         Mekik.AspNetCore)       │ HistoryStore           │ Checkpointer
                                                                  │ ConversationStore      │ (ilmek's own,
                                                                  │ Authenticator          │  separate keyspace)
```

- **`ConversationEngine`** (per process): connection registry, hello/welcome
  handshake, watermark replay, per-conversation turn lock (`busy` notice),
  fan-out of persistent frames to all live connections of a conversation,
  frame parsing/validation.
- **`IlmekAdapter`**: given `MekikOptions.graph` + `checkpointer`, drives
  `stream(g, input, {threadId: conversationId, meta, signal})` /
  `resumeKeyedStream(...)`, maps events per the table above. `.NET caveat:` all
  internal try/catch in adapter and helpers must rethrow when
  `InterruptSignalException.IsInterrupt(ex)` (MODEL.md §11 divergence 2).
- **Graph context as a parameter** (explicit requirement):
  `MekikOptions.context?: (conv: ConversationInfo, turn: TurnInfo) => Record<string,unknown>`
  - evaluated per turn, placed into ilmek `RunOptions.meta.mekik`
    (+ allowlisted `hello.meta` under `meta.client`). Nodes read it via `ctx.meta`.
- **Helpers** (`@mekik/core` exports, ilmek-idiomatic - all take `ctx`):
  - `mekik.ui(ctx, component, props, opts?)` → emits GenUI ui chunk
  - `mekik.text(ctx, content)` → GenUI text chunk (streaming text)
  - `mekik.event(ctx, name, payload)` → GenUI event chunk
  - `mekik.tool(ctx, name, params, fn)` → wraps `ctx.step(name, fn)` AND emits
    `tool_call` running/completed/error traces (journaled step = exactly-once
    side effect; trace re-emitted on replay is idempotent via upsert-by-id)
  - `mekik.approve(ctx, payload, opts?)` → sugar over `ctx.interrupt` that
    attaches `ui`/`actions` metadata to the interrupt payload under a reserved
    `$mekik` key, so `eventToFrames` can build the `interrupt` frame's
    `ui`/`actions` without a second channel.
- **GenUI stream grouping** (carried from botiva/1): one auto `streamId` per
  turn, incrementing chunk `id`, auto-close with `done:true` at run end.
- **Ports with in-memory defaults**: `HistoryStore` (append→seq, after(watermark)),
  `ConversationStore` (owner, createdAt, meta), `Authenticator` (token→verdict).
  ilmek checkpoints are NOT mekik state - separate keyspaces (MODEL.md §7 note).

## 6. Conformance & parity strategy (the ".NET ve TS aynı protokol" guarantee)

1. **`PROTOCOL.md` is normative** - like MODEL.md is for ilmek.
2. **Golden fixtures** in `conformance/mekik/fixtures/`: each fixture =
   `{name, events: IlmekEvent[], expectedFrames: Frame[]}` in canonical JSON
   (sorted keys, no insignificant whitespace). Both languages run
   `eventToFrames` over `events` and must produce `expectedFrames` byte-identically
   (after canonicalization). Fixtures are hand-reviewed, generated once by the
   TS reference, committed.
3. **Scenario list** `conformance/mekik/README.md` - language-neutral, mirrored
   as vitest + dotnet test suites:
   1. hello/welcome handshake - anonymous id minting, client-asserted ids adopted
   2. watermark replay - reconnect with watermark N receives exactly frames seq>N
   3. multi-tab fan-out - two connections, same conversation, both see all persistent frames; sender's user frame not echoed to itself
   4. genui stream grouping + auto-close at run end
   5. tool_call lifecycle via `mekik.tool` (running→completed; error path)
   6. single approval - interrupt frame, `resume` by id, `interrupt_resolved`, run continues
   7. **concurrent interrupts** - two pending, answers routed by id (never collapses; ilmek conformance scenario 8 surfaced through the wire)
   8. reconnect while interrupted - `welcome.pending` re-announces open interrupts
   9. genui-form-bound interrupt - `genui_event{submit}` resolves the interrupt
   10. abort - `abort` frame ends run `aborted`, checkpoint stands, thread resumable
   11. turn lock - second concurrent `text` gets `busy` error, no second run
   12. auth - bad token ⇒ `error{unauthorized}` + close 4401; verified userId overrides asserted
4. **Cross-language smoke** (stretch): TS test client driving the .NET example
   server and vice versa, replaying scenario 6 end-to-end.

## 7. Showcase example - "refund approval" (both languages, same scenario)

Graph: `START → lookup → decide → (approve?) → refund → END`, demonstrating
GenUI card, streaming tokens, tool traces, and a form-driven approval.

TypeScript (`ts/examples/mekik-refund.ts`):

```ts
import { graph, channel, command, START, END } from "@ilmek/core";
import { mekik, serveWs } from "@mekik/core"; // + @mekik/ws
import { SqliteCheckpointer } from "@ilmek/checkpoint-sqlite";

const refund = graph("refund")
  .channel("input", channel.lastWrite<string>())
  .channel("order", channel.lastWrite<Order>())
  .channel("reply", channel.lastWrite<string>())
  .node("lookup", async (s, ctx) => {
    const order = await mekik.tool(
      ctx,
      "get_order",
      { id: parseOrderId(s.input) },
      () => orders.get(parseOrderId(s.input)),
    );
    mekik.ui(ctx, "order-card", {
      id: order.id,
      total: order.total,
      items: order.items,
    });
    return { order };
  })
  .node("approve", async (s, ctx) => {
    // pauses the graph; answer arrives over the wire as a `resume` frame
    const answer = await mekik.approve<{ approved: boolean; note?: string }>(
      ctx,
      {
        title: `Refund $${s.order.total} for ${s.order.id}?`,
        ui: {
          component: "approval-form",
          props: { orderId: s.order.id, amount: s.order.total },
        },
        actions: [
          { label: "Onayla", value: { approved: true } },
          { label: "Reddet", value: { approved: false } },
        ],
      },
    );
    return answer.approved
      ? command({ goto: "refund" })
      : command({ update: { reply: "Refund declined." }, goto: END });
  })
  .node("refund", async (s, ctx) => {
    await mekik.tool(ctx, "refund_payment", { orderId: s.order.id }, () =>
      payments.refund(s.order.id),
    ); // journaled - exactly-once
    ctx.emitToken("Refund processed ✅"); // streams to the widget
    return { reply: `Refund complete: ${s.order.id}` };
  })
  .edge(START, "lookup")
  .edge("lookup", "approve")
  .edge("refund", END)
  .compile();

const app = mekik({
  graph: refund,
  checkpointer: new SqliteCheckpointer("refund.db"),
  input: (msg) => ({ input: msg.text }), // text frame → graph input
  reply: (state) => state.reply, // channel → final text frame
  context: (conv) => ({ userId: conv.userId, locale: "en" }), // → ctx.meta.mekik
});
serveWs(app, { port: 8800, path: "/ws" });
```

.NET (`dotnet/examples/Mekik.Examples`):

```csharp
var refund = Graph.Create("refund")
  .Channel("input", Channels.LastWrite<string>())
  .Channel("order", Channels.LastWrite<Order>())
  .Channel("reply", Channels.LastWrite<string>())
  .Node("lookup", async (s, ctx) => {
      var order = await Mekik.Tool(ctx, "get_order", new { id }, () => Orders.Get(id));
      Mekik.Ui(ctx, "order-card", new { order.Id, order.Total, order.Items });
      return new { order };
  })
  .Node("approve", async (s, ctx) => {
      var answer = await Mekik.Approve<Approval>(ctx, new ApprovePayload {
          Title = $"Refund ${s.Get<Order>("order").Total}?",
          Ui = new UiRef("approval-form", new { orderId, amount }),
      });
      return answer.Approved ? Command.Goto_("refund")
                             : Command.Create(update: new { reply = "Refund declined." }, gotoNode: Graph.End);
  })
  .Node("refund", async (s, ctx) => { /* Mekik.Tool + ctx.EmitToken, mirror of TS */ })
  .Edge(Graph.Start, "lookup").Edge("lookup", "approve").Edge("refund", Graph.End)
  .Compile();

app.MapMekik("/ws", new MekikOptions {
    Graph = refund,
    Checkpointer = new SqliteCheckpointer("refund.db"),
    Input = msg => new { input = msg.Text },
    Reply = state => state.Get<string>("reply"),
    Context = (conv, turn) => new { userId = conv.UserId, locale = "tr" },
});
```

Wire trace for the approval turn (what chativa sees):

```jsonc
→ {"type":"text","data":{"text":"I want to refund order ORD-42"}}
← {"type":"run","data":{"status":"started"}}
← {"type":"tool_call","seq":7,"data":{"id":"t1","name":"get_order","status":"running","params":{"id":"ORD-42"}}}
← {"type":"tool_call","seq":8,"data":{"id":"t1","status":"completed","result":{...}}}
← {"type":"genui","seq":9,"streamId":"s3","done":false,"chunk":{"type":"ui","component":"order-card","props":{...},"id":1}}
← {"type":"interrupt","seq":10,"id":"approve/0:interrupt#0","data":{
      "payload":{"title":"Refund $249.90"},
      "ui":{"component":"approval-form","props":{"orderId":"ORD-42","amount":249.9}},
      "actions":[{"label":"Onayla","value":{"approved":true}},{"label":"Reddet","value":{"approved":false}}]}}
← {"type":"run","data":{"status":"interrupted"}}
// user submits the form (or taps a chip):
→ {"type":"resume","answers":{"approve/0:interrupt#0":{"approved":true,"note":"ok"}}}
← {"type":"run","data":{"status":"started"}}
← {"type":"interrupt_resolved","seq":11,"id":"approve/0:interrupt#0","data":{"answer":{"approved":true}}}
← {"type":"tool_call","seq":12,"data":{"id":"t2","name":"refund_payment","status":"running"}}
← {"type":"tool_call","seq":13,"data":{"id":"t2","status":"completed"}}
← {"type":"genui","seq":14,"streamId":"s4","done":false,"chunk":{"type":"text","content":"Refund processed ✅","id":1}}
← {"type":"genui","seq":15,"streamId":"s4","done":true,"chunk":{"type":"event","name":"stream_done","id":2}}
← {"type":"text","seq":16,"from":"bot","data":{"text":"Refund complete: ORD-42"}}
← {"type":"run","data":{"status":"finished"}}
```

## 8. chativa workstream (follow-up, separate repo)

`@chativa/connector-mekik` v2:

- Handle `interrupt` frame → render `ui` component via `GenUIRegistry` (bound to
  interrupt id) or fall back to quick-reply chips from `actions`.
- Handle `interrupt_resolved` → disable/mark the form or chips (multi-tab safe).
- Send `resume` frames (chip tap → `{answers:{[id]: action.value}}`; form submit
  routed via existing `receiveComponentEvent` + interrupt binding).
- Handle `run{interrupted|aborted|error}` additions (typing off).
- Handle `welcome.data.pending` re-announcement on reconnect.
- Everything else (text/tool_call/genui/watermark/auth) is unchanged.

## 9. Milestones (for the Opus implementation session)

1. **M1 - Spec first**: `PROTOCOL.md` (normative mekik/1), `conformance/mekik/README.md`
   scenario list, initial golden fixtures (hand-authored for mapping table).
2. **M2 - TS reference**: `@mekik/core` (protocol types, `eventToFrames`,
   `ConversationEngine`, `IlmekAdapter`, helpers, in-memory stores) +
   `@mekik/ws` + vitest conformance suite green + fixture parity.
3. **M3 - TS example**: `mekik-refund.ts` + scripted smoke client (no LLM key
   needed - deterministic graph), exercising scenarios 1–12 end-to-end.
4. **M4 - .NET mirror**: `Mekik.Core` + `Mekik.AspNetCore` + dotnet test
   conformance suite green against the SAME fixtures; refund example.
5. **M5 - chativa connector v2** (in chativa repo) + cross-repo manual E2E with
   the widget.
6. **M6 - docs**: README section, LANGUAGES-style parity table, HITL authoring
   guide (interrupt-id rule, .NET rethrow rule, side-effects-after-pause rule).

## 10. Explicit non-goals (v1)

- Horizontal scaling / distributed turn lock / pub-sub fan-out (documented, out).
- Transports other than WebSocket (SSE/Socket.IO/SignalR later; protocol stays transport-agnostic on paper).
- Redis/Postgres history stores (ports exist; in-memory only in v1).
- Debug stream mode (node_start/state/checkpoint frames), subgraph `ns` surfacing.
- Go/Python ports.

## 11. Key decisions made (flag if you disagree)

1. **Layout**: mekik lives inside the existing `ts/`+`dotnet/` trees of this repo (not a nested standalone monorepo) so one conformance culture covers ilmek + mekik.
2. **Protocol name/version**: `mekik/1` - evolution of botiva/1, breaking (first-class interrupt frames), frame names kept compatible where chativa already depends on them.
3. **ilmek-native, no generic Runtime port**: the adapter consumes `IlmekEvent` directly; the frame vocabulary stays runtime-agnostic so a port could return later.
4. **Interrupt = first-class frame + resume-by-id** (multiple pending supported) instead of botiva/1's text+actions+next-message convention.
5. **Tokens travel as GenUI text chunks** (chativa already streams these); a consolidated persistent `text` frame is emitted from a designated reply channel at run end.
6. **Golden fixtures + scenario doc** are the parity mechanism (not a shared harness), mirroring ilmek's proven approach.
