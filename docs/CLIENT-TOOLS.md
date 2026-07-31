# Client tools — the frontend as part of the toolbox

Server-defined components (PROTOCOL.md §10) let the server ship a widget to the
client. **Client tools** (PROTOCOL.md §11) are the mirror image: the frontend
declares the things *it* can do — render one of its own UI cards, open a native
picker, read the device — as **tools**, described well enough for a server-side
model to call. A node (or an LLM agent loop) then invokes them exactly like
server tools, and the result streams back into the run.

```
chativa widget                         mekik server
──────────────                         ────────────
tools: [{name:"pick_date", …}]  ──hello──▶  MekikOptions.clientTools (opt-in!)
                                            └─▶ ctx.meta.clientTools (per-turn snapshot)
                                            node: mekik.callClientTool(ctx, "pick_date", {…})
handler runs, returns result   ◀─interrupt(data.tool)─┘
        └──resume {ok:true, result}──▶  the await resolves; the run continues
```

Everything on this page has a runnable TS + .NET parity surface; the wire rules
are normative in [PROTOCOL.md §11](../PROTOCOL.md#11-client-tools-11).

## 1. Declaring tools (client side, chativa)

Pass `tools` to `@chativa/connector-mekik` — a definition plus a handler:

```ts
import { MekikConnector } from "@chativa/connector-mekik";

const connector = new MekikConnector({
    url: "wss://bot.example.com/ws",
    tools: [
        {
            name: "pick_date",
            description: "Open the in-app date picker and let the user choose a delivery date.",
            parameters: {
                type: "object",
                properties: { min: { type: "string", description: "Earliest selectable ISO date" } },
                required: ["min"],
            },
            handler: async (params) => {
                const date = await openDatePicker({ min: params?.min as string });
                return { date };                    // ← what the server's await resolves to
            },
        },
        {
            name: "show_confetti",
            description: "Celebrate on screen.",
            mode: "notify",                          // fire-and-forget: never blocks the run
            tags: ["fun"],
            handler: () => fireConfetti(),
        },
    ],
});
```

- The **definition** (`name`, `description`, `parameters`, `tags`, `mode`)
  travels in the `hello` handshake; the **handler never leaves the page**.
- A handler **throw** becomes the server-side call's error (`{ok:false}` on the
  wire) — the node's `await` throws with the message.
- Declarations are per-connection: the connector re-declares on every
  reconnect, and a still-open call re-announced in `welcome.pending` is
  retried — keep handlers idempotent or cheap.

### Security posture (why the registry is sealed)

Client tool declarations end up in a model's context, and their handlers are
what a server-side model can trigger in the page. The connector therefore
hardens the registry against page-level tampering (console access, injected
script):

- definitions and handlers live in **true-private (`#`) fields** — unreachable
  through the connector instance;
- definitions are **deep-cloned and frozen** at registration, so mutating the
  object you passed in changes nothing;
- the toolset is **sealed at construction**: `registerTool` / `unregisterTool`
  throw unless you opted in with `allowDynamicTools: true`.

```ts
const connector = new MekikConnector({ url, tools, allowDynamicTools: true });
connector.registerTool({ name: "route_scoped_tool", handler });   // re-announces via client_tools
connector.unregisterTool("route_scoped_tool");
```

And the deeper rule: **a declaration is capability, not authority**. It changes
what the server may *ask the client to do* — never what the server itself does.
Authorization, balances, and side effects stay server-side; a client tool
result is client input and must be validated like any other.

### Not using chativa? The raw wire

Any client that speaks `mekik/1` can declare and answer tools — a custom
JavaScript client, a .NET MAUI app, a test harness. Three frames cover the whole
contract (PROTOCOL.md §11):

```jsonc
// 1. declare (in the handshake; or replace later with a `client_tools` frame)
{ "type": "hello", "tools": [
    { "name": "pick_date", "description": "Open the date picker",
      "parameters": { "type": "object", "properties": { "min": { "type": "string" } } },
      "tags": ["scheduling"] } ] }

// 2. the server invokes → an interrupt carrying data.tool (also re-announced
//    in welcome.pending after a reconnect, so an open call is never lost)
{ "type": "interrupt", "seq": 7, "id": "schedule/0:tool:pick_date",
  "data": { "payload": {}, "tool": { "name": "pick_date", "params": { "min": "2026-08-10" } } } }

// 3. run the handler, answer with the result envelope
{ "type": "resume", "answers": {
    "schedule/0:tool:pick_date": { "ok": true, "result": { "date": "2026-08-15" } } } }
// …or, on failure:
{ "type": "resume", "answers": {
    "schedule/0:tool:pick_date": { "ok": false, "error": "user closed the picker" } } }
```

A `"notify"` invocation instead arrives inside the turn's genui stream, as an
event chunk under the reserved name `client_tool` — deliver it to your tool
layer, not to mounted components, and dedupe by chunk id:

```jsonc
{ "type": "genui", "seq": 9, "streamId": "stream-1", "done": false,
  "chunk": { "type": "event", "name": "client_tool",
             "payload": { "name": "celebrate", "params": { "level": 2 } }, "id": "task:tool:1" } }
```

