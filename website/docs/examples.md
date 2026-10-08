---
sidebar_position: 9
title: Examples
description: The runnable examples in the repo — refund (the showcase), the LLM-driven agents, and the one-node-vs-routed-graph pair — what each demonstrates and how to run it.
---

# Examples

The repo ships runnable examples that each exercise the whole stack against a real wire. This page is the tour: what each one demonstrates and how to run it. They live under [`ts/examples/`](https://github.com/AimTune/mekik/tree/main/ts/examples) and [`dotnet/examples/`](https://github.com/AimTune/mekik/tree/main/dotnet/examples).

## The refund showcase

[`refund.ts`](https://github.com/AimTune/mekik/blob/main/ts/examples/refund.ts) is the canonical example — one ilmek graph that demonstrates every mekik feature at once:

- **lookup:** a `get_order` tool trace + an `order-card` GenUI component
- **approve:** a human-in-the-loop pause with a mounted approval form
- **refund:** a second tool + a streamed token + the consolidated reply

```bash
node ts/examples/refund.ts            # in-memory self-test, asserts the exact wire trace
node ts/examples/refund.ts --serve    # a real ws://localhost:8800 server (any path)
```

The self-test drives the app the way a client would and asserts the exact wire trace — including that each tool's side effect runs **exactly once** across the pause/resume cycle (the ilmek journal guarantee). It's the best few-minutes read for seeing the whole protocol in motion. The .NET mirror is [`dotnet/examples/Mekik.Examples`](https://github.com/AimTune/mekik/tree/main/dotnet/examples/Mekik.Examples):

```bash
dotnet run --project dotnet/examples/Mekik.Examples
```

## The LLM-driven agents

These run the same kinds of desk with **nothing scripted** — a real model reads the message and picks the tools itself, while mekik surfaces each call, gates sensitive ones behind a human, and journals both so a resume never charges twice. They call the live API, so they need a key and are kept out of the CI test path:

```bash
ANTHROPIC_API_KEY=sk-ant-… node ts/examples/llm-agent.ts       # refunds
ANTHROPIC_API_KEY=sk-ant-… node ts/examples/sql-agent.ts       # a model writing its own SQL over SQLite
ANTHROPIC_API_KEY=sk-ant-… node ts/examples/weather-agent.ts   # chained network tools, fan-out, recovery
ANTHROPIC_API_KEY=sk-ant-… node ts/examples/concierge.ts       # all three tool groups in one agent
ANTHROPIC_API_KEY=sk-ant-… node ts/examples/routed-desk.ts     # the same desk, as a routed graph
ANTHROPIC_API_KEY=sk-ant-… dotnet run --project dotnet/examples/Mekik.LlmAgent
```

| Example | Demonstrates |
|---|---|
| `llm-agent` | a model driving the refund desk — tools + approval, unscripted |
| `sql-agent` | a model writing and running its own SQL against SQLite, each query a traced tool |
| `weather-agent` | chained network tools against a public HTTP API — fan-out and error recovery |
| `concierge` | all three tool groups (refunds, SQL, weather) in **one** agent, a single node |
| `routed-desk` | the same desk built as a **routed graph** — a router node plus per-domain nodes |

### `--probe` mode: honest without a key

Each of the newer examples has a `--probe` mode that scripts only the model's decisions (and, where relevant, the HTTP layer) and runs the identical graph, tools, and wire path. That's what CI runs — so the examples stay honest without a key or a bill:

```bash
node ts/examples/concierge.ts --probe
dotnet run --project dotnet/examples/Mekik.SqlAgent -- --probe
dotnet run --project dotnet/examples/Mekik.WeatherAgent -- --probe
```

## One node or many? The design argument

`concierge.ts` and `routed-desk.ts` are the **same desk built both ways**, and the pair is the argument for ilmek being a *graph* rather than a loop. The routed version:

- classifies the turn in a **router node**,
- gives each domain its **own node** with only its own tools,
- makes the human-in-the-loop pause a **node of its own**.

That last split has a consequence you can see on the wire: resuming replays **one node**, so the lookup that ran before the pause is neither re-run nor re-emitted — where the single-node version re-sends its `tool_call` frames for a query that never ran again. Both `--probe` modes assert their own behaviour, so the difference is pinned, not just described.

> **The takeaway:** the graph structure isn't cosmetic — it changes what a resume replays, and therefore what the client sees. When a pause should replay as little as possible, give it its own node.

## The rendering showcase

`storefront.ts` is the counterpart to the refund desk: instead of one flow in depth, it emits **every** typed GenUI component and **every** rich message type in three turns — including a progress bar and a step tracker that update *in place*, and a `mekik.choose` button pause.

```bash
node ts/examples/storefront.ts            # self-test: asserts all 13 components + 8 message types on the wire
node ts/examples/storefront.ts --serve    # ws://localhost:8802 — then type "components" or "messages"
```

Its self-test is the executable version of the two authoring guides — [Typed components](./authoring/components.md) and [Rich messages](./authoring/messages.md) — right down to asserting that the three progress-bar emissions share **one** chunk id (an in-place update, not three bars) and that messages replay from the transcript on reconnect.

## The backend owns the widget

`server-components.ts` is the only example whose components are not registered in
the client at all. It defines two of them — `delivery-card` and `shipment-strip` —
on the server, ships them in a `genui_components` frame on connect, and then mounts
them with ordinary `ui` chunks. Adding a widget is a server deploy.

```bash
node ts/examples/server-components.ts            # self-test: catalog, hash cache, in-place updates
node ts/examples/server-components.ts --serve    # ws://localhost:8806 — then type "track ORD-42"

dotnet run --project dotnet/examples/Mekik.ServerComponents --no-launch-profile # the same self-test
dotnet run --project dotnet/examples/Mekik.ServerComponents -- --serve          # ws://localhost:8816/ws
```

The turn is paced on purpose, because the mechanism is otherwise invisible: the
card is re-rendered from *Preparing* to *In transit* under one chunk id, the run then
**pauses** on three chips, and the answer re-renders that same card again. Its
self-test asserts the parts you would otherwise have to squint at in a network log —
that a cached hash gets `unchanged: true` and no markup, that a stale one gets the
full catalog, that four pre-pause `ui` chunks carry two ids, and that the replay
after the resume does **not** re-emit the states the user already watched (each
phase ran inside `ctx.step`).

See [Components the server defines](./authoring/generative-ui.md#components-the-server-defines).

## The frontend owns the tool

`client-tools.ts` is the §11 mirror of that idea: the **client** declares what it
can do — `pick_date` (a round-trip into the page's date picker), `celebrate`
(fire-and-forget confetti), a geo-tagged tool the scheduling node never sees, and
one the server's allowlist refuses — and the graph calls them like server tools.

```bash
node ts/examples/client-tools.ts            # self-test: allowlist, tag scoping, round-trip, notify, error envelope
node ts/examples/client-tools.ts --serve    # ws://localhost:8807 — connect chativa with { tools: [...] }

dotnet run --project dotnet/examples/Mekik.ClientTools   # the same self-test, byte-identical frames
```

The self-test plays the chativa connector's part — declaring in `hello.tools`,
answering the tool interrupt with the `{ok, result}` envelope — and asserts the
whole §11 surface: the node's toolbox is scoped by tag (`pick_date` +
untagged `celebrate`, not the geo-tagged or refused tools), the call parks as a
durable interrupt carrying `data.tool`, the completed `tool_call` trace carries
the client's result, the notify invocation streams as a `client_tool` event
chunk without pausing, an `{ok:false}` answer surfaces as an error trace and
fails the run, and a journaled lookup before the pause runs exactly once.

See [Client tools](./authoring/client-tools.md).

## Domain scenarios

Five more probes put the features above to work in realistic desks — banking, insurance claims, healthcare triage, travel booking and a support desk that talks to other agents over MCP and A2A. Each runs offline against a scripted model and asserts its own frame stream; see [Domain scenarios](./domain-examples.md).

```bash
cd ts && pnpm run examples:domain
```

## Rendering end-to-end

The GenUI components these emit — `data-table`, `weather-card`, `approval-form`, `order-card`, plus the `genui-*` built-ins `storefront` uses — are registered in [chativa's sandbox](https://github.com/AimTune/chativa), so `--serve` renders end to end against a real client. `server-components` is the exception that proves the rule: it needs no registration at all, because it ships its own definitions. To see the full loop: run an example with `--serve`, point chativa's `MekikConnector` at `ws://localhost:8800`, and type an order number (`ORD-42` in the refund example) to trigger the approval flow.

## Running the suites

```bash
# TypeScript: build + tests + every example self-test and probe (domain scenarios included)
cd ts && pnpm check

# .NET: conformance (same fixtures, canonical compare)
cd dotnet && dotnet test Mekik.slnx
```

Both are green in [CI](https://github.com/AimTune/mekik/actions): TypeScript builds, passes the golden fixtures and behavioural scenarios, and runs every example's self-test or probe; .NET builds, replays the same golden fixtures through its own `EventToFrames`, and runs the `SqlAgent` and `WeatherAgent` probes and the `ClientTools` and `ServerComponents` self-tests. See [Conformance](./parity/conformance.md).

## Where to go next

- [**Domain scenarios**](./domain-examples.md) — five realistic desks (banking, insurance, healthcare, travel, support) as offline probes.
- [**Getting started**](./getting-started.md) — build your own server from scratch.
- [**Human-in-the-loop**](./authoring/human-in-the-loop.md) — the pause the refund example is built around.
- [**Agent integrations**](./integrations/overview.md) — how the LLM examples wire their tools.
