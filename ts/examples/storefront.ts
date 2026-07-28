// storefront — the rendering showcase: every typed GenUI component and every
// rich message type mekik knows about chativa, emitted from one graph.
//
// The point it proves: a component is a *client-registered name plus a props
// object*, and a message is a *renderer name plus a data object*. `mekik.genui.*`
// and `mekik.messages.*` only bind the name and type the payload — the wire is
// the same JSON either way. Nothing here writes a frame by hand.
//
//   node examples/storefront.ts            # self-test (no socket)
//   node examples/storefront.ts --serve    # ws://localhost:8802 for chativa
//
// Turns:
//   "components"  → all 13 chativa GenUI components, plus a progress bar and a
//                   step tracker that update *in place* via mount handles
//   "messages"    → all 8 chativa message types, as persistent transcript entries
//   anything else → a typed button pause (mekik.choose), answered by resume

import { channel, END, graph, START } from "@ilmek/core";

import { mekik } from "../packages/core/src/index.ts";
import type { Connection, MessageOutFrame, OutgoingFrame } from "../packages/core/src/index.ts";
import { serveWs } from "../packages/ws/src/index.ts";

// ── the graph ─────────────────────────────────────────────────────────────────

const PRODUCTS = [
    { sku: "KTL-1", name: "Kettle", price: 49.9, image: "https://cdn.example/kettle.png" },
    { sku: "MUG-7", name: "Mug", price: 12.5, image: "https://cdn.example/mug.png" },
];

/** Every GenUI component chativa registers out of the box, in one turn. */
function showComponents(ctx: Parameters<typeof mekik.ui>[0]): void {
    const g = mekik.genui;

    g.text(ctx, { content: "**Your account** — everything at a glance." });
    g.alert(ctx, { variant: "info", title: "Heads up", message: "One item ships separately." });
    g.card(ctx, {
        title: "ORD-42",
        description: "2 items · $249.90",
        image: "https://cdn.example/orders/ORD-42.png",
        actions: [{ label: "Track", value: "/track ORD-42" }],
    });
    g.list(ctx, {
        title: "What happens next",
        ordered: true,
        items: [
            { text: "We receive the item", secondary: "1–3 business days" },
            { text: "Refund is issued", secondary: "Within 24h of receipt" },
        ],
    });
    g.table(ctx, {
        title: "Recent orders",
        columns: ["Order", "Date", "Total"],
        rows: [
            ["ORD-42", "2026-07-14", 249.9],
            ["ORD-38", "2026-06-30", 89.0],
        ],
    });
    g.chart(ctx, {
        type: "line",
        title: "Spend, last 4 months",
        labels: ["Apr", "May", "Jun", "Jul"],
        datasets: [{ label: "You", data: [140, 80, 260, 249], color: "#7c3aed" }],
    });
    g.imageGallery(ctx, {
        columns: 2,
        images: PRODUCTS.map((p) => ({ src: p.image, alt: p.name, caption: p.name })),
    });
    g.rating(ctx, { title: "Seller rating", value: 4.5, readonly: true });
    g.datePicker(ctx, { label: "Pick a delivery date", min: "2026-08-01", max: "2026-08-31" });
    g.quickReplies(ctx, {
        label: "Anything else?",
        items: [
            { label: "Track my order", value: "/track" },
            { label: "Talk to a human", value: "/agent" },
        ],
    });
    g.form(ctx, {
        title: "Where should we ship it?",
        buttonText: "Save",
        fields: [{ name: "address", label: "Address", type: "text", required: true }],
    });

    // The two that earn their keep by *updating*: mount once, then advance.
    // Both handles re-emit the same chunk id, so the client updates one element
    // instead of stacking three bars and three trackers.
    const bar = g.progress.mount(ctx, { label: "Preparing your order", value: 0 });
    const tracker = g.steps.mount(ctx, {
        steps: [
            { label: "Requested", status: "active" },
            { label: "Packed", status: "pending" },
            { label: "Shipped", status: "pending" },
        ],
    });
    bar.update({ label: "Preparing your order", value: 60, caption: "Packed" });
    tracker.update({
        steps: [
            { label: "Requested", status: "done" },
            { label: "Packed", status: "done" },
            { label: "Shipped", status: "active" },
        ],
    });
    bar.update({ label: "Preparing your order", value: 100, variant: "success" });
}

