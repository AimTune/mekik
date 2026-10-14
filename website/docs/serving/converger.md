---
sidebar_position: 2
title: Behind a hub (Converger)
description: Run a mekik app behind the Converger channel hub — @mekik/converger and Mekik.Converger dial out over one multiplexed WebSocket, and the external-transcript profile hands the transcript, seq and identity to the hub.
---

# Behind a hub (Converger)

[`@mekik/ws`](./transport.md) serves a graph to clients that connect to *you*. **`@mekik/converger`** (TypeScript) and **`Mekik.Converger`** (.NET) turn that around: the mekik process dials **out** to a [Converger](https://github.com/AimTune/converger) hub, and the hub brings it conversations from every channel it routes — the web widget, WhatsApp, Telegram, Slack, email. The hub keeps the durable transcript, issues tokens, hardens the sockets and fans the bot's frames out to the end users; mekik keeps doing what it is for: running the graph.

It is a **deployment profile, not a protocol change** — the frames mekik sends are the same `mekik/1` frames, byte for byte (normative: [`PROTOCOL.md` §15](https://github.com/AimTune/mekik/blob/main/PROTOCOL.md#15-running-behind-a-hub-15-deployment-profile)).

```
end users (widget, WhatsApp, …)  ⇄  Converger  ⇄  one outbound WebSocket  ⇄  @mekik/converger  ⇄  your graph
```

## Setup on the hub

1. A `websocket` channel for the bot (its **secret** is what mekik authenticates with).
2. A routing rule from each end-user channel to the bot channel.

That is all: a `websocket` channel with a connected agent becomes the conversation's *bot channel*, and the end users' bot-only frames (`resume`, `genui_event`, `abort`, …) are forwarded to it.

## Serve it

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
import { externalTranscript, mekik } from "@mekik/core";
import { connectConverger } from "@mekik/converger";

const app = mekik({ graph, reply: (s) => s.reply as string, ...externalTranscript() });
const hub = connectConverger(app, {
    url: "wss://hub.example.com/socket/converger/v1",
    secret: process.env.CONVERGER_BOT_SECRET!, // the bot channel's secret
});
await hub.ready;
```

The refund example runs unchanged behind a hub: `CONVERGER_URL=… CONVERGER_SECRET=… node examples/refund.ts --converger`.

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
using Mekik;

var app = new MekikApp(new MekikOptions { Graph = graph }.WithExternalTranscript());
await using var hub = ConvergerTransport.Connect(app, new ConvergerOptions
{
    Url = "wss://hub.example.com/socket/converger/v1",
    Secret = Environment.GetEnvironmentVariable("CONVERGER_BOT_SECRET"),
});
await hub.Ready;
```

</TabItem>
</Tabs>

## Options

| TypeScript | .NET | default | |
| --- | --- | --- | --- |
| `url` | `Url` | — | the hub's native endpoint, `ws(s)://HOST/socket/converger/v1` |
| `secret` | `Secret` | — | the bot channel's secret; tokens are minted with `POST /api/v1/converger/tokens/generate` (`{"scope":"channel"}`) on every connect and renewed a minute before they expire |
| `token` (string or function) | `Token` / `TokenProvider` | — | a channel-scoped token instead of the secret. A fixed one cannot be renewed: the transport stops when the hub refuses it (close 4401) |
| `apiUrl` | `ApiUrl` | `url`'s origin | where `tokens/generate` lives |
| `group` | `Group` | none | processes in one group share the channel's conversations, each served by one of them |
| `meta` | `Meta` / `MetaFilter` | none | which of a user turn's `metadata` / `meta` keys become the turn's client meta (then `acceptClientMeta` applies) |
| `idleMs` | `IdleTimeout` | 15 min | disconnect a conversation's virtual connection after this long without traffic |
| `maxConcurrentTurns` | `MaxConcurrentTurns` | unlimited | turns running at once across all conversations; the rest wait |
| `maxConversations` | `MaxConversations` | 5000 | conversations whose watermark is remembered for the re-hello |
| `reconnect: { minMs, maxMs }` | `ReconnectMin` / `ReconnectMax` | 500 ms / 30 s | jittered exponential backoff |
| `maxBuffered` | `MaxBuffered` | 10 000 | persistent frames kept while the socket is down |
| `onError` | `OnError` | none | dropped sockets, refused tokens, hub errors about a conversation |

The handle has `ready` / `Ready` (the first `welcome`), `connected`, `conversations` and `close()` / `DisposeAsync()`.

## How a conversation maps onto the engine

Each conversation gets one **virtual connection**, created the first time a frame for it arrives. The transport calls `connect`, `receive` and `disconnect` exactly as `@mekik/ws` does, with a hello it builds itself: the conversation id from the envelope, the user from the turn's `sender.id`, and the hub-verified identity as `meta.auth`.

- **In:** a user message from any channel (`from: "user"` with text, plain or rich) becomes a `text` turn; `resume`, `genui_event`, `client_tools`, `client_skills` and `abort` arrive as the end user sent them. A tapped WhatsApp button that answers an open interrupt arrives as `resume`. Everything else (the bot's own frames, receipts, typing, presence) is ignored.
- **Out:** every frame the engine emits goes back unchanged inside `{conversationId, frame}` — except `welcome`, since the hub has its own handshake. The hub stores the persistent ones and relays the transient ones (`run`, `genui_components`, `skills`, `error`).
- Frames of a conversation enter the engine in order but don't wait for each other's runs, so `abort` stops a running turn and a second turn gets `busy`.

When the socket drops, the transport reconnects with backoff and re-hellos with each conversation's watermark, so the hub replays exactly what was missed. Persistent frames produced meanwhile are buffered and sent after the reconnect; transient ones are dropped rather than delivered stale.

## The external-transcript profile

Behind a hub, mekik is no longer the transcript or the seq authority. `externalTranscript()` / `WithExternalTranscript()` sets four opt-in pieces, and the transport refuses an app without them:

| piece | what it does |
| --- | --- |
| `ExternalTranscriptHistoryStore` | records nothing and replays nothing — the hub does both; seeds the engine's `seq` counter from what the hub reported |
| `HubConversationStore` | answers who owns a conversation from what the hub reported; never creates one |
| `HubAuthenticator` | trusts the identity the hub verified (`credential.meta.auth`), which reaches nodes as `ctx.meta.auth` |
| `echoUserTurns: false` | the user's own `text` turn is not echoed: the hub already stored and delivered it |

The engine still stamps `seq`, continuing the hub's numbering, so it is usually the value the hub assigns — but the hub renumbers on persistence, so treat it as a hint. A `greeting` still goes to a fresh conversation, right after the user's first message.

Nothing changes for apps that don't opt in.

## Parity and conformance

`conformance/converger/refund.json` drives the refund example directly and behind a fake hub, and requires the frames inside the envelope to equal the direct run's in canonical JSON; both `@mekik/converger` and `Mekik.Converger` run it. See [Conformance](../parity/conformance.md).

## Where to go next

- [**Transport (WebSocket)**](./transport.md) — the direct transport this one mirrors.
- [**Persistence**](../persistence.md) — the stores the profile replaces.
- [**Authentication**](../authentication.md) — the port `HubAuthenticator` implements.
