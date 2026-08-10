---
sidebar_position: 3
title: Microsoft.Extensions.AI
description: "Mekik.Agents — wrap a tool-calling chat client's functions so each gets a tool_call trace, human approval, and exactly-once. The .NET mirror of @mekik/langchain."
---

# Microsoft.Extensions.AI

`Mekik.Agents` is the [Microsoft.Extensions.AI](https://www.nuget.org/packages/Microsoft.Extensions.AI.Abstractions) integration — the .NET mirror of [`@mekik/langchain`](./langchain.md). Run a tool-calling chat client inside an ilmek node and get, per function: a `tool_call` trace, optional human approval, and exactly-once across a pause/resume. The wrappers are `DelegatingAIFunction`s, so name, description, and JSON schema are preserved and the model sees exactly the same tools.

## `Agent.RunAsync` — the loop, packaged

Most nodes don't need to hand-roll the model↔tool loop. `Agent.RunAsync` drives it: it wraps your functions with [`MekikTools`](#mekiktoolswrap), runs each model call inside `ctx.StepAsync` (a resume replays the decision instead of re-paying for it), streams text deltas live as one growing bubble, and returns the consolidated reply:

```csharp
using Mekik.Agents;

.Node("agent", async (State state, IContext ctx) =>
    Update.Of("reply", await Agent.RunAsync(ctx, chat, new AgentRunOptions
    {
        System = SYSTEM,
        Input  = state.Get<string>("input") ?? string.Empty,
        Tools  = functions,                       // raw AIFunctions — wrapped for you
        Policies = new Dictionary<string, ToolPolicy>
        {
            ["refund_payment"] = new() { Approve = new ApproveSpec() }, // pauses for a human
        },
    })))
```

The loop is budgeted by `MaxTurns` — model↔tool round-trips, default 25. Individual tool invocations do **not** consume turns: a round that fires five tools still costs one turn. `MaxToolCalls` (default 25) separately caps total tool invocations; rather than cutting a batch off halfway, the loop settles with `BudgetReply` before executing a batch that would overrun the cap. Node-level looping stays budgeted by ilmek's `RecursionLimit`, which tool calls never consume.

You return the result as your node's reply (`Update.Of("reply", …)`). When **streaming** (the default), the answer is delivered live as the durable message (streamed chunks persist and replay), so `RunAsync` returns an **empty string** — `Update.Of("reply", "")` emits nothing extra, no duplicate. With `Stream = false`, it returns the full text for the consolidated `text` reply. A model's function-call arguments and results (which `AIFunctionFactory` marshals through `System.Text.Json` as `JsonElement`) are canonicalized into the trace automatically — no plain-value converter needed. Reach for [`MekikTools.Wrap`](#mekiktoolswrap) directly when you need to drive the loop yourself.

## `MekikTools.Wrap`

```csharp
using Mekik.Agents;

var tools = MekikTools.Wrap(ctx, [getOrder, refundPayment, internalLookup, charge], new()
{
    ["get_order"]       = new ToolPolicy(),                               // shown
    ["refund_payment"]  = new ToolPolicy { Approve = new ApproveSpec() }, // ask the human first
    ["internal_lookup"] = new ToolPolicy { Show = false },                // runs, not shown
    ["charge"]          = new ToolPolicy { Redact = ["cardNumber"] },     // shown, masked
});

var response = await chatClient.GetResponseAsync(
    messages, new ChatOptions { Tools = [.. tools] }, ct);
```

Each wrapper, when the model calls it: emits a `tool_call` trace (unless `Show = false`), optionally pauses the graph for a human, and executes inside `ctx.StepAsync` so it runs exactly once across an interrupt/resume.

## `ClientToolFunctions.Wrap` — the frontend's tools

The connected **client** can declare tools of its own — open its date picker, render one of its cards — via [client tools](../authoring/client-tools.md) (PROTOCOL.md §11). `ClientToolFunctions.Wrap` turns the turn's accepted declarations into `AIFunction`s so the model calls the UI the same way it calls a server function. It is the .NET mirror of `@mekik/langchain`'s `withClientTools`:

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

Signature:

```csharp
static IReadOnlyList<AIFunction> Wrap(IContext ctx, IReadOnlyList<string>? tags = null, string? mode = null);
```

Each wrapper's executor is [`Shuttle.CallClientToolAsync`](../authoring/client-tools.md#calling):

- a `"call"`-mode tool **parks the loop durably** — the pause is an ilmek interrupt, the agent's decisions are journaled, and a resume replays them instead of re-invoking the model;
- a `"notify"`-mode tool returns a delivery note (`"Delivered <name> to the client."`) the model can read;
- a failed client handler comes back as an error *observation* (`"Error from client tool <name>: …"`), so the loop stays alive — the underlying `InterruptSignalException` is always rethrown, never swallowed;
- the declared JSON Schema is exposed verbatim through `AIFunction.JsonSchema` (canonicalized with `Json.Canonicalize`, so it is byte-identical to what the TypeScript side would present).

`tags` is the scoping lever: the frontend tags the tools it wants restricted to particular nodes, untagged tools are visible everywhere, and the server's [`MekikOptions.ClientTools` policy](../authoring/client-tools.md#accepting-the-server-side--off-by-default) has already allowlisted the whole set before this call ever sees it. Runnable: [`dotnet/examples/Mekik.ClientTools`](https://github.com/AimTune/mekik/tree/main/dotnet/examples/Mekik.ClientTools).

## Why wrapping

A chat client invokes its own functions. That leaves the two gaps `Shuttle.Tool` normally closes:

1. Nothing emits a `tool_call` frame, so the UI never learns a function ran.
2. When a node pauses for a human and the graph resumes, the node re-runs from the top — and the model calls its functions **again**. Only `ctx.StepAsync` makes an effect survive that replay.

## Relationship to `ApprovalRequiredAIFunction`

Microsoft.Extensions.AI ships its own approval marker, `ApprovalRequiredAIFunction`, which asks through the **chat protocol**: the caller round-trips approval content with the model. `ToolPolicy.Approve` instead pauses the **graph** with a mekik interrupt, so:

- the question renders in chativa as chips (or a form),
- the pause lives in ilmek's checkpoint — it survives a process restart.

Use whichever fits; they aren't mutually exclusive. The distinction is *where* the approval lives — in the chat turn (M.E.AI's marker) or in the durable graph checkpoint (mekik's interrupt).

## Policy

The policy shape is identical to the other integrations:

```csharp
new ToolPolicy
{
    Show    = true,                  // surface the trace (default true)
    Approve = new ApproveSpec(),     // pause for a human (default: none)
    Redact  = ["cardNumber"],        // mask these fields in the surfaced trace
};
```

Notes:

- `Redact` masks only what is *surfaced*; the function still receives real values.
- A declined function is never executed and returns `DenyMessage` (default `"The user declined to run <name>."`) so the model's loop can continue.
- Each function gets a stable interrupt key, so several approvals in one node stay separately addressable.
- Journaled results must survive a serializer round-trip, like any ilmek step.

## `Agent.RouteAsync` — classify into one node

The router pattern (classify the turn, then `goto` a focused expert node) is one call. It builds a strict classification prompt from your route names + descriptions, journals the choice (a resume replays the same route), and normalizes the answer to a valid route — falling back when the model answers off-list:

```csharp
var target = await Agent.RouteAsync(ctx, chat,
    [
        new Route("reporting", "sprint reports and metrics"),
        new Route("billing",   "invoices and charges"),
        new Route("general",   "everything else"),
    ],
    state.Get<string>("input") ?? string.Empty,
    fallback: "general");

return Command.Create(Update.Of("route", target), target); // set channel + goto node
```

**No sampling options are sent unless you ask for them.** Reasoning models (gpt-5.x and friends) reject any explicitly-set `temperature` with an HTTP 400, so a router that pinned `temperature: 0` would fail *every* classification instead of merely varying — the turn would then land on whatever fallback node you gave it. `RouteAsync` therefore calls the model with no `ChatOptions` at all; determinism is not load-bearing here, because the prompt pins the answer to one word and an off-list answer falls back. Pass `temperature:` when your model accepts it:

```csharp
var target = await Agent.RouteAsync(ctx, chat, routes, input,
    fallback: "general",
    temperature: 0f);   // default: unset — nothing goes on the wire
```

The TypeScript `route` has no such knob for the same reason it never needed one: a LangChain chat model carries its own sampling config, set where you construct it.

## Reading auth claims

A node reads the authenticated claims (the `AuthVerdict.Claims` from your [authenticator](../authentication.md)) with `Shuttle.AuthClaims(ctx)` — no `ctx.Meta["auth"]` dance — and coerces a claim to a string list, whatever JSON shape it survived as, with `Shuttle.ClaimStrings`:

```csharp
var claims   = Shuttle.AuthClaims(ctx);
var userName = claims.GetValueOrDefault("userName") as string;
var roles    = Shuttle.ClaimStrings(claims, "roles");
```

Both are in `Mekik.Core` (`Shuttle`), mirrored in TypeScript as `mekik.authClaims` / `mekik.claimStrings`.

## Where to go next

- [**Semantic Kernel**](./semantic-kernel.md) — the SK integration, a filter rather than a wrapper.
- [**Agent integrations → Overview**](./overview.md) — the shared policy shape.
- [**Authoring → Client tools**](../authoring/client-tools.md) — declaring, accepting, and calling the frontend's tools.
- [**Parity → TypeScript ↔ .NET**](../parity/languages.md) — how `Mekik.Agents` mirrors `@mekik/langchain`.
