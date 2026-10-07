---
sidebar_position: 4
title: A2A agent
description: Serve a mekik graph as an Agent2Agent agent — an Agent Card, message/send as one turn per task, human-in-the-loop pauses as input-required tasks — over HTTP in both languages.
---

# Serving a graph as an A2A agent

Where [MCP](./mcp.md) makes a graph a *tool* another agent calls, **A2A** makes it a *peer*: an [Agent2Agent](https://a2a-protocol.org) agent with an Agent Card, addressed by messages, answering with tasks. `MekikA2aServer` does the mapping; `@mekik/a2a` and `Mekik.AspNetCore.MapMekikA2a` put it behind HTTP. The wire rules are normative in [`PROTOCOL.md §14`](https://github.com/AimTune/mekik/blob/main/PROTOCOL.md#14-a2a-14); this page is the serving guide.

The mapping: **one mekik conversation is one A2A `contextId`; one turn is one task.** A run that paused for a human is an `input-required` task, and the next message on that task is the resume — so [human-in-the-loop](../authoring/human-in-the-loop.md) survives the hop to another agent, which can answer itself, escalate to its own human, or give up.

## Serve it

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
import { mekik, MekikA2aServer } from "@mekik/core";
import { serveA2a } from "@mekik/a2a";

const app = mekik({ graph, reply: (s) => s.reply as string, skills });
const agent = new MekikA2aServer(app, {
    name: "Support desk",
    description: "Answers questions about orders.",
    url: "https://bot.example.com/a2a",   // the card's url — where the JSON-RPC endpoint is reachable
    version: "1.2.0",
    skills: skills.list(),                // optional: the app's skill catalog on the card
});
serveA2a(agent, { port: 8901 });          // GET /.well-known/agent-card.json, POST /a2a
```

`a2aRequestHandler(agent)` is the bare `(req, res)` handler for other servers — it resolves `false` for a path it does not own, so you can fall through to your own routes; `serveA2a(agent, { server })` attaches to an `http.Server` you own; `path` (default `/a2a`) and `cardPath` (default `/.well-known/agent-card.json`) move the endpoints, and `maxBodyBytes` (default 1 MiB) caps the request body.

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
var agent = new MekikA2aServer(app, new A2aServerOptions
{
    Name = "Support desk",
    Description = "Answers questions about orders.",
    Url = "https://bot.example.com/a2a",   // the card's url — where the JSON-RPC endpoint is reachable
    Version = "1.2.0",
    Skills = catalog.List(),               // optional: the app's skill catalog on the card
});

web.MapMekik("/ws", app);      // humans
web.MapMekikA2a("/a2a", agent); // agents — card at /.well-known/agent-card.json
```

An optional third argument, `cardPath`, moves the Agent Card, and `maxBodyBytes` (default `MekikA2aAspNetCore.MaxBodyBytes`, 1 MiB) caps the request body, like the TypeScript option of the same name.

</TabItem>
</Tabs>

## The Agent Card

```jsonc
{
  "protocolVersion": "0.3.0",
  "name": "Support desk",
  "description": "Answers questions about orders.",
  "url": "https://bot.example.com/a2a",
  "preferredTransport": "JSONRPC",
  "version": "1.2.0",
  "capabilities": { "streaming": false, "pushNotifications": false, "stateTransitionHistory": false },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [
    { "id": "chat", "name": "Support desk", "description": "Answers questions about orders.", "tags": ["chat"] },
    { "id": "brand-voice", "name": "brand-voice", "description": "House style.", "tags": [] }
  ]
}
```

The agent itself is always the first skill (`chat`); the app's [skills](../authoring/skills.md) follow when you pass them, so a calling agent reads the same level-1 catalog a model does.

## Messages and tasks

`message/send` takes an A2A message — `{ role: "user", parts: [{ kind: "text", text }], contextId?, taskId? }` — and returns a task:

| message | effect |
|---|---|
| no `taskId`, no `contextId` | a new conversation, a new task: one turn |
| `contextId` from a previous task | a new task on that conversation: another turn |
| `taskId` of an `input-required` task | the resume: the message answers the open interrupts |

```jsonc
{ "kind": "task", "id": "task-…", "contextId": "conv-…",
  "status": { "state": "completed", "timestamp": "2026-09-27T10:00:00.000Z" },
  "artifacts": [{ "artifactId": "artifact-…", "name": "reply", "parts": [{ "kind": "text", "text": "Order ORD-42 totals 249.9." }] }],
  "history": [ …the user message… ],
  "metadata": { "mekik": { "conversationId": "conv-…", "status": "finished", "toolCalls": [ … ], "skills": [ … ] } } }
```

Task state follows the turn: `completed` when the run finished (the reply is a text artifact named `reply`), `failed` on a graph error, `rejected` when the engine refused the turn (a message to a parked conversation, a second turn while one runs), `canceled` after `tasks/cancel` or when the run was aborted — and **`input-required`** when the run paused:

```jsonc
{ "status": { "state": "input-required", "message": {
    "role": "agent", "taskId": "task-…", "parts": [
      { "kind": "text", "text": "The agent needs input before it can continue:\n- interrupt \"agent:interrupt#0\": {\"title\":\"Refund 249.9?\"} — options: Approve, Cancel\nReply on this task: …" },
      { "kind": "data", "data": { "pending": [{ "id": "agent:interrupt#0", "payload": { "title": "Refund 249.9?" }, "actions": [ … ] }] } } ] } },
  "metadata": { "pending": [ … ], "mekik": { … } } }
```

The status message says what is open in prose (for a model) and in a data part (for code). The caller answers by sending on the task: a **text** message answers a single open interrupt — an action's label maps to its value, anything else is the answer verbatim; a **data part** `{ "answers": { "<interrupt id>": … } }` answers several at once (required when more than one is open); a lone data part answers a single interrupt with itself. A pause that is a [client tool call](../authoring/client-tools.md) is listed but cannot be answered from here.

`tasks/get` returns a task (with `historyLength` truncating its history); `tasks/cancel` marks an `input-required` task `canceled` — the conversation stays parked on its interrupts, because mekik never discards a pause on a caller's behalf — and refuses a finished one (`-32002`). `message/stream`, `tasks/resubscribe` and push-notification configuration are `-32004 UnsupportedOperation`; the card says as much. Other errors: an unknown `taskId` is `-32001`, a message with no text part (outside a resume) is `-32005`, a message on a task that is not `input-required` and any other shape error are `-32602`, and an unknown method is `-32601`.

Both the Agent Card and the JSON-RPC surface are pinned by [`conformance/a2a/rpc.json`](https://github.com/AimTune/mekik/blob/main/conformance/a2a/rpc.json), replayed by both suites.

## Identity and durability

Every A2A conversation belongs to one mekik user, `"a2a"` by default (`userId` / `UserId`). Conversations are ordinary mekik conversations — persisted in the history store, resumable from the WebSocket side too. Tasks live in an `A2aTaskStore` / `IA2aTaskStore` (in-memory by default; implement the two-method port for durability).

## Security

Like the MCP endpoint, the A2A endpoint carries no authorization of its own; put it behind your gateway. The graph's approvals still gate what a calling agent can make happen — it gets `input-required` and cannot proceed until something answers.

## Where to go next

- [ilmek → A2A](https://ilmek.aimtune.dev/a2a) — the other direction: calling A2A agents (this one included) from a node, journaled.
- [MCP server](./mcp.md) — the same graph as a tool instead of a peer.