/** Every chativa message type, in one turn. Each lands as its own persistent frame. */
function showMessages(ctx: Parameters<typeof mekik.ui>[0]): void {
    const m = mekik.messages;

    m.text(ctx, {
        text: "Here's the returns policy you asked about:",
        urls: ["https://example.com/returns-policy"],
        previewVariant: "expanded",
    });
    m.image(ctx, {
        src: "https://cdn.example/receipts/ORD-42.png",
        alt: "Receipt for ORD-42",
        caption: "Your receipt",
    });
    m.card(
        ctx,
        {
            title: "ORD-42",
            subtitle: "2 items · $249.90 · delivered",
            image: "https://cdn.example/orders/ORD-42.png",
            buttons: [
                { label: "Track", value: "/track ORD-42" },
                { label: "Return", value: "/return ORD-42" },
            ],
        },
        { id: "card-ORD-42" }, // a stable, addressable message id
    );
    m.carousel(ctx, {
        cards: PRODUCTS.map((p) => ({
            title: p.name,
            subtitle: `$${p.price}`,
            image: p.image,
            buttons: [{ label: "Add to cart", value: `/add ${p.sku}` }],
        })),
    });
    m.buttons(ctx, {
        text: "What would you like to do?",
        persistent: true,
        buttons: [
            { label: "Track an order", value: "/track" },
            { label: "Start a return", value: "/return" },
            { label: "Something else" }, // no value → the label is sent
        ],
    });
    m.quickReply(ctx, {
        text: "Did that solve it?",
        actions: [{ label: "Yes, thanks" }, { label: "No", value: "/agent" }],
        keepActions: true,
    });
    m.file(ctx, {
        url: "https://cdn.example/invoices/ORD-42.pdf",
        name: "invoice-ORD-42.pdf",
        size: 248_320,
        mimeType: "application/pdf",
    });
    m.video(ctx, {
        src: "https://cdn.example/howto/return-packing.mp4",
        poster: "https://cdn.example/howto/return-packing.jpg",
        caption: "How to pack your return",
    });
}

const storefront = graph("storefront")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("desk", async (s, ctx) => {
        const ask = s.input.trim().toLowerCase();

        if (ask === "components") {
            showComponents(ctx);
            return { reply: "That's every GenUI component chativa ships with." };
        }
        if (ask === "messages") {
            showMessages(ctx);
            return { reply: "That's every chativa message type." };
        }

        // Anything else: a typed button pause. The options carry their own answer
        // type — no hand-written `{label, value}` JSON, no manual generic.
        const pick = await mekik.choose(ctx, "What would you like to see?", [
            mekik.action("Components", "components"),
            mekik.action("Messages", "messages"),
        ]);
        return { reply: `Say "${pick}" and I'll show you.` };
    })
    .edge(START, "desk")
    .edge("desk", END)
    .compile();

function makeApp() {
    return mekik({
        graph: storefront,
        input: (frame) => ({ input: frame.data.text }),
        reply: (state) => state.reply as string,
        // A greeting is not limited to a paragraph: it takes a list of described
        // messages, each landing as its own persistent frame (and replaying on
        // reconnect), so the first impression can be a card with buttons.
        greeting: () => [
            "Welcome to the storefront demo.",
            mekik.messages.buttons.spec({
                text: "What would you like to see?",
                buttons: [
                    { label: "Components", value: "components" },
                    { label: "Messages", value: "messages" },
                ],
            }),
        ],
    });
}

// ── self-test (in-memory, no socket) ──────────────────────────────────────────

let collectorSeq = 0;

