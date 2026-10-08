---
sidebar_position: 5
title: MCP servers as tools
description: Put a Model Context Protocol server's tools in an agent's toolbox with the mekik treatment — tool_call traces, exactly-once across a pause, human approval — via @ilmek/mcp in TypeScript and Ilmek.Mcp or the official SDK in .NET.
---

# MCP servers as tools

An agent node often wants tools that live elsewhere — GitHub, a database, a file system — behind a [Model Context Protocol](https://modelcontextprotocol.io) server. ilmek's [`@ilmek/mcp` / `Ilmek.Mcp`](https://ilmek.aimtune.dev/mcp) connects to one and exposes its tools; mekik's agent wrappers give each call the same treatment as a server tool: a [`tool_call` trace](../authoring/tools.md), exactly-once across an interrupt/resume, and optional [human approval](../authoring/human-in-the-loop.md) — keyed by the **exposed** tool name (`github__search`).

The other direction — *your* graph as an MCP tool for other agents — is [Serving → MCP server](../serving/mcp.md).

## TypeScript — `withMcpTools`

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpToolbox } from "@ilmek/mcp";
import { withMcpTools, runAgent } from "@mekik/langchain";

const client = new Client({ name: "my-agent", version: "1.0.0" });  // connect it to the server's transport
const github = await McpToolbox.connect(client, { name: "github" });   // any SDK Client fits, structurally

.node("agent", async (state, ctx) => {
  const tools = [
    ...serverTools,                                                              // runAgent wraps these with `policy`
    ...withMcpTools(ctx, github, { github__create_issue: { approve: true } }),   // destructive → ask first
  ];
  return { reply: await runAgent(ctx, model(), { system: SYSTEM, input: state.input, tools, policy }) };
})
```

Signature:

```ts
function withMcpTools(
  ctx: Context<any>,
  toolbox: McpToolboxLike,          // @ilmek/mcp's McpToolbox, or anything with { name, tools(), invoke() }
  policy?: ToolPolicyMap,           // keyed by exposed tool name
  options?: WithMekikToolsOptions,
): StructuredToolInterface[];
```

Each tool keeps the server's name, description and JSON Schema. The observation the model reads is the result's `text` (or its `structuredContent`, serialized, when there is no text); a result the server flagged `isError` comes back as `Error from <tool>: …` — an observation the loop can route around, not a crash. `withMcpTools` calls the toolbox's raw `invoke`, not its journaled `call`, because [`withMekikTools`](./langchain.md#withmekiktools) already journals every wrapped tool under `lc:<name>`.

## .NET — two ways in

**With the official SDK.** `ModelContextProtocol`'s `McpClientTool` already *is* an `AIFunction`, so the client's tools go straight into [`MekikTools.Wrap`](./dotnet-agents.md#mekiktoolswrap):

```csharp
var client = await McpClient.CreateAsync(transport);   // ModelContextProtocol.Client
var tools = MekikTools.Wrap(ctx, await client.ListToolsAsync(), new Dictionary<string, ToolPolicy>
{
    ["create_issue"] = new ToolPolicy { Approve = new ApproveSpec() },
});
```

**With `Ilmek.Mcp`'s toolbox** (or any tool list plus an invoker), `McpFunctions.Wrap` builds the functions and wraps them the same way (`SdkClient` is the small `IMcpClient` adapter from [ilmek's MCP page](https://ilmek.aimtune.dev/mcp#install-and-connect)):

```csharp
using Ilmek.Mcp;
using Mekik.Agents;

// SdkClient: the two-method IMcpClient adapter over the official client, from ilmek's MCP page
var github = await McpToolbox.ConnectAsync(new SdkClient(client), new() { Name = "github" });

var tools = MekikTools.Wrap(ctx, serverFunctions, policies)
    .Concat(McpFunctions.Wrap(ctx,
        github.Tools().Select(t => new RemoteToolInfo { Name = t.Name, Description = t.Description, InputSchema = t.InputSchema }),
        async (name, args, ct) =>
        {
            var r = await github.InvokeAsync(name, args, ct);
            return new RemoteToolResult { Text = r.Text, Structured = r.Structured, IsError = r.IsError };
        },
        new Dictionary<string, ToolPolicy> { ["github__create_issue"] = new ToolPolicy { Approve = new ApproveSpec() } }))
    .ToList();
```

Signature:

```csharp
static IReadOnlyList<AIFunction> Wrap(
    IContext ctx,
    IEnumerable<RemoteToolInfo> tools,           // { Name, Description?, InputSchema }
    RemoteToolInvoker invoke,                    // (name, arguments, ct) => Task<RemoteToolResult { Text, Structured?, IsError }>
    IReadOnlyDictionary<string, ToolPolicy>? policies = null,
    ToolPolicy? defaultPolicy = null);
```

The observation rules are the TypeScript ones: text, or serialized structured content, or `Error from <tool>: …`.

## What the human sees

An MCP tool call renders exactly like a server tool call: a `tool_call` frame running → completed/error, upserted by a replay-stable id, so a chativa transcript shows *github__search — completed* and a resume pass re-traces the same entry instead of duplicating it. An `approve` policy pauses the graph with a `Run github__create_issue?` interrupt carrying the arguments; a decline is an observation (`The user declined to run …`), never an execution.

## Graphs as data

For a stored graph spec, `@ilmek/mcp`'s `mcp_tool` and `mcp_resource` [node types](https://ilmek.aimtune.dev/mcp#mcp-as-graph-data) call a server by name without any model in the loop; the call is journaled under `mcp:<server>:<tool>` and — because it runs inside the node, not through an agent wrapper — surfaces no `tool_call` frame unless you wrap it in [`mekik.tool`](../authoring/tools.md).
