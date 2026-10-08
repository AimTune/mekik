// server-components — the backend owns the widget (PROTOCOL.md §10).
//
// Every other example emits `ui` chunks naming components the *client* already
// registered. This one defines the components on the server: markup, styles and
// prop defaults travel once in a `genui_components` frame, chativa registers each
// one as a custom element, and from then on a plain `ui` chunk mounts it. Adding
// a widget is a server deploy — no client build, no chativa release.
//
//   node examples/server-components.ts            # self-test (no socket)
//   node examples/server-components.ts --serve    # ws://localhost:8806 for chativa
//
// Turns:
//   "track ORD-42" → the server-defined order card and a status strip, both
//                    re-rendered in place, then a pause on three chips whose
//                    answer edits those same two elements
//   anything else  → a short prompt
//
// The turn is paced on purpose: an in-place update that lands in the same
// millisecond as the mount is invisible — the element just appears in its final
// state. Slowing it down is what makes the mechanism watchable.
//
// It then pauses a second time, on the card itself. The two attributes are the whole
// routing story (PROTOCOL.md §10.4):
//
//   component-event="rate_delivery"  → the node parked on mekik.onEvent, and only it
//   mekik-event="track_order"        → the app's onGenUiEvent, which may start a turn
//
// What to watch on the wire:
//   1. connect          → welcome, then genui_components{hash, components:[…]}
//   2. reconnect        → genui_components{hash, unchanged:true} — no markup
//   3. a stale hash     → the full catalog again
//   4. the turn         → 4 ui chunks under 2 ids, then an interrupt with the chips
//   5. the resume       → 2 more ui chunks at those same ids; nothing before the
//                         pause is re-emitted, because each phase ran in ctx.step
//   6. a 2nd pause      → carrying `event: "rate_delivery"` and no chips: the card's
//                         own Rate button answers it, not the chat
//   7. the Track button → a new turn once the run is idle

import { channel, END, graph, START } from "@ilmek/core";

import { defineComponent, mekik } from "../packages/core/src/index.ts";
import type { Connection, OutgoingFrame } from "../packages/core/src/index.ts";
import { serveWs } from "../packages/ws/src/index.ts";

// ── the components ────────────────────────────────────────────────────────────
// `defineComponent` returns a typed emitter AND the metadata the client
// registers, so the name and the props shape can't drift apart.

/**
 * The order card. `{{#each}}` renders the lines, `{{#if}}` hides an empty note,
 * and the button's `data-event` is what travels back as a `genui_event`.
 */
const deliveryCard = defineComponent({
    name: "delivery-card",
    template: `
        <div class="card">
            <header><h3>{{title}}</h3><span class="badge">{{status}}</span></header>
            <ul>
                {{#each lines}}<li><span>{{this.label}}</span><b>{{this.price}} ₺</b></li>{{/each}}
            </ul>
            {{#if note}}<p class="note">{{note}}</p>{{/if}}
            <footer>
                <strong>{{total}} ₺</strong>
                <button mekik-event="track_order" data-payload='{"id":"{{id}}"}'>Track</button>
                {{#if rateable}}<button component-event="rate_delivery" data-payload='{"stars":5}'>Rate</button>{{/if}}
            </footer>
        </div>
    `,
    css: `
        .card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; font-family: inherit; max-width: 340px; }
        header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        h3 { margin: 0; font-size: 0.95rem; }
        .badge { font-size: 0.72rem; background: #eef2ff; color: #4338ca; border-radius: 999px; padding: 2px 8px; }
        ul { list-style: none; margin: 10px 0; padding: 0; display: grid; gap: 4px; }
        li { display: flex; justify-content: space-between; font-size: 0.85rem; }
        .note { margin: 0 0 8px; font-size: 0.78rem; color: #64748b; }
        footer { display: flex; align-items: center; justify-content: space-between; }
        button { border: 0; border-radius: 8px; padding: 7px 14px; background: #4f46e5; color: #fff; cursor: pointer; }
    `,
    props: {
        id: "",
        title: "",
        status: "",
        total: 0,
        note: "",
        rateable: false,
        lines: [] as Array<{ label: string; price: number }>,
    },
});

