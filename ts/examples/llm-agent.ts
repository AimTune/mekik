// The same refund desk as `refund.ts`, except nothing is scripted: a real Claude
// model reads the user's message and decides which tools to call, in what order,
// and when it is done. `@mekik/langchain` sits between the model and the tools so
// that every call it makes is
//
//   visible      — each tool call surfaces as a `tool_call` frame, live
//   approvable   — `refund_payment` pauses the graph for a human first
//   exactly-once — the pause replays the node, but journaled tools do not re-run
//
//   ANTHROPIC_API_KEY=sk-ant-… node examples/llm-agent.ts            # one scripted conversation
//   ANTHROPIC_API_KEY=sk-ant-… node examples/llm-agent.ts --serve    # WebSocket server on :8801
//
// Needs a real API key, so this example is deliberately outside the CI test path.

import { channel, graph, END, START } from "@ilmek/core";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { mekik } from "@mekik/core";
import type { Connection, OutgoingFrame } from "@mekik/core";
import { runAgent } from "@mekik/langchain";
import { serveWs } from "@mekik/ws";

// ── the domain ────────────────────────────────────────────────────────────────

interface Order {
    id: string;
    total: number;
    items: string[];
    customer: string;
}

const ORDERS: Record<string, Order> = {
    "ORD-42": { id: "ORD-42", total: 249.9, items: ["Kettle", "Mug"], customer: "CUS-7" },
    "ORD-99": { id: "ORD-99", total: 18.5, items: ["Cable"], customer: "CUS-7" },
};

// Asserted to be 1 each after the pause/resume cycle. This is the whole point:
// the node re-runs on resume, the model is asked again, and yet the refund is
// still charged exactly once because the tool went through `ctx.step`.
const sideEffects = { get_order: 0, refund_payment: 0, customer_tier: 0 };

// ── the tools the model may call ──────────────────────────────────────────────

const getOrder = tool(
    ({ id }) => {
        sideEffects.get_order++;
        const order = ORDERS[id.trim().toUpperCase()];
        if (!order) return `No order named ${id}. Known orders: ${Object.keys(ORDERS).join(", ")}.`;
        return JSON.stringify(order);
    },
    {
        name: "get_order",
        description: "Look up one order by its id (e.g. ORD-42). Returns the total, items and customer.",
        schema: z.object({ id: z.string().describe("The order id, e.g. ORD-42") }),
    },
);

const customerTier = tool(
    ({ customer }) => {
        sideEffects.customer_tier++;
        return customer === "CUS-7" ? "gold" : "standard";
    },
    {
        name: "customer_tier",
        description: "Get a customer's loyalty tier. Gold customers may be refunded without extra checks.",
        schema: z.object({ customer: z.string().describe("The customer id, e.g. CUS-7") }),
    },
);

const refundPayment = tool(
    ({ orderId, amount }) => {
        sideEffects.refund_payment++;
        return `Refunded $${amount} for ${orderId}.`;
    },
    {
        name: "refund_payment",
        description: "Refund money to the customer for an order. Irreversible — only call once you know the amount.",
        schema: z.object({
            orderId: z.string().describe("The order being refunded"),
            amount: z.number().describe("The amount in dollars"),
        }),
    },
);

const SYSTEM = [
    "You are a refund desk agent. Use the tools to answer; never invent order data.",
    "Look the order up before refunding, and refund the order's full total unless the user says otherwise.",
    "When you are done, reply to the customer in one or two short sentences.",
].join(" ");

// ── the graph: one node that lets the model drive ─────────────────────────────

const MAX_TURNS = 6;

// Constructed lazily: `ChatAnthropic` throws on a missing key at construction,
// and we would rather say so ourselves than crash on import.
let llmSingleton: ChatAnthropic | undefined;
function model(): ChatAnthropic {
    llmSingleton ??= new ChatAnthropic({ model: "claude-opus-4-8", maxTokens: 2048 });
    return llmSingleton;
}

