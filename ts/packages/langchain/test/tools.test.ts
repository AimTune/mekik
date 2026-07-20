// Drives real LangChain tools through a real ilmek graph and the real mekik
// engine, then asserts on the frames a client would actually receive — the
// policy is only meaningful in terms of what reaches the wire.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { tool as lcTool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { channel, END, graph, InMemoryCheckpointer, START } from "@ilmek/core";

import { mekik } from "@mekik/core";
import type { Connection, OutgoingFrame } from "@mekik/core";

import { REDACTED, withMekikTools } from "../src/index.ts";

// ── harness ───────────────────────────────────────────────────────────────────

class FakeConn implements Connection {
    readonly id = "c-1";
    readonly sent: OutgoingFrame[] = [];
    send(f: OutgoingFrame): void {
        this.sent.push(f);
    }
    close(): void {}
    drain(): OutgoingFrame[] {
        return this.sent.splice(0, this.sent.length);
    }
}

type ToolFrame = Extract<OutgoingFrame, { type: "tool_call" }>;
const toolCalls = (fs: OutgoingFrame[]): ToolFrame[] => fs.filter((f): f is ToolFrame => f.type === "tool_call");
const named = (fs: OutgoingFrame[], name: string): ToolFrame[] => toolCalls(fs).filter((f) => f.data.name === name);

/**
 * Build a LangChain tool as a plain `StructuredToolInterface`. LangChain's
 * `tool()` is generic enough that its inferred type fights this repo's strict
 * `exactOptionalPropertyTypes`; the casts belong here, in one place, rather than
 * at every call site — the library itself is typed without them.
 */
function mkTool(
    name: string,
    description: string,
    schema: z.ZodTypeAny,
    fn: (input: any) => Promise<unknown>,
): StructuredToolInterface {
    return lcTool(fn as never, { name, description, schema: schema as never }) as unknown as StructuredToolInterface;
}

/** Counts real executions, so "exactly-once" is measured, not assumed. */
function makeTools() {
    const calls = { get_order: 0, refund_payment: 0, internal_lookup: 0, charge: 0 };

    const getOrder = mkTool("get_order", "Look up an order", z.object({ id: z.string() }), async ({ id }) => {
        calls.get_order++;
        return { id, total: 249.9 };
    });

    const refundPayment = mkTool("refund_payment", "Refund an order", z.object({ orderId: z.string() }), async ({ orderId }) => {
        calls.refund_payment++;
        return { refunded: true, orderId };
    });

    const internalLookup = mkTool("internal_lookup", "Internal risk check", z.object({}), async () => {
        calls.internal_lookup++;
        return { risk: "low" };
    });

    const charge = mkTool(
        "charge",
        "Charge a card",
        z.object({ cardNumber: z.string(), amount: z.number() }),
        async ({ cardNumber, amount }) => {
            calls.charge++;
            return { ok: true, cardNumber, amount };
        },
    );

    return { calls, getOrder, refundPayment, internalLookup, charge };
}

/** A graph whose node "is" the agent: it calls the wrapped tools directly. */
function makeApp(body: (tools: ReturnType<typeof makeTools>, ctx: any) => Promise<string>) {
    const t = makeTools();
    const g = graph("agent")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("agent", async (_s, ctx) => ({ reply: await body(t, ctx) }))
        .edge(START, "agent")
        .edge("agent", END)
        .compile();

    const app = mekik({
        graph: g,
        checkpointer: new InMemoryCheckpointer(),
        reply: (s) => s.reply as string,
    });
    return { app, tools: t };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("withMekikTools — visibility", () => {
    test("a shown tool reaches the wire as running → completed", async () => {
        const { app } = makeApp(async (t, ctx) => {
            const [getOrder] = withMekikTools(ctx, [t.getOrder], { get_order: { show: true } });
            await getOrder!.invoke({ id: "ORD-42" });
            return "done";
        });
        const c = new FakeConn();
        await app.connect(c);
        c.drain();
        await app.receive(c, { type: "text", data: { text: "go" } });

        const frames = named(c.sent, "get_order");
        assert.deepEqual(frames.map((f) => f.data.status), ["running", "completed"]);
        assert.deepEqual(frames[0]!.data.params, { id: "ORD-42" });
        assert.deepEqual(frames[1]!.data.result, { id: "ORD-42", total: 249.9 });
        // running and completed are the same call, upserted by id.
        assert.equal(frames[0]!.data.id, frames[1]!.data.id);
    });

    test("show:false runs the tool but emits nothing", async () => {
        const { app, tools } = makeApp(async (t, ctx) => {
            const [lookup] = withMekikTools(ctx, [t.internalLookup], { internal_lookup: { show: false } });
            await lookup!.invoke({});
            return "done";
        });
        const c = new FakeConn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "go" } });

        assert.equal(named(c.sent, "internal_lookup").length, 0, "no trace surfaced");
        assert.equal(tools.calls.internal_lookup, 1, "but the tool did run");
    });

    test("redact masks the surfaced params and result, not the tool's own input", async () => {
        let seenByTool = "";
        const { app } = makeApp(async (t, ctx) => {
            const [charge] = withMekikTools(ctx, [t.charge], { charge: { show: true, redact: ["cardNumber"] } });
            const out = (await charge!.invoke({ cardNumber: "4111111111111111", amount: 10 })) as { cardNumber: string };
            seenByTool = out.cardNumber;
            return "done";
        });
        const c = new FakeConn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "go" } });

        const frames = named(c.sent, "charge");
        assert.equal((frames[0]!.data.params as Record<string, unknown>).cardNumber, REDACTED);
        assert.equal((frames[0]!.data.params as Record<string, unknown>).amount, 10, "non-redacted field survives");
        assert.equal((frames[1]!.data.result as Record<string, unknown>).cardNumber, REDACTED);
        assert.equal(seenByTool, "4111111111111111", "the tool itself still got the real value");
    });

    test("a failing tool surfaces status error and rethrows", async () => {
        const boom = mkTool("boom", "fails", z.object({}), async () => {
            throw new Error("upstream down");
        });

        const g = graph("agent")
            .channel("input", channel.lastWrite<string>(""))
            .channel("reply", channel.lastWrite<string>(""))
            .node("agent", async (_s, ctx) => {
                const [t] = withMekikTools(ctx, [boom]);
                await t!.invoke({});
                return { reply: "unreachable" };
            })
            .edge(START, "agent")
            .edge("agent", END)
            .compile();

        const app = mekik({ graph: g, checkpointer: new InMemoryCheckpointer(), reply: (s) => s.reply as string });
        const c = new FakeConn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "go" } });

        const frames = named(c.sent, "boom");
        assert.equal(frames.at(-1)!.data.status, "error");
        assert.match(String(frames.at(-1)!.data.error), /upstream down/);
        assert.ok(c.sent.some((f) => f.type === "run" && f.data.status === "error"), "the run ends error");
    });
});