/** A one-line status strip — re-emitted under the same chunk id to update in place. */
const shipmentStrip = defineComponent({
    name: "shipment-strip",
    template: `<div class="strip"><span class="dot"></span>{{step}} · <b>{{eta}}</b></div>`,
    css: `
        .strip { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; color: #0f172a; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #16a34a; }
    `,
    props: { step: "", eta: "" },
});

const COMPONENTS = [deliveryCard, shipmentStrip];

// ── the graph ─────────────────────────────────────────────────────────────────

const ORDERS: Record<string, { title: string; total: number; lines: Array<{ label: string; price: number }> }> = {
    "ORD-42": {
        title: "Order ORD-42",
        total: 249.9,
        lines: [
            { label: "Kettle", price: 199.9 },
            { label: "Mug", price: 50 },
        ],
    },
};

/**
 * How long each step lingers when serving.
 *
 * An in-place update is invisible if it lands in the same millisecond as the
 * mount — the element simply appears in its final state. Pacing the run is what
 * makes the mechanism watchable. The self-test runs at 0 so it stays instant.
 */
const STEP_MS = process.argv.includes("--serve") ? 1800 : 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One journaled phase: wait, then emit.
 *
 * `ctx.step(name, fn)` runs its body once and records the result; on the replay
 * pass after a resume, the recorded value comes back and the body is **not**
 * called. Emitting a chunk is a side effect like any other, so the emissions go
 * *inside* the step — otherwise answering the chips would replay the whole
 * pre-pause sequence and the user would watch the widget flash back through
 * states they already saw.
 *
 * The chunk ids are explicit strings for the same reason: an id minted by a
 * counter would drift once the counter's call site stops running on replay.
 * Same id ⇒ the client re-renders that element in place.
 */
const phase = (ctx: Parameters<typeof mekik.ui>[0], name: string, emit: () => void) =>
    ctx.step(name, async () => {
        if (STEP_MS > 0) await sleep(STEP_MS);
        emit();
        return true;
    });

/** Explicit, replay-stable chunk ids — the two elements this turn keeps editing. */
const CARD = "delivery-card-1";
const STRIP = "shipment-strip-1";

const tracker = graph("tracker")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("track", async (s, ctx) => {
        const id = (s.input.match(/ORD-\d+/i)?.[0] ?? "").toUpperCase();
        const order = ORDERS[id];
        if (!order) {
            return { reply: 'Try "track ORD-42".' };
        }

        /** The card's props, with only the fields that move as parameters. */
        const cardProps = (status: string, note: string, rateable = false) => ({
            id,
            title: order.title,
            status,
            total: order.total,
            note,
            rateable,
            lines: order.lines,
        });

        // Each phase is one journaled beat: pause for effect, then re-render the
        // element at the same chunk id. Watch the card's badge change while the
        // bubble stays put.
        await phase(ctx, "packing", () =>
            deliveryCard(ctx, cardProps("Preparing", "Packing your items."), { id: CARD }),
        );
        await phase(ctx, "in_transit", () =>
            deliveryCard(ctx, cardProps("In transit", "Left the warehouse."), { id: CARD }),
        );
        await phase(ctx, "picked_up", () =>
            shipmentStrip(ctx, { step: "Picked up", eta: "today, 18:00" }, { id: STRIP }),
        );
        await phase(ctx, "out_for_delivery", () =>
            shipmentStrip(ctx, { step: "Out for delivery", eta: "today, 16:30" }, { id: STRIP }),
        );

        // The run parks here and the chips render in the chat. Everything above
        // stays on screen — a mounted component outlives the pause, and nothing
        // above re-runs when the answer arrives (the journal saw it already).
        const choice = await mekik.choose(ctx, `${id} is at your door. What should the courier do?`, [
            mekik.action("Hand it to me", "handover"),
            mekik.action("Leave at the door", "leave"),
            mekik.action("Reschedule", "reschedule"),
        ] as const);

        // The answer drives the SAME two elements — this is the point of the
        // example: an approval that edits a component already on screen.
        const outcome = {
            handover: { status: "Delivered", note: "Signed for at the door.", step: "Delivered", eta: "just now" },
            leave: { status: "Delivered", note: "Left at the door as requested.", step: "Delivered", eta: "just now" },
            reschedule: { status: "Rescheduled", note: "We'll try again tomorrow.", step: "Rescheduled", eta: "tomorrow, 10:00" },
        }[choice];

        // Journaled like every other beat, because the run pauses again below: on the
        // rating's replay pass these must not re-emit.
        await phase(ctx, "settled", () => {
            deliveryCard(ctx, cardProps(outcome.status, outcome.note, true), { id: CARD });
            shipmentStrip(ctx, { step: outcome.step, eta: outcome.eta }, { id: STRIP });
        });

        // The second pause, and the point of `component-event`: no chips in the chat
        // this time — the run waits for a button on the card that is already on screen.
        // The interrupt frame carries `event: "rate_delivery"` so the client knows to
        // wait for the widget rather than offer Approve/Cancel.
        const rating = await mekik.onEvent<{ stars: number }>(ctx, "rate_delivery");

        deliveryCard(ctx, cardProps(outcome.status, `Thanks — you rated this ${rating.stars}/5.`), { id: CARD });

        return { reply: `${id}: ${outcome.status.toLowerCase()}.` };
    })
    .edge(START, "track")
    .edge("track", END)
    .compile();

