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

The router pattern (classify the turn, then `goto` a focused expert node) is one call. It builds a strict classification prompt from your route names + descriptions, journals the choice (a resume replays the same route), runs at temperature 0, and normalizes the answer to a valid route — falling back when the model answers off-list:

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
- [**Parity → TypeScript ↔ .NET**](../parity/languages.md) — how `Mekik.Agents` mirrors `@mekik/langchain`.