## 2. Accepting tools (server side — off by default)

Declarations are **ignored entirely** unless the app opts in — the same
default-drop posture as `acceptClientMeta`, because names, descriptions and
schemas are a prompt-injection surface a model will read.

```ts
// accept everything well-formed
const app = mekik({ graph, clientTools: true });

// or the allowlist form: pin names, strip tags, cap the count
const app = mekik({
    graph,
    clientTools: (tools) => tools.filter((t) => ["pick_date", "show_confetti"].includes(t.name)),
});
```

```csharp
var app = new MekikApp(new MekikOptions { Graph = g, ClientTools = ClientTools.AcceptAll });
// or:
ClientTools = (tools, conv) => tools.Where(t => t.Name is "pick_date" or "show_confetti").ToList(),
```

Leaving the option unset is the kill switch: the whole feature is inert, wire
and all. The policy function also sees `{conversationId, userId}`, so acceptance
can differ per user.

## 3. Reading the toolbox in a node — and tags

At run start the engine snapshots the union of every live connection's declared
tools into `ctx.meta.clientTools`. Nodes read it with `mekik.clientTools`:

```ts
const all = mekik.clientTools(ctx);                        // everything declared
const billing = mekik.clientTools(ctx, { tags: ["billing"] });  // scoped
```

```csharp
var all = Shuttle.ClientTools(ctx);
var billing = Shuttle.ClientTools(ctx, tags: ["billing"]);
```

**The tag rule** — how one node sees a tool another does not:

- a tool with **no tags is unrestricted**: every query returns it;
- a **tagged** tool is returned only by queries whose tags intersect its own.

