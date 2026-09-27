# @mekik/a2a

A2A transport for [mekik](https://github.com/AimTune/mekik): serve a
`MekikApp` as an [Agent2Agent](https://a2a-protocol.org) agent — an Agent Card
at `/.well-known/agent-card.json` and the A2A JSON-RPC methods over HTTP — so
other agents can send it messages and answer its human-in-the-loop pauses as
`input-required` tasks.

```ts
import { mekik, MekikA2aServer } from "@mekik/core";
import { serveA2a } from "@mekik/a2a";

const app = mekik({ graph, reply: (s) => s.reply as string });
const agent = new MekikA2aServer(app, {
    name: "Support desk",
    description: "Answers questions about orders.",
    url: "https://bot.example.com/a2a",
    skills: catalog.list(),   // optional: the app's skills on the card
});
serveA2a(agent, { port: 8901 });   // GET /.well-known/agent-card.json, POST /a2a
```

One mekik conversation is one A2A `contextId`; one turn is one task. A task
whose run paused for a human is `input-required`, and the next message on that
task answers the pause. `message/send`, `tasks/get` and `tasks/cancel` are
implemented; streaming and push notifications are not (the card says so). Zero
dependencies; `a2aRequestHandler` mounts on any Node server. Wire rules:
PROTOCOL.md §14. Docs: <https://mekik.aimtune.dev/serving/a2a>.
