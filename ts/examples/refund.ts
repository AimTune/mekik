// The showcase: a refund-approval agent served over mekik (PROTOCOL.md §7 walk-
// through). One ilmek graph demonstrates every mekik feature at once —
//
//   lookup:  a tool trace (get_order) + a GenUI card (order-card)
//   approve: a human-in-the-loop pause with a mounted approval form
//   refund:  a second tool + a streamed token + the consolidated reply
//
//   node examples/refund.ts             # in-memory self-test, exit 0/1 (no socket)
//   node examples/refund.ts --serve     # real WebSocket server on :8800
//
// The self-test drives the app the way a client would and asserts the exact wire
// trace, including that each tool's side effect runs exactly once across the
// pause/resume cycle (the ilmek journal guarantee).

import { channel, command, END, graph, START } from "@ilmek/core";

import { mekik } from "@mekik/core";
import type { Connection, OutgoingFrame } from "@mekik/core";
import { serveWs } from "@mekik/ws";

// ── the domain ────────────────────────────────────────────────────────────────

interface Order {
    id: string;
    total: number;
    items: string[];
}

const ORDERS: Record<string, Order> = {
    "ORD-42": { id: "ORD-42", total: 249.9, items: ["Kettle", "Mug"] },
};

// Side-effect counters — the self-test asserts each ran exactly once, proving the
// journal memoized them across the interrupt (a pure-replay engine would double).
const sideEffects = { get_order: 0, refund_payment: 0 };

// ── the graph ─────────────────────────────────────────────────────────────────

const refund = graph("refund")
    .channel("input", channel.lastWrite<string>(""))
    .channel("order", channel.lastWrite<Order | null>(null))
    .channel("reply", channel.lastWrite<string>(""))
    .node("lookup", async (s, ctx) => {
        const id = s.input.trim();
        const order = await mekik.tool(ctx, "get_order", { id }, () => {
            sideEffects.get_order++;
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
                actions: [
                    { label: "Approve", value: { approved: true } },
                    { label: "Reject", value: { approved: false } },
                ],
            },
        );
        return answer.approved
            ? command({ goto: "refund" })
            : command({ update: { reply: "Refund declined." }, goto: END });
    })
    .node("refund", async (s, ctx) => {
        const order = s.order!;
        await mekik.tool(ctx, "refund_payment", { orderId: order.id }, () => {
            sideEffects.refund_payment++;
            return { refunded: order.total };
        });
        ctx.emitToken("Refund processed ✅");
        return { reply: `Refund complete: ${order.id}` };
    })
    .edge(START, "lookup")
    .edge("lookup", "approve")
    .edge("refund", END)
    .compile();

function makeApp() {
    return mekik({
        graph: refund,
        input: (frame) => ({ input: frame.data.text }),
        reply: (state) => state.reply as string,
        context: (conv) => ({ userId: conv.userId, locale: "en" }), // → ctx.meta.mekik
        greeting: () =>
            `Hi! Send an order number to start a refund. Available orders: ${Object.keys(ORDERS).join(", ")}.`,
    });
}

// ── self-test (in-memory, no socket) ──────────────────────────────────────────

class Collector implements Connection {
    readonly id = "conn-selftest";
    readonly frames: OutgoingFrame[] = [];
    send(frame: OutgoingFrame): void {
        this.frames.push(frame);
    }
    close(): void {}
    /** Frames captured since the last drain, then cleared — one turn's worth. */
    drain(): OutgoingFrame[] {
        return this.frames.splice(0, this.frames.length);
    }
}

