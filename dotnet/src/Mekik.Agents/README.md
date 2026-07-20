# Mekik.Agents

[Microsoft.Extensions.AI](https://www.nuget.org/packages/Microsoft.Extensions.AI.Abstractions)
integration for [mekik](https://github.com/AimTune/mekik). Run a tool-calling
chat client inside an ilmek node and get, per function:

- **Visibility** — the model's function calls surface in the UI as `tool_call` traces
- **Approval** — a function can pause for a human before it runs
- **Exactly-once** — functions are journaled, so a pause/resume doesn't re-run them

```csharp
var tools = MekikTools.Wrap(ctx, [getOrder, refundPayment, internalLookup, charge], new()
{
    ["get_order"]       = new ToolPolicy(),                              // shown
    ["refund_payment"]  = new ToolPolicy { Approve = new ApproveSpec() },// ask the human first
    ["internal_lookup"] = new ToolPolicy { Show = false },               // runs, not shown
    ["charge"]          = new ToolPolicy { Redact = ["cardNumber"] },    // shown, masked
});

var response = await chatClient.GetResponseAsync(
    messages, new ChatOptions { Tools = [.. tools] }, ct);
```

The wrappers are `DelegatingAIFunction`s, so name, description and JSON schema
are preserved and the model sees exactly the same tools.

## Why wrapping

A chat client invokes its own functions. That leaves two gaps `Shuttle.Tool`
normally closes for you:

1. Nothing emits a `tool_call` frame, so the UI never learns a function ran.
2. **When a node pauses for a human and the graph resumes, the node re-runs from
   the top — and the model calls its functions again.** Only `ctx.StepAsync`
   makes an effect survive that replay.

## Relationship to `ApprovalRequiredAIFunction`

Microsoft.Extensions.AI ships its own approval marker, which asks through the
*chat protocol*: the caller must round-trip approval content with the model.
`ToolPolicy.Approve` instead pauses the **graph** with a mekik interrupt, so the
question renders in chativa as chips (or a form), and the pause lives in ilmek's
checkpoint — it survives a process restart. Use whichever fits; they are not
mutually exclusive.

## Notes

- `Redact` masks only what is *surfaced*; the function still receives real values.
- A declined function is never executed and returns `DenyMessage` (default
  `"The user declined to run <name>."`) so the model's loop can continue.
- Each function gets a stable interrupt key, so several approvals in one node
  stay separately addressable.
- Journaled results must survive a serializer round-trip, like any ilmek step.

This is the .NET mirror of `@mekik/langchain`; both keep the same policy shape.

MIT
