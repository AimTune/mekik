# @mekik/mcp

MCP transport for [mekik](https://github.com/AimTune/mekik): expose a
`MekikApp`'s graph as [Model Context Protocol](https://modelcontextprotocol.io)
tools over Streamable HTTP, so another agent can talk to yours — and answer its
human-in-the-loop pauses — through an ordinary MCP client.

```ts
import { mekik, MekikMcpServer } from "@mekik/core";
import { serveMcp } from "@mekik/mcp";

const app = mekik({ graph, reply: (s) => s.reply as string });
const mcp = new MekikMcpServer(app, { name: "support_desk", description: "Answers questions about orders." });
serveMcp(mcp, { port: 8900, path: "/mcp" });
```

Two tools are advertised: `support_desk` runs one turn (`{ message,
conversationId? }`) and returns the reply plus a structured summary; when the
graph pauses for a human, the result lists the open interrupts and
`support_desk__resume` (`{ conversationId, answers }`) continues it. No
dependencies beyond `@mekik/core` — one JSON-RPC message per `POST`, handled by `@mekik/core`'s
`MekikMcpServer`; `mcpRequestHandler` mounts on any Node server. Wire rules:
PROTOCOL.md §13. Docs: <https://mekik.aimtune.dev/serving/mcp>.
