# Mekik.Agents

[Microsoft.Extensions.AI](https://www.nuget.org/packages/Microsoft.Extensions.AI.Abstractions)
integration for [mekik](https://github.com/AimTune/mekik). Run a tool-calling
chat client inside an ilmek node and get, per function:

- **Visibility** — the model's function calls surface in the UI as `tool_call` traces
- **Approval** — a function can pause for a human before it runs
- **Exactly-once** — functions are journaled, so a pause/resume doesn't re-run them

```csharp
var tools = MekikTools.Wrap(ctx, [getOrder, refundPayment, internalLookup, charge], new Dictionary<string, ToolPolicy>
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

## `Agent.RunAsync` — the loop, packaged

```csharp
.Node("agent", async (State state, IContext ctx) =>
    Update.Of("reply", await Agent.RunAsync(ctx, chat, new AgentRunOptions
    {
        System   = SYSTEM,
        Input    = state.Get<string>("input") ?? string.Empty,
        Tools    = [getOrder, refundPayment],             // raw functions — RunAsync wraps them
        Policies = new Dictionary<string, ToolPolicy> { ["refund_payment"] = new() { Approve = new ApproveSpec() } },
    })))
```

`Agent.RunAsync` wraps the functions with `MekikTools`, journals each model call
so a resume replays it, streams text live, and is budgeted by `MaxTurns` (model
rounds, default 25) and `MaxToolCalls` (default 25). A function that throws, or
whose arguments fail binding, becomes an `Error from <tool>: …` observation and
the model keeps going. `ClientToolFunctions.Wrap(ctx, tags?, mode?)` adds the
frontend's declared tools, and `Agent.RouteAsync(ctx, chat, routes, input)`
classifies a turn into one node (an exact answer wins, otherwise the longest
route name mentioned).

## Skills — progressive disclosure

`SkillFunctions.Wrap(ctx, tags: [...])` turns the app's [skills](https://mekik.aimtune.dev/authoring/skills)
into a `load_skill` function (plus `read_skill_resource` when the catalog has
files), and `AgentRunOptions.Skills = true` appends the `<available_skills>`
block to the system prompt and adds the functions in one switch. Each load emits
a persistent `skill` frame so the UI shows which skill the agent is following.
A skill owns its tools: a `SkillEntry<AIFunction>` in the catalog carries
`Tools`, and `Agent.RunAsync` offers them to the model only after it successfully loads that
skill, which keeps the per-call tool list small. The tools stay on the server —
the catalog frame and hash never see them. `AgentRunOptions.SkillTools` adds
functions that must be built per request; they merge with the entry's own. A
function built once reads the calling run's context with
`MekikTools.ToolContext(arguments)`.

```csharp
Skills = SkillSources.Inline(new SkillEntry<AIFunction>
{
    Name = "refunds", Description = "Refund a paid order.", Instructions = "Check the order first.",
    Tools = [getOrder, refund],
}),
```

## MCP servers as tools

With the official `ModelContextProtocol` client, its `McpClientTool`s are already
`AIFunction`s — hand them to `MekikTools.Wrap`. With `Ilmek.Mcp`'s toolbox (or any
tool list plus an invoker), `McpFunctions.Wrap(ctx, tools, invoke, policies)`
builds the functions and wraps them the same way, approval keyed by the exposed
name (`github__create_issue`).

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