So the frontend tags the tools it wants scoped ("only the billing node should
offer this") and leaves general-purpose ones untagged. The server never
hard-codes either — but its `clientTools` policy may still strip or rewrite
tags it disagrees with.

The returned definitions carry `name` / `description` / `parameters`
(JSON Schema), ready to hand to a model as its tool list.

## 4. Calling a tool

### The round-trip (`mode: "call"`, the default)

```ts
.node("schedule", async (s, ctx) => {
    const when = await mekik.callClientTool<{ date: string }>(ctx, "pick_date", { min: s.earliest });
    return { reply: `Booked for ${when.date}.` };
})
```

```csharp
.Node("schedule", async (State state, IContext ctx) =>
{
    // Frames are dictionaries in .NET (docs/LANGUAGES.md, divergence 2), so the
    // params and the result travel as plain Dictionary<string, object?> — JSON
    // numbers parse as long, objects as dictionaries, arrays as List<object?>.
    var when = await Shuttle.CallClientToolAsync<IReadOnlyDictionary<string, object?>>(
        ctx, "pick_date", new Dictionary<string, object?> { ["min"] = state.Get<string>("earliest") });
    return Update.Of("reply", $"Booked for {when!["date"]}.");
})
```

This is a real ilmek pause wearing tool metadata, and it inherits everything a
pause guarantees:

- the `interrupt` frame carries `data.tool = {name, params}` (a client renders
  **no** Approve/Cancel chips for it — the tool handler answers);
- the wait **survives a disconnect or a restart**; `welcome.pending` re-announces
  the open call so a reconnecting client re-executes it;
- the answer is the result envelope `{ok:true, result}` / `{ok:false, error}` —
  `ok:false` makes the `await` **throw** (a plain `Error` in TS, an
  `InvalidOperationException` in .NET) carrying the client's `error` message; a
  bare non-envelope answer (say a human typed one from another tab) is taken as
  the result. Catch it in the node to recover, or let it end the run in
  `run{error}` — an agent loop built with `withClientTools` /
  `ClientToolFunctions` turns it into an observation instead (see §5);
- the node **re-runs from the top on resume** — wrap pre-call side effects in
  `mekik.tool` exactly as around any other pause (see
  [HITL.md](HITL.md#the-exactly-once-rule-the-whole-point));
- the call surfaces as an ordinary `tool_call` running → completed/error trace,
  so the conversation shows client-side work like any server tool.

### Fire-and-forget (`mode: "notify"`)

A notify tool never parks the run: the invocation streams as a genui event
chunk (reserved name `client_tool`) and the call resolves immediately.

```ts
await mekik.callClientTool(ctx, "show_confetti", { level: 3 });   // resolves with undefined
```

```csharp
await Shuttle.CallClientToolAsync<object?>(ctx, "show_confetti",
    new Dictionary<string, object?> { ["level"] = 3L });          // returns default (null)
```

Right for "render this card / celebrate / ping the UI" — a fresh tab replaying
history sees the chunk again and re-renders, which is what you want for UI. The
connector dedupes by chunk id within a session, so a resume replay does not
fire twice. Which mode a name uses is resolved from the **declaration** at call
time; a name missing from the snapshot (say the declaring tab just dropped)
defaults to `"call"` and parks until some connection answers it.

## 5. Handing the toolbox to a model

The definitions are already model-shaped. With `@mekik/langchain`:

```ts
import { withMekikTools, withClientTools, runAgent } from "@mekik/langchain";

.node("agent", async (s, ctx) => {
    const tools = [
        ...withMekikTools(ctx, serverTools, policy),   // the server's own tools
        ...withClientTools(ctx, { tags: ["billing"] }), // the frontend's, scoped by tag
    ];
    return { reply: await runAgent(ctx, model(), { system, input: s.input, tools }) };
})
```

`withClientTools` wraps each declared tool in a `DynamicStructuredTool` whose
executor is `callClientTool`: a call-mode tool parks the loop (durably — the
whole agent state is journaled), a notify tool returns a delivery note, and a
handler error comes back as an error **observation** so the loop stays alive.

.NET (`Mekik.Agents`, Microsoft.Extensions.AI) — `ClientToolFunctions.Wrap`
returns plain `AIFunction`s, so they drop into `Agent.RunAsync`, a raw
`IChatClient` call, or (via `KernelFunctionFactory`) a Semantic Kernel plugin
collection alongside your server functions:

```csharp
using Mekik.Agents;

.Node("agent", async (State state, IContext ctx) =>
{
    var tools = MekikTools.Wrap(ctx, serverFunctions, policies)       // the server's own functions
        .Concat(ClientToolFunctions.Wrap(ctx, tags: ["billing"]))     // the frontend's, scoped by tag
        .ToList();

    return Update.Of("reply", await Agent.RunAsync(ctx, chat, new AgentRunOptions
    {
        System = SYSTEM,
        Input  = state.Get<string>("input") ?? string.Empty,
        Tools  = tools,
    }));
})
```

Behaviour notes, both languages:

- a `"call"`-mode tool **parks the agent loop durably** — the loop's model
  decisions are journaled, so the resume replays them instead of re-invoking
  the model, and only the client tool's answer is new;
- a `"notify"` tool returns a delivery note (`"Delivered <name> to the
  client."`) the model can read and move on from;
- a failed handler (`{ok:false}`) becomes an error **observation**
  (`"Error from client tool <name>: …"`) rather than a crash — the loop stays
  alive and the model can route around it; the interrupt signal itself is
  always rethrown, never swallowed;
- the declared JSON Schema reaches the model verbatim (`AIFunction.JsonSchema`
  in .NET, the tool's `schema` in LangChain), so the call the model produces
  binds to the client's handler unchanged.

## 6. Dynamic toolsets

The client may replace its declared set mid-session with a `client_tools`
frame (`[]` withdraws everything) — in chativa, `registerTool`/`unregisterTool`
behind `allowDynamicTools: true`. Two rules keep this predictable:

- the frame **replaces** the connection's whole set (never merges);
- the change takes effect **on the next turn** — the engine snapshots the
  toolbox at run start, so a set changing mid-run does not shift under the
  node's feet.

With several tabs open, the snapshot is the union of every live connection's
declaration, deduped by name — the most recent declaration of a name wins.

## Runnable examples

The whole page is executable, in both languages, with the client's part
scripted so no browser is needed:

```bash
node ts/examples/client-tools.ts                        # self-test, exit 0/1
node ts/examples/client-tools.ts --serve                # ws://localhost:8807 for a real chativa client
dotnet run --project dotnet/examples/Mekik.ClientTools  # the same self-test, byte-identical frames
```

Both assert the same trace: the allowlist and tag scoping (the node sees
`pick_date` + the untagged `celebrate`, not the geo-tagged or refused tools),
the durable round-trip with `data.tool` and the result envelope, the notify
chunk, the error envelope ending the run in `run{error}`, and a journaled
lookup running exactly once across the pause. CI runs both offline.

## Reference

| | TypeScript | .NET |
| --- | --- | --- |
| accept (opt-in) | `MekikOptions.clientTools: true \| (tools, conv) => …` | `MekikOptions.ClientTools = ClientTools.AcceptAll` / a `ClientToolsPolicy` |
| read | `mekik.clientTools(ctx, {tags?, mode?})` | `Shuttle.ClientTools(ctx, tags?, mode?)` |
| call | `mekik.callClientTool(ctx, name, params?, {key?})` | `Shuttle.CallClientToolAsync<T>(ctx, name, params?, key?)` |
| model wrap | `withClientTools(ctx, filter?)` (`@mekik/langchain`) | `ClientToolFunctions.Wrap(ctx, tags?, mode?)` (`Mekik.Agents`) |
| definition | `ClientToolDefinition` | `ClientToolDefinition` |
| sanitize | `sanitizeClientTools(value)` | `ClientTools.Sanitize(value)` |
| reserved chunk name | `CLIENT_TOOL_EVENT` (`"client_tool"`) | `Protocol.ClientToolEvent` |

Wire spec: [PROTOCOL.md §11](../PROTOCOL.md#11-client-tools-11). Conformance:
the `client-tool-call` golden fixture plus scenario suites 17–20
([conformance/README.md](../conformance/README.md)).