const desk = graph("llm-refund")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("agent", async (s, ctx) => ({
        // The whole model↔tool loop — journaled per turn, tools wrapped for
        // visibility + exactly-once, text streamed live — is runAgent. The node
        // just supplies the prompt, the input and the tools.
        reply: await runAgent(ctx, model(), {
            system: SYSTEM,
            input: s.input,
            tools: [getOrder, customerTier, refundPayment],
            maxTurns: MAX_TURNS,
            policy: {
                get_order: { show: true },
                // The one irreversible action: pause the graph and ask a human. The
                // model just sees a tool that takes a while — or, on a decline, a
                // tool result telling it the user said no.
                refund_payment: {
                    show: true,
                    approve: {
                        title: "Approve this refund?",
                        ui: { component: "approval-form", props: {} },
                        denyMessage: "The customer's refund was declined by a human reviewer. Explain that politely.",
                    },
                },
                // Runs, but the customer never sees us checking their tier.
                customer_tier: { show: false },
            },
        }),
    }))
    .edge(START, "agent")
    .edge("agent", END)
    .compile();

function makeApp() {
    return mekik({
        graph: desk,
        input: (frame) => ({ input: frame.data.text }),
        reply: (state) => state.reply as string,
        greeting: () =>
            `Refund desk. Ask me anything about your orders (${Object.keys(ORDERS).join(", ")}) — I'll look them up and refund if you want.`,
    });
}

// ── one scripted conversation against the real API ────────────────────────────

class Collector implements Connection {
    readonly id = "conn-llm";
    readonly frames: OutgoingFrame[] = [];
    send(frame: OutgoingFrame): void {
        this.frames.push(frame);
    }
    close(): void {}
    drain(): OutgoingFrame[] {
        return this.frames.splice(0, this.frames.length);
    }
}

function describe(frames: OutgoingFrame[]): void {
    for (const f of frames) {
        if (f.type === "tool_call") {
            const d = f.data as { name: string; status: string; params?: unknown; result?: unknown };
            console.log(`  tool ${d.name} ${d.status}`, JSON.stringify(d.result ?? d.params ?? {}));
        } else if (f.type === "interrupt") {
            console.log(`  interrupt ${f.id}`, JSON.stringify(f.data.payload));
        } else if (f.type === "text" && f.from === "bot") {
            console.log(`  bot: ${f.data.text}`);
        } else if (f.type === "error") {
            console.log(`  error ${f.data.code}: ${f.data.message ?? ""}`);
        }
    }
}

async function run(): Promise<number> {
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error("Set ANTHROPIC_API_KEY — this example calls the real Claude API.");
        return 1;
    }

    const app = makeApp();
    const c = new Collector();
    await app.connect(c);
    c.drain();

    console.log('turn 1 — user: "I want to refund ORD-42, it arrived broken"');
    await app.receive(c, { type: "text", data: { text: "I want to refund ORD-42, it arrived broken" } });
    const t1 = c.drain();
    describe(t1);

    const interrupt = t1.find((f) => f.type === "interrupt");
    if (!interrupt) {
        // The model may have chosen to ask a clarifying question instead of
        // refunding — a real model is allowed to do that, so this is a soft stop.
        console.log("\nThe model did not reach the refund this run; no approval to answer.");
        return 0;
    }

    console.log(`\nturn 2 — human approves ${interrupt.id}`);
    await app.receive(c, { type: "resume", answers: { [interrupt.id]: { approved: true } } });
    describe(c.drain());

    console.log("\nside effects:", JSON.stringify(sideEffects));
    if (sideEffects.refund_payment !== 1) {
        console.error(`❌ refund_payment ran ${sideEffects.refund_payment}× — the journal did not hold`);
        return 1;
    }
    console.log("✅ a real model drove the tools, a human gated the refund, and it charged exactly once");
    return 0;
}

// ── entry point ───────────────────────────────────────────────────────────────

if (process.argv.includes("--serve")) {
    const handle = serveWs(makeApp(), { port: 8801 });
    console.log("mekik LLM refund desk on ws://localhost:8801 (any path)");
    process.on("SIGINT", () => void handle.close().then(() => process.exit(0)));
} else {
    void run().then(
        (code) => process.exit(code),
        (err) => {
            console.error("\n❌ crashed:\n", err);
            process.exit(1);
        },
    );
}
