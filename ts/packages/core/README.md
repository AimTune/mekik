# @mekik/core

The realtime serving layer for [ilmek](https://www.npmjs.com/package/@ilmek/core)
graphs. Turns a running ilmek graph into a live conversation: streaming generative
UI, tool traces, and durable, interactive human-in-the-loop over the **`mekik/1`**
wire protocol.

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

Also in this package: server-defined components and rich messages, client tools
and client skills (both opt-in), a skill catalog whose skills can own their
tools, `MekikMcpServer` / `MekikA2aServer` (serve the app as MCP tools or an A2A
agent, with `@mekik/mcp` / `@mekik/a2a` as the HTTP transports), and the
`TurnLock` / `Backplane` ports a fleet fills with `@mekik/redis`.

Docs: https://mekik.aimtune.dev · Protocol spec and the .NET port: https://github.com/AimTune/mekik

MIT
