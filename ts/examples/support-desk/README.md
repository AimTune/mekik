# Support desk

A routed ilmek graph served over mekik that works with two **other** agents,
driven offline by a scripted model. The probe plays the client and asserts its
own frame stream, so it is also an integration test: no network, no API key,
exit code 0 or 1.

```text
START → route ─┬→ billing ─────────────────────────────────────→ END
               ├→ tech ─┬──────────────────────────────────────→ END
               │        └→ handoff (A2A, §14) — may pause ─────→ END
               └→ chat ────────────────────────────────────────→ END
```

Both peers are themselves mekik apps:

- **Knowledge base** — served as MCP tools with `MekikMcpServer` (§13.2) and
  consumed by the `tech` node through `withMcpTools` (§13.1). The desk's MCP
  client lists the server's tools once and exposes only `search`, as
  `kb__search`.
- **Network specialist** — served as an A2A agent with `MekikA2aServer` (§14).
  The desk reads its Agent Card and hands a case over with `message/send`.

The probe reaches both through a JSON-RPC seam that serializes every request
and response, so it exercises the real message shapes without a socket. In
production that seam is an HTTP POST to `serveMcp` / `serveA2a`.

## What it shows

| # | Scenario | What the probe asserts |
|---|---|---|
| 0 | Startup | MCP `initialize` then `tools/list`; only `kb__search` is exposed (the server's `search__resume` is not allowed in); the specialist's Agent Card names it and its JSON-RPC transport. |
| 1 | Billing | `get_invoice` and `issue_credit` are traced; the billing node bound only billing tools; no peer was contacted. |
| 2 | Tech → hand-off | The tech node bound `kb__search` plus its own tools and no billing tools. `kb__search` is a `tool_call` trace whose result is the KB agent's reply (one `tools/call`, one search inside the KB app, whose own trace stays in its own conversation). Escalating sends one A2A `message/send`; the specialist runs its line test and returns an `input-required` task. The desk parks on **its own** interrupt carrying the specialist's question and chips. On the human's answer the desk sends exactly one more `message/send` on the same task and context (the hand-off is journaled, not resent), the task completes, the specialist reboots once, and the desk relays its answer. The resume replays only the hand-off node: no second KB call, no re-emitted `kb__search` trace. |
| 3 | Chat | Only the router asks the model; no tools run. |

The mekik pieces in play: a router node, per-node `withMekikTools` sets,
`withMcpTools` over an `McpToolboxLike`, `MekikMcpServer` and
`MekikA2aServer` (`agentCard()`, `handle()`), `mekik.tool` to journal each A2A
call, and `mekik.approve` to relay a peer's pause to the desk's human.

## Run it

From `ts/` (after `pnpm install && pnpm build`):

```bash
node examples/support-desk/support.ts
```

Each step prints the frames it saw and a `✓` line per assertion, ending with
`✅ support-desk probe passed …`.