const makeApp = () =>
    mekik({
        graph: tracker,
        reply: (s) => s.reply as string,
        // The whole feature: hand the definitions to the app and every connecting
        // client gets them.
        components: COMPONENTS,
        // …and the other half of it. The card's `data-event="track_order"` button
        // arrives here; returning an input update runs a turn on it, returning
        // undefined ignores it. Leave this out and the button is decorative — the
        // frame reaches the server and stops there.
        onGenUiEvent: (ev) => {
            if (ev.eventType !== "track_order") return undefined;
            const id = (ev.payload as { id?: unknown } | undefined)?.id;
            return typeof id === "string" ? { input: `track ${id}` } : undefined;
        },
    });

// ── self-test ─────────────────────────────────────────────────────────────────

class Collector implements Connection {
    readonly id = `c-${Math.random().toString(36).slice(2, 8)}`;
    private frames: OutgoingFrame[] = [];
    send(frame: OutgoingFrame): void {
        this.frames.push(frame);
    }
    close(): void {}
    drain(): OutgoingFrame[] {
        const out = this.frames;
        this.frames = [];
        return out;
    }
}

let failures = 0;
function check(ok: unknown, label: string): void {
    console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
    if (!ok) failures++;
}

const catalogFrame = (frames: OutgoingFrame[]) =>
    frames.find((f) => f.type === "genui_components") as
        | Extract<OutgoingFrame, { type: "genui_components" }>
        | undefined;

