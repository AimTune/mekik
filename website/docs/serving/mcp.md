---
sidebar_position: 3
title: MCP server
description: Expose a mekik graph as Model Context Protocol tools — one turn per tools/call, human-in-the-loop pauses answered through a resume tool — over Streamable HTTP in both languages.
---

# Serving a graph as MCP tools

A mekik app already speaks to humans over WebSocket. **`MekikMcpServer`** lets it speak to *other agents* too: the graph becomes a pair of [Model Context Protocol](https://modelcontextprotocol.io) tools that any MCP client — Claude Desktop, an IDE, another ilmek graph via [`@ilmek/mcp`](https://ilmek.aimtune.dev/mcp) — can call. The wire rules are normative in [`PROTOCOL.md §13`](https://github.com/AimTune/mekik/blob/main/PROTOCOL.md); this page is the serving guide.

The mapping is deliberately small: **one turn == one `tools/call`**. A finished run returns the reply; a run that paused for a human returns the open interrupts and asks the caller to answer them through a second tool — so [human-in-the-loop](../authoring/human-in-the-loop.md) survives the hop into another agent's toolbox.

## Serve it

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
import { mekik, MekikMcpServer } from "@mekik/core";
import { serveMcp } from "@mekik/mcp";

const app = mekik({ graph, reply: (s) => s.reply as string });
const mcp = new MekikMcpServer(app, {
    name: "support_desk",                              // the tool name a calling agent invokes
    description: "Answers questions about orders.",    // what a calling model reads
    serverInfo: { name: "acme-support", version: "1.0.0" },
});
serveMcp(mcp, { port: 8900, path: "/mcp" });          // Streamable HTTP at http://localhost:8900/mcp
```

`mcpRequestHandler(mcp)` is the bare `(req, res)` handler for mounting on an existing server or framework; `serveMcp(mcp, { server })` attaches to an `http.Server` you already own.

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
var app = new MekikApp(new MekikOptions { Graph = g, Reply = s => s.GetValueOrDefault("reply") as string });
var mcp = new MekikMcpServer(app, new McpServerOptions
{
    Name = "support_desk",                              // the tool name a calling agent invokes
    Description = "Answers questions about orders.",    // what a calling model reads
    ServerInfo = ("acme-support", "1.0.0"),
});

var web = builder.Build();
web.UseWebSockets();
web.MapMekik("/ws", app);      // humans
web.MapMekikMcp("/mcp", mcp);  // agents
web.Run();
```

</TabItem>
</Tabs>

The same app can serve both: the WebSocket endpoint for people, the MCP endpoint for agents. They share the graph, the checkpointer and the transcript stores.

## The two tools

`tools/list` advertises exactly two tools:

| tool | arguments | does |
|---|---|---|
| `<name>` | `{ message: string, conversationId?: string }` | runs one turn — a new conversation, or an existing one when `conversationId` is given |
| `<name>__resume` | `{ conversationId: string, answers: object }` | answers the open interrupts of a paused conversation, keyed by interrupt id, and continues it |

Both return the same result shape:

```jsonc
{
  "content": [{ "type": "text", "text": "Order ORD-42 totals 249.9." }],
  "structuredContent": {
    "conversationId": "conv-8f2…",
    "status": "finished",              // finished | interrupted | error | aborted | refused
    "reply": "Order ORD-42 totals 249.9.",
    "pending": [],                     // open pauses, when interrupted
    "toolCalls": [{ "id": "…", "name": "get_order", "status": "completed" }],
    "skills": ["brand-voice"]
  }
}
```

`content[0].text` is what a calling model reads: the reply when the run finished, the error text (with `isError: true`) when the graph failed, and — when the run paused — a description of each open interrupt and the instruction to call the resume tool:

```text
The agent paused and needs input before it can continue:
- interrupt "agent:interrupt#0": {"title":"Refund 249.9?"} — options: {"approved":true}, "Cancel"
Call support_desk__resume with conversationId "conv-8f2…" and an answers object keyed by those ids.
```

`structuredContent` carries the same facts as data — `pending[]` has each interrupt's `id`, `payload`, and `actions` (or `tool` when the pause is a [client tool call](../authoring/client-tools.md) that only the conversation's own UI can answer). `includeFrames: true` adds the turn's persistent frames for callers that want the whole trace.

A turn the engine **refuses** — a message to a conversation that is parked on an interrupt (`error{interrupted}`), a resume with nothing open (`error{not_interrupted}`), a second turn while one is running (`error{busy}`) — comes back as `status: "refused"` with `isError: true` and the engine's error text, never as a crash.

## Identity

Every MCP conversation belongs to one mekik user, `userId: "mcp"` by default (`McpServerOptions.userId` / `UserId` changes it). A `conversationId` from a previous result continues that conversation; an unknown id starts a fresh one and the result reports the id actually used — the same [adoption rule](../protocol/identity.md) the WebSocket handshake follows. The conversations are ordinary mekik conversations: they persist in the history store and a human could open one in chativa later.

## The JSON-RPC subset

The server implements what an MCP client needs to call tools and nothing it does not: `initialize` (negotiating `2025-06-18`, `2025-03-26` or `2024-11-05`; an unknown version gets the latest), `ping`, `tools/list`, `tools/call`, and notifications (answered with nothing). Anything else is `-32601`. Argument shape errors are `-32602`; a failure inside the graph is a *result* with `isError: true`, as the protocol wants. The HTTP transport accepts one message per `POST` (`202` for a notification, `400` for bad JSON, `413` over 1 MiB), answers `GET` with `405` — it opens no server-to-client stream — and `DELETE` with `200`.

The exact responses are pinned by [`conformance/mcp/rpc.json`](https://github.com/AimTune/mekik/blob/main/conformance/mcp/rpc.json), replayed by both language suites.

## Security

The MCP endpoint is unauthenticated by construction of the protocol subset it implements; put it behind your gateway's auth (a bearer token the calling agent presents, an allowlisted network) the way you would any internal tool endpoint. The graph's own guardrails — [approvals](../authoring/human-in-the-loop.md), tool policies — still apply: a calling agent that hits an approval gets `status: "interrupted"` and cannot proceed until *something* answers, which is exactly the point.

## Where to go next

- [Consuming MCP servers](../integrations/mcp.md) — the other direction: an MCP server's tools inside your graph.
- [Transport](./transport.md) — the WebSocket side of the same app.
