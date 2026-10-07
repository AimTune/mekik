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
// Skills (§12): `book` and `cancel` are runAgent loops. The `fare-rules`
// skill OWNS book_flight (SkillEntry.tools, built once at module level);
// cancel_booking is built per request — it refunds from this conversation's
// booking in graph state — so the cancel node holds it under
// `cancellation-policy` with `skillTools`. Both are gated by an approval
// policy. The probe asserts the unlocked set survives the reconnect, and that
// the skill-held cancellation still runs exactly once.
//
//   node examples/travel-booking/travel.ts     # offline self-test, exit 0/1

import { channel, command, END, graph, START } from "@ilmek/core";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { mekik } from "@mekik/core";
import type { MessageAction, OutgoingFrame, SkillEntry } from "@mekik/core";
import { runAgent, toolContext, withMekikTools } from "@mekik/langchain";

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
    skillsCatalog,
    skillUses,
    toolNames,
    traces,
    uiChunks,
    user,
    welcomeOf,
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
const provider = { search: 0, price_check: 0, book_flight: 0, cancel_booking: 0 };

/** The provider's records: what book_flight booked, by conversation, and which refs are cancelled. */
const BOOKED = new Map<string, Booking>();
const CANCELLED = new Set<string>();

// ── tools ─────────────────────────────────────────────────────────────────────
//
// Built once, at module level. A tool that needs the run reads it from its
// LangChain config with toolContext(config).

