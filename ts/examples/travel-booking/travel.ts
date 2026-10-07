// Travel booking — a domain probe. A multi-step ilmek graph served over mekik,
// driven offline by a scripted model, asserting its own frame stream:
//
//     START → route ─┬→ search → compare (genui-table + chips) → book (approval) → END
//                    ├→ cancel (confirm → cancel_booking → "rebook?") ───────────→ END
//                    └→ chat ────────────────────────────────────────────────────→ END
//
//   1. search + compare — flight offers as a genui-table, the pick as chips
//   2. reconnect        — the socket drops while the booking approval streams;
//                         the client reconnects with its watermark and gets
//                         exactly the frames it missed (seq > watermark, in
//                         order, no gaps), plus the open approval in
//                         welcome.pending; answering it from the new socket
//                         books exactly once
//   3. cancellation     — two tabs both confirm; one wins, one is refused; the
//                         cancellation runs once even though its node pauses
//                         again afterwards (and so replays); asking to cancel
//                         again changes nothing
//
//   node examples/travel-booking/travel.ts     # offline self-test, exit 0/1

import { channel, command, END, graph, START } from "@ilmek/core";
import type { Context } from "@ilmek/core";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { mekik } from "@mekik/core";
import type { MessageAction, OutgoingFrame } from "@mekik/core";
import { withMekikTools } from "@mekik/langchain";

import {
    botText,
    call,
    check,
    Collector,
    describe,
    errorCode,
    interrupts,
    main,
    runStatus,
    runTools,
    say,
    ScriptedModel,
    section,
    seqOf,
    toolNames,
    traces,
    uiChunks,
    user,
} from "../lib/probe-kit.ts";

// ── the travel provider ───────────────────────────────────────────────────────

interface Offer {
    id: string;
    carrier: string;
    flight: string;
    depart: string;
    arrive: string;
    stops: number;
    pricePerAdult: number;
}

interface Booking {
    ref: string;
    offerId: string;
    total: number;
    status: "confirmed" | "cancelled";
}

const INVENTORY: Offer[] = [
    { id: "OF-1", carrier: "Turkish Airlines", flight: "TK1759", depart: "08:15", arrive: "11:05", stops: 0, pricePerAdult: 412 },
    { id: "OF-2", carrier: "Pegasus", flight: "PC1223", depart: "06:40", arrive: "13:20", stops: 1, pricePerAdult: 289 },
    { id: "OF-3", carrier: "Lufthansa", flight: "LH1301", depart: "10:30", arrive: "16:45", stops: 1, pricePerAdult: 355 },
];

const CANCEL_FEE = 75;

/** The provider's side effects, counted — the probe holds each to exactly once. */
const provider = { search: 0, price_check: 0, create_booking: 0, cancel_booking: 0 };

// ── the graph ─────────────────────────────────────────────────────────────────

const model = new ScriptedModel();

function searchTools(ctx: Context<any>): StructuredToolInterface[] {
    const search = tool(
        ({ from, to, date, adults }) => {
            provider.search++;
            return { from, to, date, adults, offers: INVENTORY };
        },
        {
            name: "search_flights",
            description: "Search flights for a route and date.",
            schema: z.object({ from: z.string(), to: z.string(), date: z.string(), adults: z.number() }),
        },
    );
    return withMekikTools(ctx, [search]);
}

