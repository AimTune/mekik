// Client tools (PROTOCOL.md §11): the frontend's own UI as part of the toolbox.
// A delivery-scheduling desk where the *client* declares what it can do — open
// its date picker, fire its confetti — and the graph calls those declarations
// like any server tool:
//
//   pick_date  (mode "call",   tags ["scheduling"])  → parks the run; the client's
//                                                      handler answers via resume
//   celebrate  (mode "notify", untagged)             → fire-and-forget event chunk
//   share_location (tags ["geo"])                    → declared, but tag-scoped OUT
//                                                      of this node's toolbox
//   not_on_the_menu                                  → declared, but the server's
//                                                      allowlist policy DROPS it
//
//   node examples/client-tools.ts             # in-memory self-test, exit 0/1
//   node examples/client-tools.ts --serve     # real WebSocket server on :8807
//
// The self-test drives the app the way chativa's connector would — declaring
// tools in `hello.tools`, answering the tool interrupt with the {ok, result}
// envelope — and asserts the exact wire trace, including tag scoping, the
// allowlist, the notify chunk, the error envelope, and exactly-once across the
// pause.

import { channel, END, graph, START } from "@ilmek/core";

import { mekik } from "@mekik/core";
import type { ClientToolDefinition, Connection, OutgoingFrame } from "@mekik/core";
import { serveWs } from "@mekik/ws";

// ── the domain ────────────────────────────────────────────────────────────────

const ORDERS: Record<string, { id: string; earliest: string }> = {
    "ORD-42": { id: "ORD-42", earliest: "2026-08-10" },
};

// Side-effect counter — asserted to be 1, proving the journal memoized the
// lookup across the client-tool pause (a pure-replay engine would double it).
const sideEffects = { get_order: 0 };

// What the scheduling node actually saw in its toolbox — captured so the
// self-test can assert the tag rule and the allowlist from the outside.
let visibleTools: string[] = [];

// ── the graph ─────────────────────────────────────────────────────────────────

const delivery = graph("delivery")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("schedule", async (s, ctx) => {
        const id = s.input.trim();

        // A journaled server-side effect BEFORE the client-tool pause: on the
        // resume pass this returns the recorded order without re-running.
        const order = await mekik.tool(ctx, "get_order", { id }, () => {
            sideEffects.get_order++;
            const found = ORDERS[id];
            if (!found) throw new Error(`no order ${id}`);
            return found;
        });

        // This node's toolbox: client tools tagged "scheduling" — plus untagged
        // ones, which are unrestricted (§11.2). "share_location" is tagged
        // ["geo"], so a different node could use it while this one never sees it;
        // "not_on_the_menu" was dropped by the server's allowlist below.
        visibleTools = mekik.clientTools(ctx, { tags: ["scheduling"] }).map((t) => t.name);

        // The round-trip: parks the run on an interrupt carrying data.tool; the
        // client's handler answers {ok:true, result} through a resume, and the
        // whole wait survives a reconnect or restart like any mekik pause.
        const when = await mekik.callClientTool<{ date: string }>(ctx, "pick_date", { min: order.earliest });

        // Fire-and-forget: streams a `client_tool` event chunk, never parks.
        await mekik.callClientTool(ctx, "celebrate", { level: 2 });

        return { reply: `Delivery booked for ${when.date}.` };
    })
    .edge(START, "schedule")
    .edge("schedule", END)
    .compile();

function makeApp() {
    return mekik({
        graph: delivery,
        input: (frame) => ({ input: frame.data.text }),
        reply: (state) => state.reply as string,
        // The opt-in, in its allowlist form (§11.1): declarations are ignored
        // entirely without this option, and the function pins what survives —
        // a manipulated client cannot smuggle extra tools to a model.
        clientTools: (tools) => tools.filter((t) => ["pick_date", "celebrate", "share_location"].includes(t.name)),
        greeting: () => "Hi! Send an order number and I'll schedule its delivery with your date picker.",
    });
}

// What chativa's connector would declare in `hello.tools` (definitions only —
// the handlers stay in the page; here the self-test plays the handler's part).
const DECLARED: ClientToolDefinition[] = [
    {
        name: "pick_date",
        description: "Open the in-app date picker and let the user choose a delivery date.",
        parameters: {
            type: "object",
            properties: { min: { type: "string", description: "Earliest selectable ISO date" } },
            required: ["min"],
        },
        tags: ["scheduling"],
    },
    { name: "celebrate", description: "Fire the confetti cannon.", mode: "notify" },
    { name: "share_location", description: "Read the device location.", tags: ["geo"] },
    { name: "not_on_the_menu", description: "Declared by the client, refused by the server." },
];

// ── self-test (in-memory, no socket) ──────────────────────────────────────────

class Collector implements Connection {
    readonly id: string;
    readonly frames: OutgoingFrame[] = [];
    constructor(id = "conn-selftest") {
        this.id = id;
    }
    send(frame: OutgoingFrame): void {
        this.frames.push(frame);
    }
    close(): void {}
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

    await app.connect(c, { hello: { tools: DECLARED } });
    c.drain();