describe("withMekikTools — approval + exactly-once", () => {
    test("approve pauses before the tool runs, and the answer lets it through once", async () => {
        const { app, tools } = makeApp(async (t, ctx) => {
            const [getOrder, refund] = withMekikTools(ctx, [t.getOrder, t.refundPayment], {
                get_order: { show: true },
                refund_payment: { show: true, approve: true },
            });
            const order = (await getOrder!.invoke({ id: "ORD-42" })) as { id: string };
            await refund!.invoke({ orderId: order.id });
            return `refunded ${order.id}`;
        });
        const c = new FakeConn();
        await app.connect(c);
        c.drain();

        // Turn 1: get_order runs, then the graph parks on the refund approval.
        await app.receive(c, { type: "text", data: { text: "refund ORD-42" } });
        const t1 = c.drain();
        assert.deepEqual(named(t1, "get_order").map((f) => f.data.status), ["running", "completed"]);
        assert.equal(named(t1, "refund_payment").length, 0, "refund has not run yet");

        const interrupt = t1.find((f) => f.type === "interrupt");
        assert.ok(interrupt && interrupt.type === "interrupt");
        assert.equal((interrupt.data.payload as { tool: string }).tool, "refund_payment");
        assert.deepEqual(interrupt.data.actions?.map((a) => a.label), ["Approve", "Reject"]);
        assert.equal(tools.calls.refund_payment, 0, "the effect is gated behind the pause");

        // Turn 2: approve → the refund runs and completes.
        await app.receive(c, { type: "resume", answers: { [interrupt.id]: { approved: true } } });
        const t2 = c.drain();
        assert.deepEqual(named(t2, "refund_payment").map((f) => f.data.status), ["running", "completed"]);
        assert.ok(t2.some((f) => f.type === "run" && f.data.status === "finished"));

        // The point: the node re-ran from the top on resume, but neither effect doubled.
        assert.equal(tools.calls.get_order, 1, "get_order journaled — not re-invoked on replay");
        assert.equal(tools.calls.refund_payment, 1, "refund ran exactly once");
    });

    test("rejecting returns an observation to the agent and never runs the tool", async () => {
        const { app, tools } = makeApp(async (t, ctx) => {
            const [refund] = withMekikTools(ctx, [t.refundPayment], {
                refund_payment: { approve: { title: "Refund $249.90?", denyMessage: "User said no." } },
            });
            return String(await refund!.invoke({ orderId: "ORD-42" }));
        });
        const c = new FakeConn();
        await app.connect(c);
        c.drain();

        await app.receive(c, { type: "text", data: { text: "refund" } });
        const interrupt = c.drain().find((f) => f.type === "interrupt");
        assert.ok(interrupt && interrupt.type === "interrupt");
        assert.equal((interrupt.data.payload as { title: string }).title, "Refund $249.90?");

        await app.receive(c, { type: "resume", answers: { [interrupt.id]: { approved: false } } });
        const t2 = c.drain();

        assert.equal(tools.calls.refund_payment, 0, "declined tools never execute");
        assert.equal(named(t2, "refund_payment").length, 0, "and emit no trace");
        // The agent got a plain observation back, so its loop can continue.
        const reply = t2.find((f) => f.type === "text" && f.from === "bot");
        assert.ok(reply && reply.type === "text" && reply.data.text === "User said no.");
    });

    test("two approving tools in one node keep distinct interrupt ids", async () => {
        const { app } = makeApp(async (t, ctx) => {
            const [refund, charge] = withMekikTools(ctx, [t.refundPayment, t.charge], {
                refund_payment: { approve: true },
                charge: { approve: true },
            });
            await refund!.invoke({ orderId: "A" });
            await charge!.invoke({ cardNumber: "4111", amount: 1 });
            return "done";
        });
        const c = new FakeConn();
        await app.connect(c);
        c.drain();

        // Sequential awaits mean one pause at a time; answering the first must
        // surface the second rather than resolving both.
        await app.receive(c, { type: "text", data: { text: "go" } });
        const first = c.drain().find((f) => f.type === "interrupt");
        assert.ok(first && first.type === "interrupt");
        assert.equal((first.data.payload as { tool: string }).tool, "refund_payment");

        await app.receive(c, { type: "resume", answers: { [first.id]: { approved: true } } });
        const second = c.drain().find((f) => f.type === "interrupt");
        assert.ok(second && second.type === "interrupt");
        assert.equal((second.data.payload as { tool: string }).tool, "charge");
        assert.notEqual(second.id, first.id, "distinct pauses must be separately addressable");
    });
});
