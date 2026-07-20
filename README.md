# mekik

**The realtime serving layer for [ilmek](https://www.npmjs.com/package/@ilmek/core) graphs.** mekik turns a
running ilmek graph into a live conversation: a client (the [chativa](https://github.com/AimTune/chativa)
widget) sends user turns and interrupt answers over a WebSocket; the server drives
the graph and streams back text, generative UI, tool traces, and interactive
human-in-the-loop pauses. **One graph run == one conversational turn.**

```
chativa ⇄ @chativa/connector-mekik ⇄ WebSocket ⇄ ConversationEngine ⇄ IlmekAdapter ⇄ ilmek graph
                                                    │ HistoryStore                     │ Checkpointer
                                                    │ ConversationStore                │ (ilmek's own)
                                                    │ Authenticator
```

Two implementations — **TypeScript** (reference) and **.NET** (port) — speak one
byte-identical wire protocol, `mekik/1`, held to that promise by shared golden
fixtures. [`PROTOCOL.md`](PROTOCOL.md) is the normative spec.

## Why

mekik is the successor to a standalone 4-language connector whose protocol was
hand-mirrored "byte-for-byte" across TS, Go, .NET, and Python with no
cross-language test, whose LangGraph human-in-the-loop detection sniffed error
strings, and whose interrupts were a `text`+chips convention answered by "the next
user message." mekik/1 fixes those: it is **ilmek-native** (consumes ilmek's
typed event stream — no error-sniffing), interrupts are **first-class frames**
answered by thread-scoped id (concurrent pauses can't collapse), and parity is
**two languages checked by golden fixtures**, not four checked by hope. See
[`PLAN.md`](PLAN.md) for the full rationale.

## Quickstart (TypeScript)

```ts
import { graph, channel, START, END } from "@ilmek/core";
import { mekik } from "@mekik/core";
import { serveWs } from "@mekik/ws";

const g = graph("refund")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("gate", async (s, ctx) => {
        mekik.ui(ctx, "order-card", { id: s.input });               // stream GenUI
        const ok = await mekik.approve<{ approved: boolean }>(       // pause for a human
            ctx,
            { title: `Refund ${s.input}?` },
            { ui: { component: "approval-form", props: { orderId: s.input } } },
        );
        return { reply: ok.approved ? "refunded" : "cancelled" };
    })
    .edge(START, "gate").edge("gate", END)
    .compile();

const app = mekik({ graph: g, reply: (s) => s.reply as string });
serveWs(app, { port: 8800, path: "/ws" });
```

The single `mekik` export is both the app factory (`mekik({ graph })`) and the
node-authoring helpers (`mekik.ui`, `mekik.tool`, `mekik.approve`, …).

## Layout

```
mekik1/
  PROTOCOL.md            # normative mekik/1 wire spec
  PLAN.md                # design rationale & milestones
  conformance/
    README.md            # language-neutral scenario list
    fixtures/*.json      # golden event→frame fixtures (shared by both suites)
  docs/
    LANGUAGES.md         # TS ↔ .NET naming parity
    HITL.md              # human-in-the-loop authoring guide
  ts/
    packages/core/       # @mekik/core — protocol, mapper, engine, helpers, stores, auth
    packages/ws/         # @mekik/ws — WebSocket transport
    examples/refund.ts   # showcase: tool + GenUI + form approval + resume
  dotnet/
    src/Mekik.Core/         # mirror of @mekik/core
    src/Mekik.AspNetCore/   # app.MapMekik("/ws", app)
    test/Mekik.Core.Tests/  # loads the SAME fixtures
    examples/Mekik.Examples # mirror of the refund showcase
```

mekik depends on ilmek as a published package — [`@ilmek/core`](https://www.npmjs.com/package/@ilmek/core)
on npm and [`Ilmek.Core`](https://www.nuget.org/packages/Ilmek.Core) on NuGet — so
this repo stands alone; no sibling checkout is needed.

## Run it

**TypeScript** (Node ≥ 22; developed on Node 26, uses the built-in `.ts` runner):

```bash
cd ts && pnpm install
pnpm check                                   # build + tests + the refund self-test
node examples/refund.ts --serve              # a real ws://localhost:8800 server (any path)
```

**.NET** (net9.0):

```bash
cd dotnet
dotnet test Mekik.slnx                       # conformance: same fixtures, canonical compare
dotnet run --project examples/Mekik.Examples
```

> Status: the TypeScript side is built and green (golden fixtures + behavioural
> scenarios + the ws transport verified over a real socket). The .NET side is
> written to mirror it; CI is what compiles and verifies it — the conformance
> suite there replays the shared golden fixtures and is what proves the two
> languages produce the identical wire.

## The protocol in one screen

Frames are JSON with a `type` discriminator, over WebSocket. Persistent frames
(`text`, `tool_call`, `genui`, `interrupt`, `interrupt_resolved`) carry a
per-conversation monotonic `seq`, are stored, and replay on reconnect after a
watermark. Transient frames (`welcome`, `run`, `error`) are live-only.

- **GenUI** streams as `genui` frames carrying `AIChunk`s (`ui` / `text` /
  `event`) — the same shape chativa already renders.
- **HITL** is a first-class `interrupt` frame (optionally mounting a form via
  `ui`, with chip `actions` as fallback), answered by a `resume` frame keyed by
  the thread-scoped interrupt `id`, acknowledged by `interrupt_resolved`.
- **Tools** emit `tool_call` running→completed/error traces; the side effect is
  journaled by ilmek so it runs exactly once across an interrupt/resume.

Full details in [`PROTOCOL.md`](PROTOCOL.md); the exact event→frame mapping is
pinned by [`conformance/fixtures/`](conformance/fixtures).

## Parity

The two implementations are held to the same wire two ways:

1. **Golden fixtures** — recorded ilmek event streams plus the exact frames they
   must produce, in canonical JSON. Both `eventToFrames` implementations replay
   them and compare byte-for-byte. This is the closed, machine-checkable core.
2. **Scenario suites** — the multi-frame, multi-run behaviours (handshake, replay,
   fan-out, resume routing, the turn lock, auth), written as ordinary tests in
   each language against the identical observable wire.

See [`docs/LANGUAGES.md`](docs/LANGUAGES.md) for the naming map and
[`docs/HITL.md`](docs/HITL.md) for the human-in-the-loop authoring rules.

## Non-goals (v1)

Horizontal scale / distributed turn lock; transports other than WebSocket; durable
(Redis/Postgres) history stores (ports exist, in-memory ships); a `debug` stream
mode; Go/Python ports. The chativa `@chativa/connector-mekik` upgrade to
`mekik/1` is a separate workstream.

## License

MIT.