    // ── turn 1: the graph reaches for the client's date picker ────────────────
    await app.receive(c, { type: "text", data: { text: "ORD-42" } });
    const t1 = c.drain();
    console.log("turn 1 frames:", t1.map((f) => f.type).join(" → "));

    // The tag rule + the allowlist, observed from inside the node: the
    // scheduling query sees pick_date (tagged "scheduling") and celebrate
    // (untagged ⇒ unrestricted) — not the geo-tagged tool, not the refused one.
    check(visibleTools.join("|") === "pick_date|celebrate", `toolbox is scoped (saw ${visibleTools.join("|")})`);

    check(
        t1.some((f) => f.type === "tool_call" && f.data.name === "pick_date" && f.data.status === "running"),
        "pick_date surfaces as a running tool_call trace",
    );
    const interrupt = t1.find((f) => f.type === "interrupt");
    check(interrupt?.type === "interrupt", "the call parks the run on an interrupt");
    const tool = (interrupt as Extract<OutgoingFrame, { type: "interrupt" }>).data.tool;
    check(tool?.name === "pick_date", "interrupt.data.tool names the tool");
    check(tool?.params?.min === "2026-08-10", "params reach the client (min from the journaled lookup)");
    check((interrupt as Extract<OutgoingFrame, { type: "interrupt" }>).data.actions === undefined, "no chips: the handler answers, not a human");
    check(t1.some((f) => f.type === "run" && f.data.status === "interrupted"), "run ends interrupted");
    const interruptId = (interrupt as Extract<OutgoingFrame, { type: "interrupt" }>).id;

    // ── turn 2: the client's handler answers with the result envelope ─────────
    await app.receive(c, { type: "resume", answers: { [interruptId]: { ok: true, result: { date: "2026-08-15" } } } });
    const t2 = c.drain();
    console.log("turn 2 frames:", t2.map((f) => f.type).join(" → "));

    check(t2.some((f) => f.type === "interrupt_resolved" && f.id === interruptId), "interrupt_resolved for the answered id");
    const completed = t2.find((f) => f.type === "tool_call" && f.data.name === "pick_date" && f.data.status === "completed");
    check(
        completed?.type === "tool_call" && (completed.data.result as { date: string }).date === "2026-08-15",
        "the completed trace carries the handler's result",
    );

    // The notify tool: an event chunk under the reserved name, no second pause.
    // ("chunk" in f is what narrows the union: a rich message frame's `type` is
    // an open string, so the discriminant alone does not.)
    const notify = t2.find(
        (f): f is Extract<OutgoingFrame, { type: "genui" }> =>
            f.type === "genui" && "chunk" in f && f.chunk.type === "event" && f.chunk.name === "client_tool",
    );
    check(notify, "celebrate streams a client_tool event chunk");
    check(
        notify!.chunk.type === "event" &&
            JSON.stringify(notify!.chunk.payload) === JSON.stringify({ name: "celebrate", params: { level: 2 } }),
        "the chunk payload names the tool and carries the params",
    );
    check(!t2.some((f) => f.type === "interrupt"), "notify never parks");

    const reply = t2.find((f) => f.type === "text" && f.from === "bot");
    check(reply?.type === "text" && reply.data.text === "Delivery booked for 2026-08-15.", "the reply uses the client's answer");
    check(t2.some((f) => f.type === "run" && f.data.status === "finished"), "run finishes");

    console.log("side effects:", JSON.stringify(sideEffects));
    check(sideEffects.get_order === 1, `get_order ran once across the pause (was ${sideEffects.get_order})`);

    // ── the error envelope, in a fresh conversation ───────────────────────────
    const app2 = makeApp();
    const c2 = new Collector("conn-selftest-2");
    await app2.connect(c2, { hello: { tools: DECLARED } });
    await app2.receive(c2, { type: "text", data: { text: "ORD-42" } });
    const parked = c2.drain().find((f) => f.type === "interrupt");
    await app2.receive(c2, {
        type: "resume",
        answers: { [(parked as Extract<OutgoingFrame, { type: "interrupt" }>).id]: { ok: false, error: "picker dismissed" } },
    });
    const t3 = c2.drain();
    console.log("error-path frames:", t3.map((f) => f.type).join(" → "));
    check(
        t3.some((f) => f.type === "tool_call" && f.data.status === "error" && f.data.error === "picker dismissed"),
        "an {ok:false} answer surfaces as an error trace",
    );
    check(t3.some((f) => f.type === "run" && f.data.status === "error"), "…and the unhandled throw ends the run in error");

    console.log("\n✅ client-tools self-test passed — declaration, allowlist, tag scoping, the durable round-trip, the notify chunk, the error envelope, and exactly-once all verified");
    return 0;
}

// ── entry point ───────────────────────────────────────────────────────────────

if (process.argv.includes("--serve")) {
    const handle = serveWs(makeApp(), { port: 8807 });
    console.log("mekik client-tools demo on ws://localhost:8807 (any path)");
    console.log("connect with chativa's MekikConnector({ tools: [...] }) and send an order number, e.g. ORD-42");
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
