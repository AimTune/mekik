# mekik threat model

This file is read by Anthropic's OSS Scanner. It states what mekik is, where
untrusted input enters, which code matters, what is out of scope, and how we
rate severity. The normative wire specification is [`PROTOCOL.md`](../PROTOCOL.md).

## What mekik is

mekik is a server-side library. An application author embeds it to expose a
compiled [ilmek](https://github.com/AimTune/ilmek) agent graph as a realtime
conversation over WebSocket (the `mekik/1` protocol), and optionally as an MCP
server or an A2A peer. Each inbound user turn starts one graph run; the run's
events are mapped to frames and streamed back to the browser client
(typically the chativa widget).

There are two parity implementations of the same wire:

| Language | Packages | Entry points |
|---|---|---|
| TypeScript (reference) | `ts/packages/core`, `ws`, `langchain`, `redis`, `mcp`, `a2a` | `mekik({ graph })`, `serveWs(app, ...)` |
| .NET (port) | `dotnet/src/Mekik.Core`, `Mekik.AspNetCore`, `Mekik.Agents`, `Mekik.SemanticKernel`, `Mekik.Redis` | `MekikApp`, `MapMekik(...)` |

Both consume ilmek from its published package (npm `@ilmek/core`, NuGet
`Ilmek.Core`); ilmek itself is a separate project and is **out of scope** here.

## Deployment model and trust boundaries

A mekik server is reachable by end users' browsers. The operator trusts:

- the graph author (the application code that calls `mekik.ui`, `mekik.tool`,
  `mekik.approve`, and registers tools, skills and MCP servers), and
- the process environment (configuration, API keys, the Redis instance when
  `@mekik/redis` / `Mekik.Redis` is used).

The operator does **not** trust:

1. **WebSocket clients.** Every inbound frame (`hello`, `text`, `resume`,
   `cancel`, `tool_result`, `client_tools`, ...) is attacker-controlled. This
   is the primary attack surface: frame parsing, session/identity handling,
   the per-conversation turn lock, interrupt (HITL) resumption keyed by id,
   history replay, and client-declared tools.
2. **HTTP requests to the MCP server and A2A endpoints** (`@mekik/mcp`,
   `@mekik/a2a`, and the ASP.NET Core mappings).
3. **Upstream MCP servers the graph connects to** as a client, and the LLM's
   tool-call arguments (prompt injection makes model output
   attacker-influenced). Tool-argument validation and allowlists matter.
4. **Data read back from stores** (history and conversation stores, Redis) is
   trusted only to the extent the store is; deserialising stored frames must
   not grant more than the original frames did.

## Security goals

- **Isolation between conversations and users.** A client must never read,
  resume, cancel, or inject into a conversation or interrupt it does not own.
  The `Authenticator` decides identity; session and thread ids must not be
  guessable or forgeable where the protocol says they are server-issued.
- **Interrupt integrity.** A `resume` must only answer an open interrupt for
  that thread, exactly once, with a payload the graph asked for. Answering a
  closed, foreign, or non-existent interrupt must be rejected.
- **Client tools stay client-scoped.** A client-declared tool (`client_tools`)
  may only be invoked for that client's own run, only when allowlisted, and a
  `tool_result` must only complete a call that client was asked to perform.
- **No server-side code execution or SSRF from the wire.** Frames, tool
  arguments, component props, MCP messages and A2A tasks are data; they must
  not reach `eval`, a shell, reflection-based type loading, or arbitrary URL
  fetches.
- **Bounded resources.** A single client should not be able to exhaust the
  process via unbounded frame size, history growth, pending interrupts, or
  parallel runs beyond the turn lock.
- **Secrets stay server-side.** API keys, tool-trace internals marked hidden,
  and redacted fields must not leak into frames (the SQL example's redaction
  tests show the intended behaviour).

## In scope (priority order)

1. `ts/packages/core/src` and `dotnet/src/Mekik.Core`: engine, frame mapper,
   stores, authenticator, interrupt/resume, turn lock, client tools, skills.
2. `ts/packages/ws/src` and `dotnet/src/Mekik.AspNetCore`: transport,
   handshake, auth hooks, framing limits.
3. `ts/packages/mcp`, `ts/packages/a2a`: serving the graph to other agents and
   consuming MCP servers.
4. `ts/packages/redis`, `dotnet/src/Mekik.Redis`: durable stores.
5. `ts/packages/langchain`, `dotnet/src/Mekik.Agents`,
   `dotnet/src/Mekik.SemanticKernel`: adapters; LLM output handling.

## Out of scope

- `ts/examples/**`, `dotnet/examples/**`, `website/**`, `docs/**`, and
  `conformance/**` (fixtures). Examples are demos; a finding there is welcome
  but low severity unless it shows a library bug.
- ilmek (the graph runtime), chativa (the client widget), and third-party
  dependencies unless mekik reaches the vulnerable path.
- Applications that run untrusted graph code: the graph author is trusted.
- Denial of service that only shows an operator deployed without a reverse
  proxy or rate limiting in front of the socket.

## Severity rubric

| Severity | Examples |
|---|---|
| **Critical** | Unauthenticated remote code execution; any client reading or driving another user's conversation or interrupt; bypass of `Authenticator`; SSRF to arbitrary hosts from a frame or MCP message. |
| **High** | Authenticated cross-conversation access; forging `tool_result` for calls not issued to that client; leaking API keys or hidden tool internals into frames; store deserialisation leading to code execution. |
| **Medium** | Resource exhaustion from a single malformed frame (crashing the process); integrity issues that need a non-default but supported configuration; replay of an already-answered interrupt that changes state. |
| **Low** | Local-only or self-inflicted DoS; verbose error messages without secrets; issues only reachable with a malicious graph author or operator. |
| **Not a vulnerability** | Behaviour that requires editing the graph, the server config, or `node_modules`; the LLM producing bad text without crossing a boundary mekik enforces; example-only weaknesses the library does not share. |

## Reproduction and testing inside the image

The build image has both toolchains and all dependencies, and works offline:

```sh
cd /src/ts && pnpm test
cd /src/dotnet && dotnet test Mekik.slnx -c Release --no-build
```

Both suites replay `conformance/fixtures/*.json` through their mappers, so a
protocol-level finding should come with a fixture or a `node --test` / xUnit
case. Wire-level reproducers are best expressed as a frame sequence (see
`PROTOCOL.md` for the frame catalogue), optionally as a small script against
`serveWs` or the ASP.NET Core test host.

## Report and patch format

- Plain text or Markdown. Name the attacker-controlled input, the code path
  that consumes it (file and function, both languages if parity applies), and
  the boundary it crosses.
- A proposed patch is welcome. Parity matters, so a fix that touches the frame
  mapper or engine in one language should note the mirror location in the
  other (`docs/LANGUAGES.md` has the naming map).
- Reports go to the contact in [`SECURITY.md`](../SECURITY.md).
