# Mekik.SemanticKernel

[Semantic Kernel](https://github.com/microsoft/semantic-kernel) integration for
[mekik](https://github.com/AimTune/mekik). Run a kernel inside an ilmek node and
get, per function:

- **Visibility** — the kernel's function calls surface in the UI as `tool_call` traces
- **Approval** — a function can pause for a human before it runs
- **Exactly-once** — functions are journaled, so a pause/resume doesn't re-run them

```csharp
.Node("agent", async (State state, IContext ctx) =>
{
    using var _ = kernel.UseMekik(ctx, new()
    {
        ["get_order"]       = new ToolPolicy(),                              // shown
        ["refund_payment"]  = new ToolPolicy { Approve = new ApproveSpec() },// ask the human first
        ["internal_lookup"] = new ToolPolicy { Show = false },               // runs, not shown
        ["charge"]          = new ToolPolicy { Redact = ["cardNumber"] },    // shown, masked
    });

    var settings = new PromptExecutionSettings { FunctionChoiceBehavior = FunctionChoiceBehavior.Auto() };
    var reply = await kernel.InvokePromptAsync(state.Get<string>("input"), new KernelArguments(settings));
    return Update.Of("reply", reply.ToString());
})
```

## Why a filter, and what "and its derivatives" means

This ships an `IFunctionInvocationFilter`, which is the seam **everything in
Semantic Kernel funnels through**: direct `kernel.InvokeAsync`, auto function
calling, `ChatCompletionAgent` and the other agent types, and planners. One
registration covers Semantic Kernel and anything built on top of it — you do not
convert plugins or hand the agent a different tool list.

`UseMekik` returns a scope:

```csharp
using var _ = kernel.UseMekik(ctx, policies);
```

Disposing removes the filter. That matters because a `Kernel` is usually
long-lived while `ctx` belongs to a single graph run; leaving filters registered
would leak a stale context into the next turn.

## Policy lookup

Policies are matched by plugin-qualified name (`Plugin.Function`) first, then the
bare function name — specific where two plugins share a name, terse everywhere
else. `ToolPolicy` and `ApproveSpec` are the same types `Mekik.Agents` uses, so
you learn one policy shape for both .NET integrations.

## Notes

- A declined function is **short-circuited**: `next` is never called, so it does
  not run, and the kernel receives `DenyMessage` as the result so the model can
  respond rather than see an exception.
- `Redact` masks only what is *surfaced*; the function still receives real values.
- Journaled results must survive a serializer round-trip, like any ilmek step.
- Since `KernelFunction` derives from `AIFunction`, `Mekik.Agents` can also wrap
  SK functions directly — but wrapping changes the type, so the kernel's plugin
  collection would no longer accept them. Prefer this filter for Semantic Kernel.

MIT
