// The refund example's graph (ts/examples/refund.ts), for the hub conformance
// scenario (conformance/converger/refund.json). Kept in step with the example;
// the scenario pins the wire it produces, not the example file.

import { channel, command, END, graph, START } from "@ilmek/core";

import { mekik, type MekikApp, type MekikOptions } from "@mekik/core";

interface Order {
    id: string;
    total: number;
    items: string[];
}

const ORDERS: Record<string, Order> = {
    "ORD-42": { id: "ORD-42", total: 249.9, items: ["Kettle", "Mug"] },
};

export const refundGraph = graph("refund")
    .channel("input", channel.lastWrite<string>(""))
    .channel("order", channel.lastWrite<Order | null>(null))
    .channel("reply", channel.lastWrite<string>(""))
    .node("lookup", async (s, ctx) => {
        const id = s.input.trim();
        const order = await mekik.tool(ctx, "get_order", { id }, () => {
            const found = ORDERS[id];
            if (!found) throw new Error(`no order ${id}`);
            return found;
        });
        mekik.ui(ctx, "order-card", { id: order.id, total: order.total, items: order.items });
        return { order };
    })
    .node("approve", async (s, ctx) => {
        const order = s.order!;
        const answer = await mekik.approve<{ approved: boolean }>(
            ctx,
            { title: `Refund $${order.total} for ${order.id}?` },
            {
                ui: { component: "approval-form", props: { orderId: order.id, amount: order.total } },
                actions: [mekik.action("Approve", { approved: true }), mekik.action("Reject", { approved: false })],
            },
        );
        return answer.approved ? command({ goto: "refund" }) : command({ update: { reply: "Refund declined." }, goto: END });
    })
    .node("refund", async (s, ctx) => {
        const order = s.order!;
        await mekik.tool(ctx, "refund_payment", { orderId: order.id }, () => ({ refunded: order.total }));
        ctx.emitToken("Refund processed ✅");
        return { reply: `Refund complete: ${order.id}` };
    })
    .edge(START, "lookup")
    .edge("lookup", "approve")
    .edge("refund", END)
    .compile();

/** The conformance environment: a counting minter and a fixed clock (conformance/README.md). */
export function makeRefundApp(greeting: string, clock: number, extra: Partial<MekikOptions> = {}): MekikApp {
    let msg = 0;
    let stream = 0;
    return mekik({
        graph: refundGraph,
        input: (frame) => ({ input: frame.data.text }),
        reply: (state) => state.reply as string,
        context: (conv) => ({ userId: conv.userId, locale: "en" }),
        greeting: () => greeting,
        minter: { message: () => `msg-${++msg}`, stream: () => `stream-${++stream}` },
        now: () => clock,
        ...extra,
    });
}