async function selftest(): Promise<number> {
    const app = makeApp();

    // ── 1. first connect: the catalog travels once ────────────────────────────
    const c1 = new Collector();
    await app.connect(c1);
    const opening = c1.drain();

    console.log("connect frames:", opening.map((f) => f.type).join(" → "));
    const catalog = catalogFrame(opening);
    check(opening[0]?.type === "welcome", "welcome comes first");
    check(catalog !== undefined, "…immediately followed by the component catalog");
    check(catalog?.components?.length === 2, "both server-defined components are in it");
    check(/^[0-9a-f]{64}$/.test(catalog?.hash ?? ""), "the catalog carries a sha256 hash");
    check(
        catalog?.components?.map((d) => d.name).join(",") === "delivery-card,shipment-strip",
        "definitions are sorted by name (a stable hash needs a stable order)",
    );
    check(
        catalog?.components?.[0]?.template.includes("{{#each lines}}") === true,
        "the markup itself is what travels — the client compiles nothing",
    );

    // The hash covers the definitions byte-for-byte, whitespace included — this
    // example and its .NET twin therefore print different hashes purely because
    // their source formatting differs. For identical definitions the two servers
    // mint the identical hash; that contract is pinned by the unit tests on both
    // sides (ts/packages/core/test/components.test.ts,
    // dotnet/test/Mekik.Core.Tests/ComponentsTests.cs).
    console.log("catalog hash:", catalog!.hash);

    const welcome = opening.find((f) => f.type === "welcome") as Extract<OutgoingFrame, { type: "welcome" }>;
    const { conversationId, userId } = welcome.data;
    const hash = catalog!.hash;

    // ── 2. reconnect with the cached hash: no markup ──────────────────────────
    const c2 = new Collector();
    await app.connect(c2, { hello: { conversationId, userId, componentsHash: hash } });
    const cached = catalogFrame(c2.drain());

    check(cached?.unchanged === true, "a client that already has this catalog is told `unchanged`");
    check(cached?.components === undefined, "…and no markup is re-sent");

    // ── 3. a stale hash gets the catalog back ─────────────────────────────────
    const c3 = new Collector();
    await app.connect(c3, { hello: { conversationId, userId, componentsHash: "hash-from-last-deploy" } });
    const refreshed = catalogFrame(c3.drain());

    check(refreshed?.unchanged === undefined, "a stale hash is not treated as a cache hit");
    check(refreshed?.components?.length === 2, "…the full catalog is re-sent");

    // ── 4. the turn mounts the components by name, then pauses ────────────────
    await app.receive(c1, { type: "text", data: { text: "track ORD-42" } });
    const turn = c1.drain();
    const uiOf = (frames: OutgoingFrame[]) =>
        frames
            .filter((f): f is Extract<OutgoingFrame, { type: "genui" }> => f.type === "genui")
            .map((f) => f.chunk)
            .filter((c): c is Extract<typeof c, { type: "ui" }> => c.type === "ui");
    const uiChunks = uiOf(turn);

    console.log("turn frames:", turn.map((f) => f.type).join(" → "));
    check(uiChunks[0]?.component === "delivery-card", "the turn mounts the server-defined card by name");
    check(
        (uiChunks[0]?.props as { lines?: unknown[] })?.lines?.length === 2,
        "…with props only — the markup already lives on the client",
    );

    const cardChunks = uiChunks.filter((c) => c.component === "delivery-card");
    check(cardChunks.length === 2, "the card is emitted twice before the pause (Preparing → In transit)");
    check(
        cardChunks[0]?.id !== undefined && cardChunks[0]?.id === cardChunks[1]?.id,
        "…under one chunk id, so the client updates it in place instead of stacking cards",
    );

    const stripChunks = uiChunks.filter((c) => c.component === "shipment-strip");
    check(stripChunks.length === 2, "the strip is emitted twice");
    check(
        stripChunks[0]?.id !== undefined && stripChunks[0]?.id === stripChunks[1]?.id,
        "…also under one chunk id",
    );

    // ── 5. the pause: chips render in the chat, the widgets stay on screen ────
    const interrupt = turn.find((f) => f.type === "interrupt") as
        | Extract<OutgoingFrame, { type: "interrupt" }>
        | undefined;

    check(interrupt !== undefined, "the run parks on an interrupt — the courier question");
    check(
        JSON.stringify(interrupt?.data.actions) ===
            JSON.stringify([
                { label: "Hand it to me", value: "handover" },
                { label: "Leave at the door", value: "leave" },
                { label: "Reschedule", value: "reschedule" },
            ]),
        "…whose chips are the three options, as plain MessageActions",
    );

    // ── 6. answering the chips edits the components already on screen ─────────
    await app.receive(c1, { type: "resume", answers: { [interrupt!.id]: "reschedule" } });
    const after = c1.drain();
    const afterUi = uiOf(after);
    const finalCard = afterUi.find((c) => c.component === "delivery-card");
    const finalStrip = afterUi.find((c) => c.component === "shipment-strip");

    console.log("resume frames:", after.map((f) => f.type).join(" → "));
    check(
        (finalCard?.props as { status?: string })?.status === "Rescheduled",
        "the answer re-renders the card with a new status",
    );
    check(finalCard?.id === cardChunks[0]?.id, "…at the SAME chunk id — the card on screen changes, none is added");
    check(
        (finalStrip?.props as { step?: string })?.step === "Rescheduled",
        "the strip follows the same answer",
    );
    check(finalStrip?.id === stripChunks[0]?.id, "…also in place");
    check(
        afterUi.filter((c) => c.component === "delivery-card").length === 1,
        "the replay after the resume does not re-emit the pre-pause states (ctx.step journaled them)",
    );

    // ── 7. the second pause waits for the card's own button, not for chips ────
    const streamId = (turn.find((f) => f.type === "genui") as Extract<OutgoingFrame, { type: "genui" }>).streamId;
    const ratingPause = after.find((f) => f.type === "interrupt") as
        | Extract<OutgoingFrame, { type: "interrupt" }>
        | undefined;

    check(ratingPause?.data.event === "rate_delivery", "the run parks again, announcing the component-event it waits for");
    check(ratingPause?.data.actions === undefined, "…and offers no chips — a widget already on screen answers this one");
    check(
        (finalCard?.props as { rateable?: boolean })?.rateable === true,
        "…which is why the card was re-rendered with its Rate button showing",
    );

    // `component-event="rate_delivery"` — the pause the node is holding is the
    // binding, so nothing has to name an interrupt id.
    await app.receive(c1, {
        type: "genui_event",
        streamId,
        eventType: "rate_delivery",
        scope: "component",
        payload: { stars: 5 },
    });
    const rated = c1.drain();
    console.log("rating frames:", rated.map((f) => f.type).join(" → "));

    const ratedCard = uiOf(rated).find((c) => c.component === "delivery-card");
    check(
        (ratedCard?.props as { note?: string })?.note?.includes("5/5") === true,
        "the button resolves the pause and its payload comes back as the node's value",
    );
    check(
        rated.some((f) => f.type === "run" && f.data.status === "finished"),
        "…and the run finishes",
    );

    // ── 8. the card's own button drives a turn ────────────────────────────────
    // The run above finished, so the graph is idle and the click is free to start
    // a new turn. `onGenUiEvent` maps it to `{ input: "track ORD-42" }` — the same
    // update a typed message would produce.
    await app.receive(c1, {
        type: "genui_event",
        streamId,
        eventType: "track_order",
        scope: "graph",
        payload: { id: "ORD-42" },
    });
    const clicked = c1.drain();
    console.log("click frames:", clicked.map((f) => f.type).join(" → "));

    check(
        clicked.some((f) => f.type === "genui"),
        "the card's mekik-event button drives a turn — the graph re-mounts the card",
    );
    check(
        clicked.every((f) => f.type !== "text"),
        "…without writing a message the user never typed",
    );

    // An event with no mapping is inert: `onGenUiEvent` returns undefined and no
    // turn starts.
    await app.receive(c1, { type: "genui_event", streamId, eventType: "hovered", scope: "graph", payload: { id: "ORD-42" } });
    check(c1.drain().length === 0, "an event the handler maps to undefined costs nothing — no turn, no frames");

    // ── 9. a server with no components sends no catalog ───────────────────────
    const bare = mekik({ graph: tracker, reply: (s) => s.reply as string });
    const c4 = new Collector();
    await bare.connect(c4);
    check(catalogFrame(c4.drain()) === undefined, "a server that defines no components sends no catalog frame");

    if (failures > 0) {
        console.error(`\n❌ ${failures} check(s) failed`);
        return 1;
    }
    console.log("\n✅ server-components self-test passed — catalog sent once, cached by hash, mounted by name");
    return 0;
}

// ── entry point ───────────────────────────────────────────────────────────────

if (process.argv.includes("--serve")) {
    const port = 8806;
    serveWs(makeApp(), { port });
    console.log(
        `server-components listening on ws://localhost:${port} — connect chativa and say "track ORD-42".\n` +
            "The widgets are defined here, not in the page: edit a template above, restart, and the client picks up\n" +
            "the new markup on its next connect (the hash changed).",
    );
} else {
    selftest().then(
        (code) => process.exit(code),
        (err) => {
            console.error(err);
            process.exit(1);
        },
    );
}