const travel = graph("travel-booking")
    .channel("input", channel.lastWrite<string>(""))
    .channel("adults", channel.lastWrite<number>(1))
    .channel("offers", channel.lastWrite<Offer[]>([]))
    .channel("choice", channel.lastWrite<Offer | null>(null))
    .channel("booking", channel.lastWrite<Booking | null>(null))
    .channel("reply", channel.lastWrite<string>(""))

    .node("route", async (_s, ctx) => {
        const route = await ctx.step("route:classify", () => model.classify("route"));
        return command({ goto: route === "search" || route === "cancel" ? route : "chat" });
    })

    .node("search", async (s, ctx) => {
        const out = await runTools(ctx, model, "search", searchTools(ctx), "Search flights with search_flights.", s.input);
        const found = out.results.search_flights as { offers: Offer[]; adults: number } | undefined;
        if (!found?.offers.length) return command({ update: { reply: out.text || "No flights found." }, goto: END });
        return command({ update: { offers: found.offers, adults: found.adults }, goto: "compare" });
    })

    // Compare as a table, pick with chips. The table has a literal id, so the
    // replay after the pick re-renders the same element instead of a second one.
    .node("compare", async (s, ctx) => {
        mekik.genui.table(
            ctx,
            {
                title: `Flights for ${s.adults} adult(s)`,
                columns: ["Flight", "Carrier", "Departs", "Arrives", "Stops", "Total"],
                rows: s.offers.map((o) => [o.flight, o.carrier, o.depart, o.arrive, o.stops, `$${o.pricePerAdult * s.adults}`]),
            },
            { id: "compare-offers" },
        );
        const actions = s.offers.map((o) => mekik.action(`${o.flight} · $${o.pricePerAdult * s.adults}`, o.id)) as MessageAction[];
        const picked = await mekik.approve<string>(ctx, { title: "Which flight should I book?" }, { actions, key: "pick" });
        const choice = s.offers.find((o) => o.id === picked);
        if (!choice) return command({ update: { reply: "No flight chosen." }, goto: END });
        return command({ update: { choice }, goto: "book" });
    })

    .node("book", async (s, ctx) => {
        const o = s.choice!;
        const fare = await mekik.tool(ctx, "price_check", { offerId: o.id, adults: s.adults }, () => {
            provider.price_check++;
            return { offerId: o.id, total: o.pricePerAdult * s.adults, currency: "USD", refundable: true };
        });
        const ok = await mekik.approve<{ approved: boolean }>(
            ctx,
            { title: `Book ${o.flight} for $${fare.total}?`, offerId: o.id, total: fare.total },
            {
                ui: mekik.genui.card.ref({ title: `${o.carrier} ${o.flight}`, description: `${o.depart} → ${o.arrive} · $${fare.total} total` }),
                actions: [mekik.action("Book it", { approved: true }), mekik.action("Not now", { approved: false })],
                key: "approve:booking",
            },
        );
        if (!ok.approved) return { reply: "No problem — nothing was booked." };
        const booking = await mekik.tool(ctx, "create_booking", { offerId: o.id, total: fare.total }, (): Booking => {
            provider.create_booking++;
            return { ref: `BK-${4000 + provider.create_booking}`, offerId: o.id, total: fare.total, status: "confirmed" };
        });
        return { booking, reply: `Booked ${o.flight}: reference ${booking.ref}, $${booking.total} total.` };
    })

    // The cancellation sits BEFORE a second pause in the same node, so the
    // resume that answers "rebook?" replays this node from the top — and the
    // journal is all that stands between the customer and a double cancel.
    .node("cancel", async (s, ctx) => {
        const b = s.booking;
        if (!b) return { reply: "You don't have a booking to cancel." };
        if (b.status === "cancelled") return { reply: `${b.ref} is already cancelled — nothing more to do.` };

        const sure = await mekik.choose(
            ctx,
            { title: `Cancel ${b.ref}? You'll get $${b.total - CANCEL_FEE} back ($${CANCEL_FEE} fee).`, ref: b.ref },
            [mekik.action("Yes, cancel it", true), mekik.action("Keep it", false)],
            { key: "confirm:cancel" },
        );
        if (!sure) return { reply: `${b.ref} is still confirmed.` };

        const refund = await mekik.tool(ctx, "cancel_booking", { ref: b.ref }, () => {
            provider.cancel_booking++;
            return { ref: b.ref, refunded: b.total - CANCEL_FEE };
        });
        mekik.genui.alert(ctx, { variant: "success", title: "Booking cancelled", message: `$${refund.refunded} is on its way back.` }, { id: `cancelled-${b.ref}` });

        const again = await mekik.choose(ctx, "Want me to look for another flight?", ["Search again", "No thanks"], { key: "rebook" });
        return {
            booking: { ...b, status: "cancelled" as const },
            reply: again === "Search again" ? "Tell me where and when." : `Cancelled ${b.ref}; $${refund.refunded} refunded.`,
        };
    })

    .node("chat", async () => ({ reply: "I can search flights, book one, or cancel a booking." }))

    .edge(START, "route")
    .edge("book", END)
    .edge("cancel", END)
    .edge("chat", END)
    .compile();

