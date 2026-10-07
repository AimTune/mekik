---
sidebar_position: 7
title: Client tools
description: The frontend declares its own UI capabilities as tools; a node (or a model) calls them with mekik.callClientTool, with tags scoping which node sees which tool.
---

# Client tools

[Server-defined components](components.md) let the server ship a widget to the client. **Client tools** are the mirror image: the frontend declares the things *it* can do — render one of its own UI cards, open a native picker, read the device — as **tools**, described well enough for a server-side model to call. A node invokes them exactly like server tools, and the result streams back into the run.

The wire rules are normative in [`PROTOCOL.md §11`](https://github.com/AimTune/mekik/blob/main/PROTOCOL.md); this page is the authoring guide.

## Declaring (the chativa side)

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
            handler: async (params) => ({ date: await openDatePicker(params?.min as string) }),
        },
        {
            name: "show_confetti",
            mode: "notify",          // fire-and-forget — never blocks the run
            tags: ["fun"],           // only nodes asking for "fun" see this one
            handler: () => fireConfetti(),
        },
    ],
});
```

The **definition** (everything but `handler`) travels in the `hello` handshake and is re-declared on every reconnect; the **handler never leaves the page**. A thrown handler error becomes the server-side call's error.

:::info The registry is sealed on purpose
Definitions and handlers live in true-private (`#`) fields — console access or injected script cannot read or replace them through the connector instance. Definitions are deep-cloned and frozen at registration, and the toolset is fixed at construction unless you pass `allowDynamicTools: true` (which unlocks `registerTool` / `unregisterTool`, each re-announcing the full set with a `client_tools` frame).
:::

## Accepting (the server side — off by default)

Declarations are **ignored entirely** unless the app opts in — the same default-drop posture as `acceptClientMeta`, because tool names, descriptions and schemas reach a model's context and are a prompt-injection surface.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
const app = mekik({ graph, clientTools: true });                     // accept everything well-formed

const app = mekik({                                                  // …or allowlist
    graph,
    clientTools: (tools) => tools.filter((t) => ["pick_date", "show_confetti"].includes(t.name)),
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
var app = new MekikApp(new MekikOptions { Graph = g, ClientTools = ClientTools.AcceptAll });

// …or allowlist
ClientTools = (tools, conv) => tools.Where(t => t.Name is "pick_date" or "show_confetti").ToList(),
```

</TabItem>
</Tabs>

Leaving the option unset is the kill switch — the whole feature is inert, wire and all. **A declaration is capability, not authority**: it changes what the server may *ask the client to do*, never what the server itself does. Validate tool results like any other client input.

## Reading the toolbox — and tags

At run start the engine snapshots the union of every live connection's declared tools into `ctx.meta.clientTools`:

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
const all = mekik.clientTools(ctx);
const scoped = mekik.clientTools(ctx, { tags: ["billing"] });
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
var all = Shuttle.ClientTools(ctx);
var scoped = Shuttle.ClientTools(ctx, tags: ["billing"]);
```

</TabItem>
</Tabs>

The tag rule — how one node sees a tool another does not:

- a tool with **no tags is unrestricted**: every query returns it;
- a **tagged** tool is returned only by queries whose tags intersect its own.

So the frontend tags the tools it wants scoped and leaves general-purpose ones untagged. The returned definitions (`name`, `description`, `parameters` as JSON Schema) are ready to hand to a model as its tool list.

## Calling

### The round-trip (`mode: "call"`, default)

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
.node("schedule", async (s, ctx) => {
    const when = await mekik.callClientTool<{ date: string }>(ctx, "pick_date", { min: s.earliest });
    return { reply: `Booked for ${when.date}.` };
})
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
var when = await Shuttle.CallClientToolAsync<IReadOnlyDictionary<string, object?>>(
    ctx, "pick_date", new Dictionary<string, object?> { ["min"] = earliest });
```

</TabItem>
</Tabs>

Under the hood this is a real ilmek pause wearing tool metadata, so it inherits everything a pause guarantees: the `interrupt` frame carries `data.tool = {name, params}` (the client renders no chips — the handler answers), the wait **survives a disconnect or restart** (`welcome.pending` re-announces the open call and a reconnecting client retries it), and the answer is the result envelope — `{ok:true, result}` resolves the `await`, `{ok:false, error}` makes it **throw**. The call also surfaces as a normal `tool_call` running → completed/error trace.

The node re-runs from the top on resume, so wrap pre-call side effects in [`mekik.tool`](tools.md) exactly as around [any other pause](human-in-the-loop.md).

### Fire-and-forget (`mode: "notify"`)

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
await mekik.callClientTool(ctx, "show_confetti", { level: 3 });   // resolves immediately with undefined
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
await Shuttle.CallClientToolAsync<object?>(ctx, "show_confetti",
    new Dictionary<string, object?> { ["level"] = 3L });          // returns default (null)
```

</TabItem>
</Tabs>

No pause: the invocation streams as a genui event chunk under the reserved name `client_tool` and the handler's result is discarded. A fresh tab replaying history re-renders it (right for UI); the connector dedupes by chunk id within a session so a resume replay does not fire twice.

### When the handler fails

An `{ok:false, error}` answer makes the `await` **throw** — a plain `Error` in TypeScript, an `InvalidOperationException` in .NET — carrying the client's message, and the `tool_call` trace ends in `error`. Catch it in the node to recover, or let it end the run — a `⚠️ <message>` bot text, then `run{error}`; the agent wrappers below turn it into an observation instead, so a model-driven loop keeps going.

## Handing the toolbox to a model

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
import { withMekikTools, withClientTools, runAgent } from "@mekik/langchain";

const tools = [
    ...withMekikTools(ctx, serverTools, policy),
    ...withClientTools(ctx, { tags: ["billing"] }),
];
return { reply: await runAgent(ctx, model(), { system, input: s.input, tools }) };
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
var tools = MekikTools.Wrap(ctx, serverFunctions, policies)
    .Concat(ClientToolFunctions.Wrap(ctx, tags: ["billing"]))
    .ToList();
```

</TabItem>
</Tabs>

A call-mode tool parks the loop durably; a notify tool returns a delivery note; a handler error comes back as an error *observation*, so the agent loop stays alive and the model can route around it.

## Dynamic toolsets

A `client_tools` frame replaces the connection's whole set (`[]` withdraws everything) and takes effect **on the next turn** — the snapshot is taken at run start, so a set changing mid-run does not shift under the node's feet. Multi-tab: the snapshot is the union across live connections, deduped by name, the most recent declaration winning.

## Runnable examples

The whole page is executable in both languages, with the client's part scripted so no browser is needed — [`ts/examples/client-tools.ts`](https://github.com/AimTune/mekik/blob/main/ts/examples/client-tools.ts) and [`dotnet/examples/Mekik.ClientTools`](https://github.com/AimTune/mekik/tree/main/dotnet/examples/Mekik.ClientTools):

```bash
node ts/examples/client-tools.ts                        # self-test: allowlist, tag scoping, round-trip, notify, error envelope
node ts/examples/client-tools.ts --serve                # ws://localhost:8807 for a real chativa client
dotnet run --project dotnet/examples/Mekik.ClientTools  # the same self-test, byte-identical frames
```

See also [Examples → The frontend owns the tool](../examples.md#the-frontend-owns-the-tool), and the integration pages for the model wrappers: [LangChain → `withClientTools`](../integrations/langchain.md#withclienttools--the-frontends-tools), [Microsoft.Extensions.AI → `ClientToolFunctions.Wrap`](../integrations/dotnet-agents.md#clienttoolfunctionswrap--the-frontends-tools).