class Collector implements Connection {
    // One id per instance: the reconnect check below opens a second connection,
    // and two live connections sharing an id would collide in the engine's map.
    readonly id = `conn-selftest-${++collectorSeq}`;
    readonly frames: OutgoingFrame[] = [];
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

/** The `component` name of every genui ui chunk in a turn, in emit order. */
function components(frames: OutgoingFrame[]): string[] {
    return frames
        .filter((f) => f.type === "genui" && f.chunk.type === "ui")
        .map((f) => (f as Extract<OutgoingFrame, { type: "genui" }>).chunk as { component: string })
        .map((c) => c.component);
}

async function selftest(): Promise<number> {
    const app = makeApp();
    const c = new Collector();
    await app.connect(c);
    const connectFrames = c.drain();
    const welcome = connectFrames.find((f) => f.type === "welcome") as Extract<OutgoingFrame, { type: "welcome" }>;
    const { conversationId, userId } = welcome.data;

    // The greeting is a list, so it arrives as two persistent frames — prose and
    // a button message — before any turn has run.
    console.log("greeting frames:", connectFrames.map((f) => f.type).join(" → "));
    check(connectFrames.some((f) => f.type === "text"), "the greeting's prose");
    const chips = connectFrames.find((f) => f.type === "buttons") as MessageOutFrame | undefined;
    check(chips?.from === "bot" && Array.isArray(chips.data.buttons), "…and its button message, as its own frame");

    // ── turn 1: every component ───────────────────────────────────────────────
    await app.receive(c, { type: "text", data: { text: "components" } });
    const t1 = c.drain();
    const mounted = components(t1);
    console.log(`turn 1: ${mounted.length} ui chunks →`, [...new Set(mounted)].join(", "));

    for (const entry of Object.values(mekik.genui)) {
        check(mounted.includes(entry.name), `${entry.name} was mounted`);
    }

    // The mount handles updated in place: same chunk id, three times for the bar.
    const progressIds = t1
        .filter((f) => f.type === "genui" && f.chunk.type === "ui" && f.chunk.component === "genui-progress")
        .map((f) => ((f as Extract<OutgoingFrame, { type: "genui" }>).chunk as { id?: unknown }).id);
    check(progressIds.length === 3, `the progress bar was emitted 3 times (was ${progressIds.length})`);
    check(new Set(progressIds).size === 1, "…all three under ONE chunk id — an in-place update, not three bars");

    // ── turn 2: every message ─────────────────────────────────────────────────
    await app.receive(c, { type: "text", data: { text: "messages" } });
    const t2 = c.drain();
    const messageTypes = t2.filter((f) => "seq" in f && "from" in f).map((f) => f.type);
    console.log("turn 2: message frames →", messageTypes.join(", "));

    for (const kind of Object.values(mekik.messages)) {
        check(messageTypes.includes(kind.type), `a ${kind.type} message frame was sent`);
    }
    const card = t2.find((f) => f.type === "card") as MessageOutFrame | undefined;
    check(card?.id === "card-ORD-42", "the caller-supplied message id reached the wire");
    check(card?.from === "bot" && typeof card.seq === "number", "…in the persistent text envelope");

    // Messages are persistent: unlike a genui chunk stream, they're transcript
    // entries — so a reconnecting tab gets them replayed from seq 0.
    const again = new Collector();
    await app.connect(again, { hello: { conversationId, userId, watermark: 0 } });
    const replayed = again.drain().map((f) => f.type);
    check(replayed.includes("carousel"), "a reconnecting tab replays the messages from the transcript");
    console.log(`reconnect: replayed ${replayed.length} frames, messages included`);

    // ── turn 3: the typed button pause ────────────────────────────────────────
    await app.receive(c, { type: "text", data: { text: "hi" } });
    const t3 = c.drain();
    console.log("turn 3 frames:", t3.map((f) => f.type).join(" → "));
    const interrupt = t3.find((f) => f.type === "interrupt") as Extract<OutgoingFrame, { type: "interrupt" }> | undefined;
    check(interrupt, "choose parked the run on an interrupt");
    check(
        JSON.stringify(interrupt!.data.actions) ===
            JSON.stringify([
                { label: "Components", value: "components" },
                { label: "Messages", value: "messages" },
            ]),
        "…whose actions are exactly the options, as plain MessageActions",
    );

    await app.receive(c, { type: "resume", answers: { [interrupt!.id]: "messages" } });
    const t4 = c.drain();
    const reply = t4.find((f) => f.type === "text" && f.from === "bot") as Extract<OutgoingFrame, { type: "text" }> | undefined;
    check(reply?.data.text === 'Say "messages" and I\'ll show you.', "the pick resolved as choose's return value");

    console.log("\n✅ storefront self-test passed — 13 components, 8 message types, in-place updates, and a typed button pause");
    return 0;
}

// ── entry point ───────────────────────────────────────────────────────────────

if (process.argv.includes("--serve")) {
    const handle = serveWs(makeApp(), { port: 8802 });
    console.log(`storefront listening on ws://localhost:${handle.port} — try "components" or "messages"`);
} else {
    selftest().then(
        (code) => process.exit(code),
        (err) => {
            console.error(err);
            process.exit(1);
        },
    );
}
