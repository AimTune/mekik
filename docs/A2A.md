# A2A — the graph as a peer agent

mekik serves a graph as an [Agent2Agent](https://a2a-protocol.org) agent
(PROTOCOL.md §14): `MekikA2aServer` in the core does the mapping over any
JSON-RPC transport; `serveA2a` (`@mekik/a2a`) and `MapMekikA2a`
(`Mekik.AspNetCore`) put it behind HTTP with the Agent Card at
`/.well-known/agent-card.json`. Calling A2A agents *from* a graph is ilmek's
job (`@ilmek/a2a` / `Ilmek.A2A`).

The published guide is [website/docs/serving/a2a.md](../website/docs/serving/a2a.md);
this file is the short version plus the design notes.

## The mapping

| A2A | mekik |
|---|---|
| Agent Card | `{ name, description, url, version }` from the options; `skills` = the agent itself (`chat`) + the app's skill summaries |
| `contextId` | a conversation (user `a2a`) |
| task | one turn: `message/send` without `taskId` → connect, `text` frame, collect, disconnect |
| `input-required` task | the turn paused; `status.message` carries the pending interrupts in prose + a data part; `metadata.pending` too |
| `message/send` with `taskId` | the resume: text → the single open interrupt (action label → value); data `{answers}` → several |
| artifact `reply` | the turn's reply text |
| `completed` / `failed` / `rejected` / `canceled` | run finished / graph error / engine refused (`busy`, `interrupted`, `not_interrupted`) / `tasks/cancel` |
| `metadata.mekik` | `{ conversationId, status, toolCalls, skills }` — the MCP summary, reused |

`tasks/get` (with `historyLength`), `tasks/cancel` (input-required only,
`-32002` otherwise), notifications (no response). `message/stream`,
`tasks/resubscribe` and push-notification config are `-32004`. Errors:
`-32001` task not found, `-32005` a message with no text part, `-32602` shape
errors, `-32601` unknown method.

## Design notes

- **Why one turn is one task, not one conversation.** A2A tasks have a
  terminal state; a mekik conversation never ends. `contextId` carries the
  conversation across tasks, exactly like the WebSocket `conversationId`.
- **Why the resume is a message on the task.** That is the protocol's own
  shape for `input-required`; mapping it onto mekik's `resume` frame means the
  same durable pause is answered from either door.
- **Why `tasks/cancel` does not unpark the conversation.** mekik never discards
  a pause on a caller's behalf; a canceled task leaves the interrupt open for a
  mekik client to answer. A later message on that context is `rejected` with
  the engine's `interrupted` text.
- **Why no streaming.** `message/stream` would need SSE and per-frame
  `TaskStatusUpdateEvent`s; the card advertises `streaming: false` so a
  compliant client uses `message/send`. A streaming profile can be added
  additively.
- **Shared machinery.** `driveTurn` / `DriveTurnAsync` and the MCP `summarize`
  reduce the turn; A2A only maps the summary onto a task. `conformance/a2a/rpc.json`
  pins the card and the RPC surface in both languages.

Wire spec: [PROTOCOL.md §14](../PROTOCOL.md#14-a2a-14). Conformance:
`conformance/a2a/rpc.json` plus scenarios 28–30 in
[conformance/README.md](../conformance/README.md).
