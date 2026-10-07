---
sidebar_position: 1
title: Authoring helpers
description: The node-authoring helpers — text, ui, mount, event, message, tool, approve, choose — that emit generative UI, rich messages, tool traces, and human-in-the-loop pauses from inside an ilmek node, in TypeScript and .NET.
---

# Authoring helpers

Inside an ilmek node you shape the conversation with a handful of helpers. They're the entire authoring surface — everything a turn can produce on the wire comes from one of them. Each takes ilmek's context (no ambient storage; ilmek already threads it through every node) and emits a `custom` event the [mapper](../protocol/event-mapping.md) turns into a frame.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
import { mekik } from "@mekik/core";

// one node of a compiled ilmek graph
.node("desk", async (state, ctx) => {
  const id = state.input as string;
  const order = await mekik.tool(ctx, "get_order", { id }, () => Orders.get(id)); // journaled tool
  mekik.text(ctx, "Looking that up… ");                                           // streamed prose
  mekik.ui(ctx, "order-card", { id: order.id, total: order.total });              // mount a component
  const ok = await mekik.approve<{ approved: boolean }>(                          // pause for a human
    ctx,
    { title: `Refund ${order.total}?` },
    { ui: { component: "approval-form", props: { orderId: order.id } } },
  );
  return { reply: ok.approved ? "done" : "cancelled" };
})
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
using Mekik;
using Ilmek;

// one node of a compiled ilmek graph
.Node("desk", async (State state, IContext ctx) =>
{
    var id = state.Get<string>("input");
    var order = (Order)(await Shuttle.Tool(ctx, "get_order",                       // journaled tool
        new Dictionary<string, object?> { ["id"] = id },
        () => (object?)Orders.Get(id)))!;
    Shuttle.Text(ctx, "Looking that up… ");                                        // streamed prose
    Shuttle.Ui(ctx, "order-card",                                                  // mount a component
        new Dictionary<string, object?> { ["id"] = order.Id, ["total"] = order.Total });
    var ok = await Shuttle.Approve<Dictionary<string, object?>>(                   // pause for a human
        ctx,
        new Dictionary<string, object?> { ["title"] = $"Refund {order.Total}?" },
        ui: new Dictionary<string, object?>
        {
            ["component"] = "approval-form",
            ["props"] = new Dictionary<string, object?> { ["orderId"] = order.Id },
        });
    return Update.Of("reply", ok.GetValueOrDefault("approved") is true ? "done" : "cancelled");
})
```

</TabItem>
</Tabs>

## The one name, two ways

In TypeScript the single `mekik` export is both the **app factory** and the **helpers** — `index.ts` folds the helper functions onto the callable factory, so both read naturally. In .NET they split: the app is `MekikApp`, and the helpers live on a static `Shuttle` class (a static class named `Mekik` would clash with the namespace — see [Parity](../parity/languages.md#the-five-deliberate-divergences)).

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
import { mekik } from "@mekik/core";

const app = mekik({ graph }); // app factory — called once, at the top level
mekik.ui(ctx, "card", {});    // helper — called inside a node

// helpers are also available as named imports:
import { ui, tool, approve } from "@mekik/core";
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
using Mekik;

var app = new MekikApp(new MekikOptions { Graph = graph }); // app — constructed once
Shuttle.Ui(ctx, "card", new Dictionary<string, object?>()); // helper — called inside a node
```

</TabItem>
</Tabs>

## The helpers