const searchFlights = tool(
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

const priceCheck = tool(
    ({ offerId, adults }) => {
        provider.price_check++;
        const offer = INVENTORY.find((o) => o.id === offerId);
        if (!offer) throw new Error(`No offer ${offerId}.`);
        return { offerId, total: offer.pricePerAdult * adults, currency: "USD", refundable: true };
    },
    { name: "price_check", description: "Confirm an offer's current total.", schema: z.object({ offerId: z.string(), adults: z.number() }) },
);

const bookFlight = tool(
    ({ offerId, total: amount }, config): Booking => {
        provider.book_flight++;
        const booking: Booking = { ref: `BK-${4000 + provider.book_flight}`, offerId, total: amount, status: "confirmed" };
        // Recorded per conversation: the run that called the tool says which one.
        BOOKED.set(toolContext(config).threadId, booking);
        return booking;
    },
    { name: "book_flight", description: "Book an offer at a confirmed total.", schema: z.object({ offerId: z.string(), total: z.number() }) },
);

// ── the skill catalog (§12): each skill is its instructions + the tools it governs ──

/**
 * fare-rules owns book_flight. cancellation-policy owns no tool of its own: its
 * tool, cancel_booking, has to be built per request (see the cancel node), so
 * that node holds it under the skill with `skillTools`.
 */
const SKILLS: SkillEntry<StructuredToolInterface>[] = [
    {
        name: "fare-rules",
        description: "Fare conditions to check before booking: baggage, change and refund rules. Load before any booking.",
        instructions: "Read back the total and that the fare is refundable minus a $75 fee, then book_flight at the confirmed total.",
        tags: ["booking"],
        tools: [bookFlight],
    },
    {
        name: "cancellation-policy",
        description: "How to cancel a booking: fee, refund, and what to offer next.",
        instructions: `Cancellation costs ${CANCEL_FEE}; refund the rest with cancel_booking, once. Then offer to search again.`,
        tags: ["cancellation"],
    },
];

// ── the graph ─────────────────────────────────────────────────────────────────

const model = new ScriptedModel();

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
        const out = await runTools(ctx, model, "search", withMekikTools(ctx, [searchFlights]), "Search flights with search_flights.", s.input);
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

    // The booking agent: price_check is always on; book_flight comes with the
    // fare-rules skill and is gated by an approval policy — the pause the
    // reconnect test drops a socket in the middle of.
    .node("book", async (s, ctx) => {
        const o = s.choice!;
        const total = o.pricePerAdult * s.adults;
        const reply = await runAgent(ctx, model.asChatModel("book"), {
            system: "Confirm the price, load the fare rules, then book.",
            input: `Book ${o.flight} (${o.id}) for ${s.adults} adults.`,
            tools: [priceCheck],
            stream: false,
            // fare-rules brings book_flight, offered once the skill is loaded.
            skills: { tags: ["booking"] },
            policy: {
                book_flight: {
                    approve: {
                        title: `Book ${o.flight} for $${total}?`,
                        ui: mekik.genui.card.ref({ title: `${o.carrier} ${o.flight}`, description: `${o.depart} → ${o.arrive} · $${total} total` }),
                        actions: [mekik.action("Book it", { approved: true }), mekik.action("Not now", { approved: false })],
                        denyMessage: "The traveller decided not to book.",
                    },
                },
            },
        });
        const booking = await ctx.step("book:result", () => BOOKED.get(ctx.threadId) ?? null);
        return booking ? { booking, reply } : { reply: reply || "No problem — nothing was booked." };
    })

    // The cancellation agent: cancel_booking is held under cancellation-policy
    // (with skillTools — see below) and gated by a confirmation. It runs BEFORE a second pause in the same
    // node ("rebook?"), so the resume that answers it replays this node — agent
    // loop and all — and the journal is all that stands between the customer
    // and a double cancel.
    .node("cancel", async (s, ctx) => {
        const b = s.booking;
        if (!b) return { reply: "You don't have a booking to cancel." };
        if (b.status === "cancelled") return { reply: `${b.ref} is already cancelled — nothing more to do.` };

        // Built per request, on purpose: the refund is computed from THIS
        // conversation's booking in graph state (`b`), which a module-level tool
        // in the catalog cannot see. So instead of the skill entry owning it, the
        // node holds it under cancellation-policy with `skillTools` — same gating:
        // offered only once that skill is loaded.
        const cancelBooking = tool(
            ({ ref }) => {
                provider.cancel_booking++;
                CANCELLED.add(ref);
                const refunded = b.total - CANCEL_FEE;
                mekik.genui.alert(ctx, { variant: "success", title: "Booking cancelled", message: `$${refunded} is on its way back.` }, { id: `cancelled-${ref}` });
                return { ref, refunded };
            },
            { name: "cancel_booking", description: "Cancel a booking and refund it minus the fee.", schema: z.object({ ref: z.string() }) },
        );
        const reply = await runAgent(ctx, model.asChatModel("cancel"), {
            system: "Load the cancellation policy, then cancel the booking.",
            input: `Cancel ${b.ref}.`,
            stream: false,
            skills: { tags: ["cancellation"] },
            skillTools: { "cancellation-policy": [cancelBooking] },
            policy: {
                cancel_booking: {
                    approve: {
                        title: `Cancel ${b.ref}? You'll get $${b.total - CANCEL_FEE} back ($${CANCEL_FEE} fee).`,
                        actions: [mekik.action("Yes, cancel it", { approved: true }), mekik.action("Keep it", { approved: false })],
                        denyMessage: `The traveller kept ${b.ref}.`,
                    },
                },
            },
        });
        const done = await ctx.step("cancel:done", () => CANCELLED.has(b.ref));
        if (!done) return { reply: `${b.ref} is still confirmed.` };

        const again = await mekik.choose(ctx, "Want me to look for another flight?", ["Search again", "No thanks"], { key: "rebook" });
        return {
            booking: { ...b, status: "cancelled" as const },
            reply: again === "Search again" ? "Tell me where and when." : reply,
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
        skills: SKILLS,
        greeting: () => "Where would you like to go?",
    });
}

// ── the probe ─────────────────────────────────────────────────────────────────

const persistent = (frames: OutgoingFrame[]) => frames.filter((f) => seqOf(f) !== undefined);
const maxSeq = (frames: OutgoingFrame[]) => Math.max(0, ...frames.map((f) => seqOf(f) ?? 0));
const roundsOf = (node: string, from = 0) => (model.rounds[node] ?? []).slice(from).map((r) => r.join("|"));

async function probe(): Promise<void> {
    const app = makeApp();
    const tab = new Collector("conn-travel-1");
    await app.connect(tab, { hello: { userId: "traveller-1" } });
    const hello = tab.drain();
    const conversationId = welcomeOf(hello)?.data.conversationId ?? "";
    check(skillsCatalog(hello)?.skills?.map((s) => s.name).join("|") === "cancellation-policy|fare-rules", "a `skills` frame announces fare-rules and cancellation-policy");
    check(!JSON.stringify(hello).includes("book_flight"), "…summaries only: fare-rules' own tool never leaves the server");

    // ── 1. search → compare ───────────────────────────────────────────────────
    section("1. search → compare — offers as a genui-table, the pick as chips");
    model.load({
        route: [say("search")],
        search: [call("search_flights", { from: "IST", to: "LIS", date: "2026-11-14", adults: 2 }), say("Here are the options.")],
        book: [
            call("price_check", { offerId: "OF-1", adults: 2 }),
            call("load_skill", { name: "fare-rules" }),
            call("book_flight", { offerId: "OF-1", total: 824 }),
            say("Booked TK1759: reference BK-4001, $824 total."),
        ],
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
    const bookRounds = roundsOf("book");
    check(bookRounds[0] === "price_check|load_skill" && bookRounds[1] === "price_check|load_skill", "book_flight is not offered before fare-rules loads");
    check(bookRounds[2] === "price_check|load_skill|book_flight", "from the round after the load it is");
    check((approval!.data.payload as { tool: string }).tool === "book_flight", "the skill-held book_flight parks on its approval policy");

    const tab2 = new Collector("conn-travel-2");
    await app.connect(tab2, { hello: { userId: "traveller-1", conversationId, watermark } });
    const back = tab2.drain();
    const w2 = welcomeOf(back);
    check(w2?.data.conversationId === conversationId, "the reconnect resumes the same conversation");
    check(w2?.data.watermark === maxSeq(lost), `welcome reports the server's watermark (${maxSeq(lost)})`);
    const pending = w2?.data.pending ?? [];
    check(pending.length === 1 && pending[0]!.id === approval!.id, "welcome.pending re-announces the open approval, same id");
    const replay = persistent(back);
    const seqs = replay.map((f) => seqOf(f)!);
    check(seqs[0] === watermark + 1 && seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1), `replay starts at seq ${watermark + 1} with no gaps`);
    check(JSON.stringify(replay) === JSON.stringify(lost), "the replay is exactly the frames the dead socket missed");
    check(skillUses(replay).map((f) => f.data.name).join("|") === "fare-rules", "…the fare-rules `skill` frame included");
    check(!back.some((f) => f.type === "text" && f.from === "bot" && f.data.text === "Where would you like to go?"), "no second greeting");
    check(provider.book_flight === 0, "nothing booked while the client was away");

    console.log("   (answering the replayed approval from the new socket)");
    await app.receive(tab2, { type: "resume", answers: { [approval!.id]: { approved: true } } });
    t = tab2.drain();
    describe(t);
    const after = roundsOf("book", bookRounds.length);
    check(after.length === 1 && after[0] === "price_check|load_skill|book_flight", "the unlocked set survives the reconnect: the next round is still offered book_flight");
    check(botText(t) === "Booked TK1759: reference BK-4001, $824 total.", "the booking completes from the new connection");
    check(tab.frames.length === 0, "the dead socket received nothing more");
    check(provider.book_flight === 1 && provider.price_check === 1 && provider.search === 1, "search, price check and booking each ran exactly once");

    // ── 3. cancellation, exactly once ─────────────────────────────────────────
    section("3. cancellation — skill-held, two tabs confirm, one cancel runs");
    const tab3 = new Collector("conn-travel-3");
    await app.connect(tab3, { hello: { userId: "traveller-1", conversationId, watermark: maxSeq(tab2.wire) } });
    tab3.drain();
    model.load({
        route: [say("cancel")],
        cancel: [
            call("load_skill", { name: "cancellation-policy" }),
            call("cancel_booking", { ref: "BK-4001" }),
            say("Cancelled BK-4001; $749 refunded."),
        ],
    });
    user("Cancel my booking please");
    await app.receive(tab2, { type: "text", data: { text: "Cancel my booking please" } });
    t = tab2.drain();
    describe(t);
    const cancelRounds = roundsOf("cancel");
    check(cancelRounds[0] === "load_skill" && cancelRounds[1] === "load_skill|cancel_booking", "cancel_booking is offered only after cancellation-policy loads");
    check(skillUses(t).map((f) => f.data.name).join("|") === "cancellation-policy", "one `skill` frame: cancellation-policy");
    const confirm = interrupts(t)[0];
    check((confirm?.data.payload as { title: string }).title === "Cancel BK-4001? You'll get $749 back ($75 fee).", "the confirmation states the refund and fee");
    check(interrupts(tab3.drain()).some((f) => f.id === confirm!.id), "the other tab sees the same confirmation (fan-out)");

    console.log("   (both tabs tap: Yes, cancel it — at the same moment)");
    await Promise.all([
        app.receive(tab2, { type: "resume", answers: { [confirm!.id]: { approved: true } } }),
        app.receive(tab3, { type: "resume", answers: { [confirm!.id]: { approved: true } } }),
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
    check(runStatus(a) === "interrupted", "…so this node — agent loop included — will replay on the next resume");

    console.log("   (No thanks)");
    const askedBefore = roundsOf("cancel").length;
    await app.receive(tab2, { type: "resume", answers: { [rebook!.id]: "No thanks" } });
    t = tab2.drain();
    describe(t);
    check(roundsOf("cancel").length === askedBefore, "the replayed agent loop is not asked again (every round is journaled)");
    check(provider.cancel_booking === 1, "the replay did NOT cancel a second time — the skill-held tool is journaled like any other");
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
    console.log("\n✅ travel-booking probe passed — search, a genui-table comparison, skill-held booking and cancellation, watermark replay across a reconnect, and an exactly-once cancellation all verified");
}

main(probe);
