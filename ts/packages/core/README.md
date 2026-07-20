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

Docs, the normative protocol spec, and the .NET port: https://github.com/AimTune/mekik

MIT
