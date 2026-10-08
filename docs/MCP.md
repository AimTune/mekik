# MCP — both directions

mekik meets the Model Context Protocol twice (PROTOCOL.md §13):

- **Consuming.** An MCP server's tools inside an agent node, with the mekik
  treatment — `tool_call` trace, exactly-once across a pause, approval. The
  connection and the journaled call live in ilmek (`@ilmek/mcp` /
  `Ilmek.Mcp`); mekik adds the agent wrappers: `withMcpTools` in
  `@mekik/langchain`, `McpFunctions.Wrap` in `Mekik.Agents` (or, with the
  official .NET SDK, its `McpClientTool`s straight into `MekikTools.Wrap`).
- **Serving.** A `MekikApp` as an MCP server: `MekikMcpServer` in the core
  (transport-agnostic JSON-RPC), `serveMcp` in `@mekik/mcp` and
  `MapMekikMcp` in `Mekik.AspNetCore` for Streamable HTTP.

The published guides are [website/docs/integrations/mcp.md](../website/docs/integrations/mcp.md)
and [website/docs/serving/mcp.md](../website/docs/serving/mcp.md); this file is
the short version plus the design notes.

## Serving: the mapping

| MCP | mekik |
|---|---|
| `tools/list` | two tools: `<name>` `{message, conversationId?}` and `<name>__resume` `{conversationId, answers}` |
| `tools/call <name>` | connect an in-process connection as user `mcp`, send a `text` frame, collect the turn's frames, disconnect |
| `tools/call <name>__resume` | the same with a `resume` frame |
| result `content[0].text` | the reply · the error text (`isError`) · a description of the open pauses and how to resume |
| result `structuredContent` | `{conversationId, status, reply, pending[], toolCalls[], skills[], frames?}` |
| a refused turn (`error{busy\|interrupted\|not_interrupted}`) | `status: "refused"`, `isError: true`, the engine's message |

`initialize`, `ping`, `tools/list`, `tools/call` and notifications are
implemented; everything else is `-32601`. Argument shape errors are `-32602`;
graph failures are results with `isError` (the tool ran; the agent failed).

## Design notes

- **Why a resume tool instead of blocking.** An MCP call cannot wait for a
  human. Returning the pause as data keeps the durable interrupt exactly as it
  is for the WebSocket side — the same `resume` answers it, from either door.
- **Why the summarizer is pure and shared.** `summarize` / `Summarize` reduce
  frames to the result; both suites pin the same cases, and the JSON-RPC
  surface is pinned by `conformance/mcp/rpc.json`. Conversation ids are minted
  at random, so `tools/call` results are asserted behaviourally, not as fixtures.
- **Why `withMcpTools` uses the toolbox's raw `invoke`.** `withMekikTools`
  already journals under `lc:<name>`; using the toolbox's journaled `call` too
  would only add journal entries.
- **Why MCP tools go to `runAgent` / `Agent.RunAsync` directly.** Every tool mekik
  builds is branded (`isMekikTool` / `MekikTools.IsMekikFunction`), and the wrappers
  pass a branded tool through untouched — so `withMcpTools` / `McpFunctions.Wrap`
  output (and client tools) can join raw tools in `tools`, traced and journaled once.
- **Why the MCP endpoint has no auth of its own.** The protocol subset served
  has no authorization story; the endpoint is meant to sit behind a gateway,
  like any internal tool endpoint. The graph's approvals still gate what a
  calling agent can make happen.

Wire spec: [PROTOCOL.md §13](../PROTOCOL.md#13-mcp-13). Conformance:
`conformance/mcp/rpc.json` plus scenarios 25–27 in
[conformance/README.md](../conformance/README.md).