function check(cond: unknown, msg: string): void {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function selftest(): Promise<number> {
    const app = makeApp();
    const c = new Collector();

    await app.connect(c);
    const welcome = c.drain().find((f) => f.type === "welcome");
    check(welcome?.type === "welcome" && welcome.data.protocol === "mekik/1", "welcome announces mekik/1");

    // ── turn 1: the user asks to refund ORD-42 ────────────────────────────────
    await app.receive(c, { type: "text", data: { text: "ORD-42" } });
    const t1 = c.drain();
    const types1 = t1.map((f) => f.type);
    console.log("turn 1 frames:", types1.join(" → "));

    const toolRunning = t1.find((f) => f.type === "tool_call" && f.data.name === "get_order" && f.data.status === "running");
    const toolDone = t1.find((f) => f.type === "tool_call" && f.data.name === "get_order" && f.data.status === "completed");
    check(toolRunning && toolDone, "get_order tool trace (running → completed)");
    const card = t1.find((f) => f.type === "genui" && f.chunk.type === "ui" && f.chunk.component === "order-card");
    check(card, "order-card GenUI chunk");

    const interrupt = t1.find((f) => f.type === "interrupt");
    check(interrupt?.type === "interrupt" && interrupt.data.ui?.component === "approval-form", "interrupt mounts approval-form");
    check(interrupt?.type === "interrupt" && (interrupt.data.payload as { title: string }).title === "Refund $249.9 for ORD-42?", "interrupt title");
    const runInterrupted = t1.some((f) => f.type === "run" && f.data.status === "interrupted");
    check(runInterrupted, "run ends interrupted");
    const interruptId = (interrupt as Extract<OutgoingFrame, { type: "interrupt" }>).id;

    // A new turn while parked is refused (§5.4).
    await app.receive(c, { type: "text", data: { text: "hello?" } });
    const refused = c.drain().find((f) => f.type === "error");
    check(refused?.type === "error" && refused.data.code === "interrupted", "new turn while parked is refused");

    // ── turn 2: the human approves ────────────────────────────────────────────
    await app.receive(c, { type: "resume", answers: { [interruptId]: { approved: true } } });
    const t2 = c.drain();
    console.log("turn 2 frames:", t2.map((f) => f.type).join(" → "));

    const resolved = t2.find((f) => f.type === "interrupt_resolved");
    check(resolved?.type === "interrupt_resolved" && resolved.id === interruptId, "interrupt_resolved for the answered id");
    const refundTool = t2.find((f) => f.type === "tool_call" && f.data.name === "refund_payment");
    check(refundTool, "refund_payment tool trace");
    const token = t2.find((f) => f.type === "genui" && f.chunk.type === "text");
    check(token, "streamed token chunk");
    const reply = t2.find((f) => f.type === "text" && f.from === "bot");
    check(reply?.type === "text" && reply.data.text === "Refund complete: ORD-42", "consolidated reply text");
    check(t2.some((f) => f.type === "run" && f.data.status === "finished"), "run finishes");

    // ── the point: each side effect ran exactly once across the pause ─────────
    console.log("side effects:", JSON.stringify(sideEffects));
    check(sideEffects.get_order === 1, `get_order ran once (was ${sideEffects.get_order})`);
    check(sideEffects.refund_payment === 1, `refund_payment ran once (was ${sideEffects.refund_payment})`);

    console.log("\n✅ refund self-test passed — genui, tool traces, form approval, resume, and exactly-once all verified");
    return 0;
}

// ── entry point ───────────────────────────────────────────────────────────────

if (process.argv.includes("--serve")) {
    // No `path` filter: accept the upgrade on any path (chativa's connector may
    // point at /ws, /chat, …), so the demo just connects.
    const handle = serveWs(makeApp(), { port: 8800 });
    console.log("mekik refund demo on ws://localhost:8800 (any path)");
    console.log('send: {"type":"text","data":{"text":"ORD-42"}}  then resume with the interrupt id');
    process.on("SIGINT", () => void handle.close().then(() => process.exit(0)));
} else {
    void selftest().then(
        (code) => process.exit(code),
        (err) => {
            console.error("\n❌ self-test crashed:\n", err);
            process.exit(1);
        },
    );
}
