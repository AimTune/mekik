# @mekik/converger

Run a [mekik](https://github.com/AimTune/mekik) app behind the
[Converger](https://github.com/AimTune/converger) channel hub. Like `@mekik/ws`
it only speaks sockets — every protocol rule lives in the engine — but it dials
**out**: one WebSocket from your process to the hub's bot channel, every
conversation multiplexed on it as `{conversationId, frame}`, each one driven
through its own virtual `Connection`.

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

`externalTranscript()` is required: behind a hub, the hub owns the transcript,
the seq space and identity, so the app records nothing, replays nothing, trusts
the hub-verified user and does not echo the user's own turn.

Options: `url`, `secret` (tokens are minted with `tokens/generate` and renewed
before they expire) or `token` (a string, or a function called on every
connect), `apiUrl`, `group` (processes sharing a channel), `meta` (allowlist of a
user turn's `metadata` / `meta` keys), `idleMs` (default 15 min),
`maxConcurrentTurns`, `maxConversations` (default 5000), `reconnect: { minMs,
maxMs }` (default 500 ms to 30 s, full jitter), `maxBuffered` (default 10 000),
`onError`. The handle has `ready`, `connected`, `conversations` and `close()`.

The frames are mekik/1, unchanged (`PROTOCOL.md` §15, pinned by
`conformance/converger/refund.json`). Try it with the refund example:
`CONVERGER_URL=… CONVERGER_SECRET=… node examples/refund.ts --converger`.

Docs: https://mekik.aimtune.dev/serving/converger

MIT
