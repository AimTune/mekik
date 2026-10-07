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

## Skills

The desk has a §12 catalog with **tag-scoped skills per route**. Each routed
node asks only for its own tag, so its prompt, its `load_skill` tool and its
skill frames only ever involve its own skills:

| Skill | Tag | Holds | Wired with |
|---|---|---|---|
| `refund-policy` | `billing` | `issue_credit` | `runAgent` + `skillTools` |
| `incident-runbook` | `tech` | `escalate_to_specialist` | `withSkills(ctx, { tags: ["tech"] }, { toolNames })` in a hand-wired loop |

The tech loop is hand-wired because its MCP tools come pre-wrapped by
`withMcpTools`. That is the case `withSkills`' `toolNames` option exists for:
`load_skill` names what it unlocks, and the probe kit's `runTools({ skillTools })`
holds the tool back until then, with the same rule `runAgent` applies.

## What it shows

| # | Scenario | What the probe asserts |
|---|---|---|
| 0 | Startup | MCP `initialize` then `tools/list`. Only `kb__search` is exposed (the server's `search__resume` is not allowed in). The specialist's Agent Card names it and its JSON-RPC transport. The `skills` frame lists `incident-runbook` (tech) and `refund-policy` (billing). |
| 1 | Billing | `get_invoice` and `issue_credit` are traced. `issue_credit` is offered only after `refund-policy` loads, and no tech tool ever is. **Tag scoping:** the billing prompt lists `refund-policy` and not the tech skill, loading `incident-runbook` from billing returns an unknown-skill observation, and the only `skill` frame on the turn is `refund-policy`. No peer is contacted. |
| 2 | Tech → hand-off | The tech node offers `kb__search` (MCP) and its own tools, with escalation held back and no billing tools. `escalate_to_specialist` joins once `incident-runbook` loads, and the load observation names it. **Tag scoping** mirrors billing: the tech prompt doesn't list `refund-policy`, loading it is refused, and the only skill frame is `incident-runbook`. `kb__search` is a `tool_call` trace whose result is the KB agent's reply. Escalating sends one A2A `message/send`, and the specialist returns an `input-required` task. The desk parks on **its own** interrupt carrying the specialist's question and chips. On the human's answer the desk sends exactly one more `message/send` on the same task and context, the task completes, and the specialist reboots once. The resume replays only the hand-off node: no second KB call and no re-emitted trace. |
| 3 | Chat | Only the router asks the model; no tools run. |

The mekik pieces in play:

- a router node
- the `skills` app option
- `runAgent` with `skills: { tags }` and `skillTools`
- `withSkills` with `toolNames` and `mekik.skillsPrompt`
- `withMcpTools` over an `McpToolboxLike`
- `MekikMcpServer` and `MekikA2aServer` (`agentCard()`, `handle()`)
- `mekik.tool` to journal each A2A call
- `mekik.approve` to relay a peer's pause to the desk's human

## Run it

From `ts/` (after `pnpm install && pnpm build`):

```bash
node examples/support-desk/support.ts
```

Each step prints the frames it saw and a `✓` line per assertion, ending with
`✅ support-desk probe passed …`.
