---
sidebar_position: 4
title: Semantic Kernel
description: "Mekik.SemanticKernel — one IFunctionInvocationFilter that covers direct calls, auto function calling, agents, and planners with tool traces, approval, and exactly-once."
---

# Semantic Kernel

`Mekik.SemanticKernel` integrates [Semantic Kernel](https://github.com/microsoft/semantic-kernel) through the seam **everything in SK funnels through** — an `IFunctionInvocationFilter`. One registration covers direct `kernel.InvokeAsync`, auto function calling, `ChatCompletionAgent` and the other agent types, and planners. You don't convert plugins or hand the agent a different tool list.

## `kernel.UseMekik`

```csharp
using Mekik.SemanticKernel;

.Node("agent", async (State state, IContext ctx) =>
{
    using var _ = kernel.UseMekik(ctx, new()
    {
        ["get_order"]       = new ToolPolicy(),                               // shown
        ["refund_payment"]  = new ToolPolicy { Approve = new ApproveSpec() }, // ask the human first
        ["internal_lookup"] = new ToolPolicy { Show = false },                // runs, not shown
        ["charge"]          = new ToolPolicy { Redact = ["cardNumber"] },     // shown, masked
    });

    var settings = new PromptExecutionSettings { FunctionChoiceBehavior = FunctionChoiceBehavior.Auto() };
    var reply = await kernel.InvokePromptAsync(state.Get<string>("input"), new KernelArguments(settings));
    return Update.Of("reply", reply.ToString());
})
```

## Why a filter, and what it covers

An `IFunctionInvocationFilter` sits in front of every function invocation the kernel makes — direct calls, the auto function-calling loop, agents, planners. Registering one covers Semantic Kernel *and anything built on top of it* with a single line. That's the reason this integration is a filter and not a wrapper: SK has one choke point, so you use it.

## The scope matters — dispose it

`UseMekik` returns an `IDisposable` scope:

```csharp
using var _ = kernel.UseMekik(ctx, policies);
```

Disposing removes the filter. This is important because a `Kernel` is usually **long-lived** while `ctx` belongs to a **single graph run**. Leaving the filter registered would leak a stale `ctx` into the next turn — the `using` scope ties the filter's lifetime to exactly the run it belongs to.

## Policy lookup

Policies are matched by **plugin-qualified name** (`Plugin.Function`) first, then the bare function name — specific where two plugins share a name, terse everywhere else:

```csharp
new()
{
    ["Billing.Charge"] = new ToolPolicy { Approve = new ApproveSpec() }, // this plugin's Charge
    ["Charge"]         = new ToolPolicy { Show = false },                // any other Charge
}
```

`ToolPolicy` and `ApproveSpec` are the **same types** `Mekik.Agents` uses, so you learn one policy shape for both .NET integrations.

## Decline is a short-circuit

When a human declines an `approve` function, the filter **short-circuits**: `next` is never called, so the function doesn't run, and the kernel receives `DenyMessage` as the result so the model can respond rather than see an exception. Same behaviour as the other integrations, expressed the SK way.

## Notes

- `Redact` masks only what is *surfaced*; the function still receives real values.
- Journaled results must survive a serializer round-trip, like any ilmek step.
- Since `KernelFunction` derives from `AIFunction`, `Mekik.Agents` *can* also wrap SK functions directly — but wrapping changes the type, so the kernel's plugin collection would no longer accept them. **Prefer this filter for Semantic Kernel.**

## Where to go next

- [**Microsoft.Extensions.AI**](./dotnet-agents.md) — the wrapper-based .NET integration.
- [**Agent integrations → Overview**](./overview.md) — the shared policy shape.
- [**Human-in-the-loop**](../authoring/human-in-the-loop.md) — how tool approval renders as an interrupt.