| TypeScript | .NET | Emits | Awaits? | Guide |
|---|---|---|---|---|
| `mekik.text(ctx, content)` | `Shuttle.Text(ctx, content)` | a `genui` **text** chunk | no | [Generative UI](./generative-ui.md) |
| `mekik.streamText(ctx, deltas, select?)` | `Shuttle.StreamText(ctx, deltas, …)` | one `genui` **text** chunk per delta | **yes** — returns the joined text | [Generative UI](./generative-ui.md#a-streaming-reply-end-to-end) |
| `mekik.ui(ctx, component, props?)` | `Shuttle.Ui(ctx, component, props?)` | a `genui` **ui** chunk | no | [Generative UI](./generative-ui.md) |
| `mekik.event(ctx, name, payload?)` | `Shuttle.Event(ctx, name, payload?)` | a `genui` **event** chunk | no | [Generative UI](./generative-ui.md) |
| `mekik.mount(ctx, component, props?)` | `Shuttle.Mount(ctx, component, props?)` | a `genui` **ui** chunk + an update handle | no | [Typed components](./components.md#chunk-ids-updating-in-place) |
| `mekik.message(ctx, type, data)` | `Shuttle.Message(ctx, type, data)` | a persistent **rich message** frame | no | [Rich messages](./messages.md) |
| `mekik.tool(ctx, name, params, fn)` | `Shuttle.Tool(ctx, name, params, fn)` | a `tool_call` trace + runs `fn` once | **yes** — returns the result | [Tools](./tools.md) |
| `mekik.approve(ctx, payload, opts?)` | `Shuttle.Approve(ctx, payload, …)` | an `interrupt` frame; the run pauses | **yes** — returns the answer | [Human-in-the-loop](./human-in-the-loop.md) |
| `mekik.choose(ctx, payload, options)` | `Shuttle.Choose<T>(ctx, payload, options)` | an `interrupt` frame whose `actions` are the options | **yes** — returns the pick | [HITL → Buttons](./human-in-the-loop.md#buttons-typed-no-hand-written-json) |
| `mekik.action(label, value?)` | `Shuttle.Action(label, value?)` | nothing — builds one chip (`MessageAction`) for `choose` / `approve` | no | [HITL → Buttons](./human-in-the-loop.md#buttons-typed-no-hand-written-json) |
| `mekik.onEvent(ctx, eventType, opts?)` | `Shuttle.OnEvent<T>(ctx, eventType, …)` | an `interrupt` frame carrying `data.event`; the run pauses until a mounted component fires that event | **yes** — returns the event's payload | [Generative UI → `component-event`](./generative-ui.md#component-event--a-node-waiting-on-its-own-widget) |
| `mekik.clientTools(ctx, filter?)` | `Shuttle.ClientTools(ctx, tags?, mode?)` | nothing — reads the turn's client tool snapshot | no — returns the definitions | [Client tools](./client-tools.md) |
| `mekik.callClientTool(ctx, name, params?)` | `Shuttle.CallClientToolAsync<T>(ctx, name, params?)` | a `tool_call` trace + an `interrupt` (or a notify chunk) | **yes** — returns the client's result | [Client tools](./client-tools.md#calling) |
| `mekik.skills(ctx, filter?)` / `mekik.skillsPrompt(ctx, filter?)` | `Shuttle.Skills(ctx, tags?, source?)` / `Shuttle.SkillsPrompt(…)` | nothing — reads the turn's skill catalog (level 1) | no | [Skills](./skills.md) |
| `mekik.skillTools(ctx, filter?)` | `Shuttle.SkillTools<TTool>(ctx, tags?, source?)` | nothing — the tools each visible server skill owns (`SkillEntry.tools`), keyed by skill name | no | [Skills](./skills.md#tools-under-a-skill) |
| `mekik.loadSkill(ctx, name)` | `Shuttle.LoadSkill(ctx, name)` | a `skill` trace; returns the instructions (level 2) | no | [Skills](./skills.md#loading-a-skill--and-the-skill-frame) |
| `mekik.skillResource(ctx, name, path)` | `Shuttle.SkillResourceAsync(ctx, name, path)` | nothing — reads one bundled file (level 3) | **yes** — returns the file text | [Skills](./skills.md#loading-a-skill--and-the-skill-frame) |
| `mekik.authClaims(ctx)` / `mekik.claimStrings(claims, key)` | `Shuttle.AuthClaims(ctx)` / `Shuttle.ClaimStrings(claims, key)` | nothing — reads the turn's verified auth claims (`{}` when anonymous) | no | [Reading per-conversation context](#reading-per-conversation-context) |

`skillResourcesAvailable(ctx)` / `Shuttle.SkillResourcesAvailable(ctx)` reports whether the turn's skill source can serve level-3 files at all; in TypeScript it is a named export only, not attached to `mekik`.

`text`, `ui`, `event` and `message` are fire-and-forget: they emit and return. `streamText` is the token-by-token convenience — it drives an async delta source through `text` and returns the joined string (while streaming, the streamed bubble is the durable message — don't also return it as the reply; see [Generative UI](./generative-ui.md#stream-the-answer-or-return-it--not-both)). `tool`, `approve`, `choose`, `onEvent` and `callClientTool` `await` because they wrap ilmek machinery (`ctx.step` / `ctx.StepAsync` for `tool`, `ctx.interrupt` / `ctx.InterruptAsync` for the others).

On top of these sit the **typed catalogs**, which bind a component or message name once so the payload is compiler-checked: `mekik.component` / `mekik.genui` for [components](./components.md), `mekik.messageKind` / `mekik.messages` for [messages](./messages.md), and `mekik.action` for chips. They add nothing to the wire — same frames, fewer hand-written object literals.

Each message type also has a **describe** form — `messages.card.spec(data)` / `Messages.CardSpec(…)` — returning the message as a value instead of emitting it, for the places that send one without a `ctx`. That's how the [greeting](../getting-started.md#step-4--configure-the-app) carries a card or buttons rather than only a paragraph.

### text / ui / event

Stream a chunk of generative UI. `text` streams prose deltas; `ui` mounts or updates a registered component by name; `event` dispatches a named event to a mounted component:

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.text(ctx, "Analyzing your order… ");
mekik.ui(ctx, "data-table", { rows, columns });
mekik.event(ctx, "highlight", { rowId: 3 });
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
Shuttle.Text(ctx, "Analyzing your order… ");
Shuttle.Ui(ctx, "data-table", new Dictionary<string, object?> { ["rows"] = rows, ["columns"] = columns });
Shuttle.Event(ctx, "highlight", new Dictionary<string, object?> { ["rowId"] = 3 });
```

</TabItem>
</Tabs>

All three carry the same `AIChunk` shape chativa renders. Chunks under one turn share a `streamId`; the mapper assigns each chunk an `id` (consecutive `text` deltas share one, so they grow a single bubble) and closes the stream when the run finishes. Details and the component contract: [Generative UI](./generative-ui.md).

### tool

Run a side effect exactly once and surface it as a `tool_call` trace:

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
const order = await mekik.tool(ctx, "get_order", { id }, () => Orders.get(id));
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
var order = (Order)(await Shuttle.Tool(ctx, "get_order",
    new Dictionary<string, object?> { ["id"] = id },
    () => (object?)Orders.Get(id)))!;
```

</TabItem>
</Tabs>

It emits `tool_call{running}`, runs `fn` inside ilmek's `ctx.step` (which journals the result), then emits `tool_call{completed, result}` — or `tool_call{error}` if `fn` throws, and rethrows the error, so the node fails unless you catch it. (Inside an agent loop — `runAgent` / `Agent.RunAsync` — a throwing tool becomes an `Error from <tool>: …` observation the model reads instead.) An interrupt thrown by `fn` is rethrown untouched: a pause is not a failure. The journaling is the point: on a resume pass the node re-runs, but `fn` returns its recorded value instead of executing again. This is what stops a refund from charging twice. Full story: [Tools](./tools.md).

### approve

Pause the run for a human and resume with their answer:

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
const ok = await mekik.approve<{ approved: boolean }>(
  ctx,
  { title: "Deploy to production?" },
  {
    ui: { component: "approval-form", props: { env: "prod" } }, // a rich form…
    actions: [                                                  // …or chip fallback
      { label: "Approve", value: { approved: true } },
      { label: "Cancel",  value: { approved: false } },
    ],
  },
);
if (ok.approved) await deploy();
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
var ok = await Shuttle.Approve<Dictionary<string, object?>>(
    ctx,
    new Dictionary<string, object?> { ["title"] = "Deploy to production?" },
    ui: new Dictionary<string, object?>                            // a rich form…
    {
        ["component"] = "approval-form",
        ["props"] = new Dictionary<string, object?> { ["env"] = "prod" },
    },
    actions: new List<object>                                      // …or chip fallback
    {
        new Dictionary<string, object?> { ["label"] = "Approve", ["value"] = new Dictionary<string, object?> { ["approved"] = true } },
        new Dictionary<string, object?> { ["label"] = "Cancel",  ["value"] = new Dictionary<string, object?> { ["approved"] = false } },
    });
if (ok.GetValueOrDefault("approved") is true) await Deploy();
```

</TabItem>
</Tabs>

The node **suspends** at that `await` on the first pass — it never returns. The engine emits an `interrupt` frame and ends the run `interrupted`. When the client answers, the graph re-runs the node from the top and the `await` returns the answer. The authoring contract — and why anything before the `await` must be journaled — is [Human-in-the-loop](./human-in-the-loop.md).

The presentation/journaling options — a form via `ui`, chips via `actions`, a `key` when a node pauses more than once — read like this (omit both `ui` and `actions` for default Approve/Cancel chips):

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
interface ApproveOptions {
  ui?: UiRef;                // mount a form instead of relying on chips
  actions?: MessageAction[]; // chips; omit both for default Approve/Cancel
  key?: string;              // journal key, when a node pauses more than once
}
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
ValueTask<T> Approve<T>(
    IContext ctx,
    IReadOnlyDictionary<string, object?> payload,
    IReadOnlyDictionary<string, object?>? ui = null,      // mount a form instead of chips
    IReadOnlyList<object>? actions = null,                // omit both for default Approve/Cancel
    string key = "interrupt");                            // journal key, when a node pauses more than once
```

</TabItem>
</Tabs>

## Low-level trace primitives

For integrations that execute tools themselves (a LangChain or Semantic Kernel agent calling its own functions), mekik exports the primitives behind `tool` so the same trace can be produced without re-deriving the reserved payload shape:

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
import { nextToolCallId, toolTrace } from "@mekik/core";

const id = nextToolCallId(ctx);
toolTrace(ctx, { id, name: "search", status: "running", params });
const result = await runTheToolYourself(params);
toolTrace(ctx, { id, name: "search", status: "completed", result });
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
var id = Shuttle.NextToolCallId(ctx);
Shuttle.ToolTrace(ctx, new Dictionary<string, object?> { ["id"] = id, ["name"] = "search", ["status"] = "running", ["params"] = @params });
var result = await RunTheToolYourself(@params);
Shuttle.ToolTrace(ctx, new Dictionary<string, object?> { ["id"] = id, ["name"] = "search", ["status"] = "completed", ["result"] = result });
```

</TabItem>
</Tabs>

`toolTrace` / `Shuttle.ToolTrace` emits one `tool_call` frame (upsert by `id`); `nextToolCallId` / `Shuttle.NextToolCallId` mints a replay-stable id. `skillTrace` / `Shuttle.SkillTrace` is the same primitive for the `skill` frame behind `loadSkill`. You rarely call these directly — the [agent integrations](../integrations/overview.md) use them internally. Reach for them only when wrapping a tool runner mekik doesn't already integrate.

## Reading per-conversation context

Helpers *emit*; to *read* per-conversation data (a user id, a locale, auth claims), use ilmek's context metadata, which mekik populates:

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
.node("desk", async (state, ctx) => {
  const locale = (ctx.meta.mekik as { locale?: string })?.locale ?? "en";
  const claims = ctx.meta.auth; // verified auth claims, if an Authenticator ran
  return { reply: greet(locale) };
})
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
.Node("desk", async (State state, IContext ctx) =>
{
    var mekikMeta = ctx.Meta.GetValueOrDefault("mekik") as IReadOnlyDictionary<string, object?>;
    var locale = mekikMeta?.GetValueOrDefault("locale") as string ?? "en";
    var claims = ctx.Meta.GetValueOrDefault("auth") as IReadOnlyDictionary<string, object?>; // verified auth claims
    return Update.Of("reply", Greet(locale));
})
```

</TabItem>
</Tabs>

`meta.mekik` is your context selector's output; `meta.client` is the client meta your `acceptClientMeta` allowlist kept — the connection's `hello.meta` with the turn frame's own `meta` laid over it per key; `meta.auth` is the auth verdict's claims (read them with `mekik.authClaims(ctx)` / `Shuttle.AuthClaims(ctx)`). `meta.clientTools` and `meta.skills` are there only when those features are on — read them through the [client tool](./client-tools.md) and [skill](./skills.md) helpers. See [Concepts → Graph context](../concepts.md#7-graph-context-as-a-parameter).

## Where to go next

- [**Generative UI**](./generative-ui.md) — the chunk model and the component contract.
- [**Typed components**](./components.md) — bind a component name once; every chativa built-in, worked through.
- [**Rich messages**](./messages.md) — standalone transcript entries: images, cards, carousels, files.
- [**Tools**](./tools.md) — exactly-once, redaction, and the trace lifecycle.
- [**Human-in-the-loop**](./human-in-the-loop.md) — the durable-pause authoring rules.