function makeApp() {
    return mekik({
        graph: travel,
        input: (frame) => ({ input: frame.data.text }),
        reply: (state) => state.reply as string,
        greeting: () => "Where would you like to go?",
    });
}

// ── the probe ─────────────────────────────────────────────────────────────────

const persistent = (frames: OutgoingFrame[]) => frames.filter((f) => seqOf(f) !== undefined);
const maxSeq = (frames: OutgoingFrame[]) => Math.max(0, ...frames.map((f) => seqOf(f) ?? 0));

async function probe(): Promise<void> {
    const app = makeApp();
    const tab = new Collector("conn-travel-1");
    await app.connect(tab, { hello: { userId: "traveller-1" } });
    const hello = tab.drain();
    const welcome = hello.find((f) => f.type === "welcome");
    const conversationId = welcome?.type === "welcome" ? welcome.data.conversationId : "";

    // ── 1. search → compare ───────────────────────────────────────────────────
    section("1. search → compare — offers as a genui-table, the pick as chips");
    model.load({
        route: [say("search")],
        search: [call("search_flights", { from: "IST", to: "LIS", date: "2026-11-14", adults: 2 }), say("Here are the options.")],
    });
    user("Flights Istanbul to Lisbon on 14 November, two adults");
    await app.receive(tab, { type: "text", data: { text: "Flights Istanbul to Lisbon on 14 November, two adults" } });
    let t = tab.drain();
    describe(t);
    const table = uiChunks(t, "genui-table")[0];
    check(table?.id === "compare-offers", "a genui-table with a literal id compares the offers");
    const rows = (table!.props as { rows: unknown[][] }).rows;
    check(rows.length === 3 && rows[0]![5] === "$824", "three offers, totals for two adults");
    const pick = interrupts(t)[0];
    check(pick?.data.actions?.map((a) => a.value).join("|") === "OF-1|OF-2|OF-3", "one chip per offer, valued by offer id");
    // The watermark: the highest persistent seq this client has durably seen.
    const watermark = maxSeq(tab.wire);
    console.log(`   (client persists up to seq ${watermark})`);

    // ── 2. the socket drops mid-booking; reconnect replays the gap ────────────
    section("2. reconnect — the approval streams to a dying socket, the watermark recovers it");
    console.log("   (user taps TK1759 · $824 — and the connection drops while the reply streams)");
    await app.receive(tab, { type: "resume", answers: { [pick!.id]: "OF-1" } });
    const lost = persistent(tab.drain()); // delivered to a socket that died: never persisted by the client
    describe(lost);
    app.disconnect(tab);
    const approval = interrupts(lost)[0];
    check(approval !== undefined && toolNames(lost).includes("price_check"), "the lost frames held price_check and the booking approval");

    const tab2 = new Collector("conn-travel-2");
    await app.connect(tab2, { hello: { userId: "traveller-1", conversationId, watermark } });
    const back = tab2.drain();
    const w2 = back.find((f) => f.type === "welcome");
    check(w2?.type === "welcome" && w2.data.conversationId === conversationId, "the reconnect resumes the same conversation");
    check(w2?.type === "welcome" && w2.data.watermark === maxSeq(lost), `welcome reports the server's watermark (${maxSeq(lost)})`);
    const pending = w2?.type === "welcome" ? w2.data.pending : [];
    check(pending.length === 1 && pending[0]!.id === approval!.id, "welcome.pending re-announces the open approval, same id");
    const replay = persistent(back);
    const seqs = replay.map((f) => seqOf(f)!);
    check(seqs[0] === watermark + 1 && seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1), `replay starts at seq ${watermark + 1} with no gaps`);
    check(JSON.stringify(replay) === JSON.stringify(lost), "the replay is exactly the frames the dead socket missed");
    check(!back.some((f) => f.type === "text" && f.from === "bot" && f.data.text === "Where would you like to go?"), "no second greeting");
    check(provider.create_booking === 0, "nothing booked while the client was away");

    console.log("   (answering the replayed approval from the new socket)");
    await app.receive(tab2, { type: "resume", answers: { [approval!.id]: { approved: true } } });
    t = tab2.drain();
    describe(t);
    check(botText(t) === "Booked TK1759: reference BK-4001, $824 total.", "the booking completes from the new connection");
    check(tab.frames.length === 0, "the dead socket received nothing more");
    check(provider.create_booking === 1 && provider.price_check === 1 && provider.search === 1, "search, price check and booking each ran exactly once");

    // ── 3. cancellation, exactly once ─────────────────────────────────────────
    section("3. cancellation — two tabs confirm, one cancel runs");
    const tab3 = new Collector("conn-travel-3");
    await app.connect(tab3, { hello: { userId: "traveller-1", conversationId, watermark: maxSeq(tab2.wire) } });
    tab3.drain();
    model.load({ route: [say("cancel")] });
    user("Cancel my booking please");
    await app.receive(tab2, { type: "text", data: { text: "Cancel my booking please" } });
    t = tab2.drain();
    describe(t);
    const confirm = interrupts(t)[0];
    check((confirm?.data.payload as { title: string }).title === "Cancel BK-4001? You'll get $749 back ($75 fee).", "the confirmation states the refund and fee");
    check(interrupts(tab3.drain()).some((f) => f.id === confirm!.id), "the other tab sees the same confirmation (fan-out)");

    console.log("   (both tabs tap: Yes, cancel it — at the same moment)");
    await Promise.all([
        app.receive(tab2, { type: "resume", answers: { [confirm!.id]: true } }),
        app.receive(tab3, { type: "resume", answers: { [confirm!.id]: true } }),
    ]);
    const a = tab2.drain();
    const b = tab3.drain();
    describe(a);
    const refused = errorCode(b);
    check(refused === "busy" || refused === "not_interrupted", `the second confirmation is refused (${refused})`);
    check(provider.cancel_booking === 1, "cancel_booking ran once");
    const cancelTraceId = traces(a, "cancel_booking")[0]?.data.id;
    check(uiChunks(a, "genui-alert")[0]?.id === "cancelled-BK-4001", "a success alert confirms it");
    const rebook = interrupts(a)[0];
    check(rebook?.data.actions?.map((x) => x.label).join("|") === "Search again|No thanks", "then the node pauses again: rebook?");
    check(runStatus(a) === "interrupted", "…so this node will replay on the next resume");

    console.log("   (No thanks)");
    await app.receive(tab2, { type: "resume", answers: { [rebook!.id]: "No thanks" } });
    t = tab2.drain();
    describe(t);
    check(provider.cancel_booking === 1, "the replay did NOT cancel a second time (journaled)");
    check(traces(t, "cancel_booking").every((f) => f.data.id === cancelTraceId), "its re-emitted trace upserts the same id");
    check(botText(t) === "Cancelled BK-4001; $749 refunded.", "the reply confirms the refund");

    user("Cancel my booking");
    model.load({ route: [say("cancel")] });
    await app.receive(tab2, { type: "text", data: { text: "Cancel my booking" } });
    t = tab2.drain();
    describe(t);
    check(interrupts(t).length === 0 && toolNames(t).length === 0, "asking again: no pause, no tool");
    check(botText(t) === "BK-4001 is already cancelled — nothing more to do.", "the graph state knows it is cancelled");
    check(provider.cancel_booking === 1, `cancel_booking ran exactly once overall (${provider.cancel_booking})`);

    console.log(`\nprovider calls: ${JSON.stringify(provider)}`);
    console.log("\n✅ travel-booking probe passed — search, a genui-table comparison, approval, watermark replay across a reconnect, and an exactly-once cancellation all verified");
}

main(probe);
