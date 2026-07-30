// The behavioural conformance suite (conformance/README.md, "Scenario suites").
// Drives the real ConversationEngine over in-memory connections and real ilmek
// graphs - the things a pure event→frame fixture can't cover: handshake, replay,
// fan-out, resume routing, the turn lock, auth.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { channel, command, END, graph, send, START } from "@ilmek/core";

import { mekik } from "../src/index.ts";
import type { Connection, GenUiEvent } from "../src/engine.ts";
import type { MessageOutFrame, OutgoingFrame, RunStatus } from "../src/protocol.ts";
import { StaticTokenAuthenticator } from "../src/auth.ts";

// ── test doubles ──────────────────────────────────────────────────────────────

class FakeConn implements Connection {
    readonly id: string;
    readonly sent: OutgoingFrame[] = [];
    closed: { code?: number; reason?: string } | null = null;
    constructor(id: string) {
        this.id = id;
    }
    send(frame: OutgoingFrame): void {
        this.sent.push(frame);
    }
    close(code?: number, reason?: string): void {
        this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
    }
}

let connSeq = 0;
const conn = (): FakeConn => new FakeConn(`c-${++connSeq}`);

const runStatuses = (c: FakeConn): RunStatus[] =>
    c.sent.filter((f): f is Extract<OutgoingFrame, { type: "run" }> => f.type === "run").map((f) => f.data.status);
const types = (c: FakeConn): string[] => c.sent.map((f) => f.type);
const first = <T extends OutgoingFrame["type"]>(c: FakeConn, t: T): Extract<OutgoingFrame, { type: T }> =>
    c.sent.find((f) => f.type === t) as Extract<OutgoingFrame, { type: T }>;
const welcomeOf = (c: FakeConn) => first(c, "welcome").data;

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

// ── graphs ────────────────────────────────────────────────────────────────────

/** Emits a ui chunk and returns a reply - the happy-path turn. */
const greeter = graph("greeter")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("greet", (s, ctx) => {
        mekik.ui(ctx, "hello-card", { name: s.input });
        return { reply: `Hi, ${s.input}!` };
    })
    .edge(START, "greet")
    .edge("greet", END)
    .compile();

/** Pauses once for an approval. */
const approval = graph("approval")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("gate", async (s, ctx) => {
        const answer = await mekik.approve<{ approved: boolean }>(
            ctx,
            { title: `approve ${s.input}?` },
            { ui: { component: "approval-form", props: { what: s.input } } },
        );
        return { reply: answer.approved ? "approved" : "rejected" };
    })
    .edge(START, "gate")
    .edge("gate", END)
    .compile();

/** Mounts a widget and parks until its own button fires (§10.4). */
const awaiting = graph("awaiting")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("wait", async (s, ctx) => {
        mekik.ui(ctx, "delivery-card", { id: s.input }, { id: "card-1" });
        const req = await mekik.onEvent<{ id: string }>(ctx, "track_order");
        return { reply: `tracking ${req.id}` };
    })
    .edge(START, "wait")
    .edge("wait", END)
    .compile();

/** Fans out to two workers, each of which pauses - two concurrent interrupts. */
const batch = graph("batch")
    .channel("items", channel.lastWrite<string[]>([]))
    .channel("done", channel.append<string>())
    .node("fan", (s) => command({ goto: s.items.map((i) => send("worker", { item: i })) }))
    .node("worker", async (p: { item: string }, ctx) => {
        await mekik.approve(ctx, { title: `charge ${p.item}` }, { actions: [{ label: "ok", value: true }] });
        return { done: [p.item] };
    })
    .edge(START, "fan")
    .edge("worker", END)
    .compile();

const makeGatedGraph = (gate: Promise<void>) =>
    graph("slow")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("wait", async () => {
            await gate;
            return { reply: "done" };
        })
        .edge(START, "wait")
        .edge("wait", END)
        .compile();

// ── scenarios ─────────────────────────────────────────────────────────────────

describe("handshake (§1)", () => {
    test("anonymous connect mints identity and announces the protocol", async () => {
        const app = mekik({ graph: greeter, reply: (s) => s.reply as string });
        const c = conn();
        await app.connect(c);

        const w = welcomeOf(c);
        assert.equal(w.protocol, "mekik/1");
        assert.match(w.userId, /^user-/);
        assert.match(w.conversationId, /^conv-/);
        assert.equal(w.connectionId, c.id);
        assert.deepEqual(w.pending, []);
    });

    test("a client-asserted conversation it doesn't own is not adopted (watermark resets)", async () => {
        const app = mekik({ graph: greeter, reply: (s) => s.reply as string });
        const c = conn();
        // Assert someone else's conversation id with a different user.
        await app.connect(c, { hello: { userId: "mallory", conversationId: "conv-victim", watermark: 99 } });
        const w = welcomeOf(c);
        assert.notEqual(w.conversationId, "conv-victim");
        // No replay of a conversation that isn't theirs.
        assert.deepEqual(types(c), ["welcome"]);
    });
});

describe("a basic turn (§4, §5)", () => {
    test("text → run started, genui, reply, run finished; sender's own turn not echoed to it", async () => {
        const app = mekik({ graph: greeter, reply: (s) => s.reply as string });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "Ada" } });

        assert.deepEqual(runStatuses(c), ["started", "finished"]);
        const genui = c.sent.filter((f) => f.type === "genui");
        assert.equal(genui.length, 2, "ui chunk + stream_done");
        const reply = c.sent.find((f) => f.type === "text" && f.from === "bot");
        assert.ok(reply && reply.type === "text" && reply.data.text === "Hi, Ada!");
        // The sender never receives its own user text.
        assert.ok(!c.sent.some((f) => f.type === "text" && f.from === "user"));
    });

    test("persistent seq is monotonic and gap-free across the turn", async () => {
        const app = mekik({ graph: greeter, reply: (s) => s.reply as string });
        const c = conn();
        await app.connect(c);
        const { conversationId } = welcomeOf(c);
        await app.receive(c, { type: "text", data: { text: "Ada" } });

        // The transcript holds every persistent frame: user-text(1), ui(2),
        // stream_done(3), reply-text(4).
        const transcript = await app.history.after(conversationId, 0);
        assert.deepEqual(transcript.map((f) => f.seq), [1, 2, 3, 4]);
        // The sender received all but its own un-echoed turn (seq 1).
        const received = c.sent.filter((f): f is Extract<OutgoingFrame, { seq: number }> => "seq" in f).map((f) => f.seq);
        assert.deepEqual(received, [2, 3, 4]);
    });
});

describe("the greeting (§1)", () => {
    test("a string greeting is one bot text frame, sent once", async () => {
        const app = mekik({ graph: greeter, reply: (s) => s.reply as string, greeting: () => "Hi!" });
        const c = conn();
        await app.connect(c);
        const { conversationId, userId } = welcomeOf(c);

        const greeted = c.sent.filter((f) => f.type === "text");
        assert.equal(greeted.length, 1);
        assert.ok(greeted[0]?.type === "text" && greeted[0].data.text === "Hi!" && greeted[0].from === "bot");

        // A reconnect replays it from the transcript rather than greeting twice.
        const again = conn();
        await app.connect(again, { hello: { conversationId, userId, watermark: 0 } });
        assert.equal(again.sent.filter((f) => f.type === "text").length, 1, "replayed, not re-greeted");
    });

    test("a greeting can carry rich messages, in order, each its own persistent frame", async () => {
        const app = mekik({
            graph: greeter,
            reply: (s) => s.reply as string,
            greeting: (conv) => [
                `Hi ${conv.userId}!`,
                mekik.messages.card.spec({ title: "Welcome", buttons: [{ label: "Start", value: "/start" }] }, { id: "hero" }),
                mekik.messages.buttons.spec({ text: "What next?", buttons: [{ label: "Track", value: "/track" }] }),
            ],
        });
        const c = conn();
        await app.connect(c);
        const { conversationId } = welcomeOf(c);

        assert.deepEqual(types(c), ["welcome", "text", "card", "buttons"]);
        const card = c.sent.find((f) => f.type === "card") as MessageOutFrame;
        assert.equal(card.id, "hero", "a spec's id reaches the wire");
        assert.equal(card.from, "bot");
        assert.deepEqual(card.data, { title: "Welcome", buttons: [{ label: "Start", value: "/start" }] });

        // All three are persistent, in one gap-free seq run — so replay is complete.
        const transcript = await app.history.after(conversationId, 0);
        assert.deepEqual(transcript.map((f) => f.type), ["text", "card", "buttons"]);
        assert.deepEqual(transcript.map((f) => f.seq), [1, 2, 3]);
    });

    test("an empty string greets nothing; a reserved frame type is dropped", async () => {
        const empty = mekik({ graph: greeter, reply: (s) => s.reply as string, greeting: () => "" });
        const a = conn();
        await empty.connect(a);
        assert.deepEqual(types(a), ["welcome"]);

        // A hand-built spec can name a reserved type (messageSpec would throw);
        // the engine drops it rather than let it collide with a protocol frame.
        const sneaky = mekik({
            graph: greeter,
            reply: (s) => s.reply as string,
            greeting: () => [{ type: "run", data: { status: "started" } }, "still here"],
        });
        const b = conn();
        await sneaky.connect(b);
        assert.deepEqual(types(b), ["welcome", "text"]);
    });
});

describe("rich message frames (§4.5)", () => {
    /** Emits an image and an id-keyed card message, then replies. */
    const publisher = graph("publisher")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("show", (s, ctx) => {
            mekik.messages.image(ctx, { src: "https://x/receipt.png", caption: "Your receipt" });
            mekik.messages.card(ctx, { title: s.input, buttons: [{ label: "Track" }] }, { id: `card-${s.input}` });
            return { reply: "sent" };
        })
        .edge(START, "show")
        .edge("show", END)
        .compile();

    test("messages persist with the text envelope and replay on reconnect", async () => {
        const app = mekik({ graph: publisher, reply: (s) => s.reply as string });
        const c = conn();
        await app.connect(c);
        const { conversationId, userId } = welcomeOf(c);
        await app.receive(c, { type: "text", data: { text: "ORD-1" } });

        const image = c.sent.find((f) => f.type === "image") as MessageOutFrame | undefined;
        assert.ok(image, "image frame present");
        assert.equal(image.from, "bot");
        assert.equal(typeof image.seq, "number");
        assert.deepEqual(image.data, { src: "https://x/receipt.png", caption: "Your receipt" });
        const card = c.sent.find((f) => f.type === "card") as MessageOutFrame | undefined;
        assert.equal(card?.id, "card-ORD-1", "caller-supplied message id wins");

        // A reconnecting tab replays them from the transcript, in seq order.
        const again = conn();
        await app.connect(again, { hello: { conversationId, userId, watermark: 0 } });
        const replayed = again.sent.map((f) => f.type);
        assert.ok(replayed.includes("image") && replayed.includes("card"), `replay carries the messages, got: ${replayed.join(",")}`);
    });
});

describe("multi-tab fan-out (§1)", () => {
    test("a second connection on the same conversation sees the user's turn and the bot frames", async () => {
        const app = mekik({ graph: greeter, reply: (s) => s.reply as string });
        const a = conn();
        await app.connect(a);
        const { conversationId, userId } = welcomeOf(a);

        const b = conn();
        await app.connect(b, { hello: { conversationId, userId } });

        await app.receive(a, { type: "text", data: { text: "Ada" } });

        // b (the other tab) sees the user's echoed turn...
        assert.ok(b.sent.some((f) => f.type === "text" && f.from === "user" && f.data.text === "Ada"));
        // ...and the bot reply.
        assert.ok(b.sent.some((f) => f.type === "text" && f.from === "bot"));
        // a (the sender) sees the bot reply but not its own user turn.
        assert.ok(!a.sent.some((f) => f.type === "text" && f.from === "user"));
    });
});

describe("watermark replay (§2)", () => {
    test("reconnect with a watermark replays exactly the persistent tail", async () => {
        const app = mekik({ graph: greeter, reply: (s) => s.reply as string });
        const a = conn();
        await app.connect(a);
        const { conversationId, userId } = welcomeOf(a);
        await app.receive(a, { type: "text", data: { text: "Ada" } });
        // seqs 1..4 now exist. Reconnect a fresh tab caught up to seq 2.

        const b = conn();
        await app.connect(b, { hello: { conversationId, userId, watermark: 2 } });

        const replayed = b.sent.filter((f) => f.type !== "welcome");
        assert.deepEqual(replayed.map((f) => (f as { seq: number }).seq), [3, 4]);
        // Transient frames (run) are never replayed.
        assert.ok(!replayed.some((f) => f.type === "run"));
    });
});

describe("single approval round-trip (§4.4, §5)", () => {
    test("interrupt → new turn refused → resume → resolved → finished", async () => {
        const app = mekik({ graph: approval, reply: (s) => s.reply as string });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "refund" } });

        // Parked on the approval.
        assert.deepEqual(runStatuses(c), ["started", "interrupted"]);
        const intr = first(c, "interrupt");
        assert.ok(intr.data.ui && intr.data.ui.component === "approval-form");
        assert.deepEqual(intr.data.payload, { title: "approve refund?" });
        const interruptId = intr.id;

        // A new turn while parked is refused (§5.4).
        const before = c.sent.length;
        await app.receive(c, { type: "text", data: { text: "another" } });
        const err = c.sent.slice(before).find((f) => f.type === "error");
        assert.ok(err && err.type === "error" && err.data.code === "interrupted");

        // Resume by id.
        await app.receive(c, { type: "resume", answers: { [interruptId]: { approved: true } } });
        const resolved = first(c, "interrupt_resolved");
        assert.equal(resolved.id, interruptId);
        assert.ok(c.sent.some((f) => f.type === "text" && f.from === "bot" && f.data.text === "approved"));
        assert.deepEqual(runStatuses(c), ["started", "interrupted", "started", "finished"]);
    });
});

describe("concurrent interrupts routed by id (§4.4)", () => {
    test("two pending get distinct ids; an incomplete resume is refused; a full resume finishes", async () => {
        const app = mekik({ graph: batch, input: () => ({ items: ["A", "B"] }) });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "go" } });

        const interrupts = c.sent.filter((f): f is Extract<OutgoingFrame, { type: "interrupt" }> => f.type === "interrupt");
        assert.equal(interrupts.length, 2);
        const ids = interrupts.map((f) => f.id);
        assert.equal(new Set(ids).size, 2, "ids must be distinct even though the ilmek key is identical");

        // Answering only one is rejected (ilmek resumeKeyed needs all).
        const before = c.sent.length;
        await app.receive(c, { type: "resume", answers: { [ids[0]!]: true } });
        const err = c.sent.slice(before).find((f) => f.type === "error");
        assert.ok(err && err.type === "error" && err.data.code === "incomplete_resume");

        // Answering both finishes the run.
        await app.receive(c, { type: "resume", answers: { [ids[0]!]: true, [ids[1]!]: true } });
        const resolvedIds = c.sent
            .filter((f) => f.type === "interrupt_resolved")
            .map((f) => (f as { id: string }).id)
            .sort();
        assert.deepEqual(resolvedIds, [...ids].sort());
        assert.ok(runStatuses(c).includes("finished"));
    });
});

describe("reconnect while interrupted (§3.2)", () => {
    test("welcome re-announces open interrupts with their ui", async () => {
        const app = mekik({ graph: approval, reply: (s) => s.reply as string });
        const a = conn();
        await app.connect(a);
        const { conversationId, userId } = welcomeOf(a);
        await app.receive(a, { type: "text", data: { text: "refund" } });

        const b = conn();
        await app.connect(b, { hello: { conversationId, userId } });
        const pending = welcomeOf(b).pending;
        assert.equal(pending.length, 1);
        assert.equal(pending[0]!.data.ui?.component, "approval-form");
    });
});

describe("the turn lock and abort (§5)", () => {
    test("a second text while a run is in flight gets busy", async () => {
        const gate = deferred();
        const app = mekik({ graph: makeGatedGraph(gate.promise), reply: (s) => s.reply as string });
        const c = conn();
        await app.connect(c);

        const running = app.receive(c, { type: "text", data: { text: "one" } }); // do not await - it's gated
        await Promise.resolve(); // let the run reach its await
        await app.receive(c, { type: "text", data: { text: "two" } });
        const err = c.sent.find((f) => f.type === "error");
        assert.ok(err && err.type === "error" && err.data.code === "busy");

        gate.resolve();
        await running;
        assert.ok(runStatuses(c).includes("finished"));
    });

    test("abort ends the in-flight run as aborted", async () => {
        const gate = deferred();
        const app = mekik({ graph: makeGatedGraph(gate.promise), reply: (s) => s.reply as string });
        const c = conn();
        await app.connect(c);

        const running = app.receive(c, { type: "text", data: { text: "one" } });
        await Promise.resolve();
        await app.receive(c, { type: "abort" });
        gate.resolve(); // even once ungated, the abort already stopped the superstep loop
        await running;
        assert.ok(runStatuses(c).includes("aborted"));
    });
});

describe("auth (§7)", () => {
    const authed = () =>
        mekik({
            graph: greeter,
            reply: (s) => s.reply as string,
            authenticator: new StaticTokenAuthenticator({ "good-token": { userId: "u-42", claims: { role: "admin" } } }),
        });

    test("a bad token is rejected with unauthorized + close 4401", async () => {
        const app = authed();
        const c = conn();
        await app.connect(c, { hello: { token: "nope" } });
        const err = first(c, "error");
        assert.equal(err.data.code, "unauthorized");
        assert.equal(c.closed?.code, 4401);
    });

    test("a verified userId overrides a spoofed asserted one", async () => {
        const app = authed();
        const c = conn();
        await app.connect(c, { hello: { token: "good-token", userId: "i-am-someone-else" } });
        assert.equal(welcomeOf(c).userId, "u-42");
    });
});

// ── §10 server-defined components ──────────────────────────────────────────────

describe("server-defined components", () => {
    const orderCard = {
        name: "order-card",
        template: `<h3>{{title}}</h3><button data-event="track_order">Track</button>`,
        props: { title: "" },
    };
    const withComponents = () => mekik({ graph: greeter, reply: (s) => s.reply as string, components: [orderCard] });

    test("announces the catalog right after welcome", async () => {
        const app = withComponents();
        const c = conn();
        await app.connect(c);

        assert.deepEqual(types(c).slice(0, 2), ["welcome", "genui_components"]);
        const frame = first(c, "genui_components");
        assert.deepEqual(frame.components, [orderCard]);
        assert.match(frame.hash, /^[0-9a-f]{64}$/);
        assert.equal(frame.unchanged, undefined);
    });

    test("answers `unchanged` when the client already has that catalog", async () => {
        const app = withComponents();
        const hash = first(await connected(app), "genui_components").hash;

        const c = conn();
        await app.connect(c, { hello: { componentsHash: hash } });

        const frame = first(c, "genui_components");
        assert.equal(frame.unchanged, true);
        assert.equal(frame.components, undefined);
        assert.equal(frame.hash, hash);
    });

    test("re-sends the markup when the client's hash is stale", async () => {
        const app = withComponents();
        const c = conn();
        await app.connect(c, { hello: { componentsHash: "an-old-hash" } });

        const frame = first(c, "genui_components");
        assert.equal(frame.unchanged, undefined);
        assert.deepEqual(frame.components, [orderCard]);
    });

    test("sends no catalog frame when the server defines no components", async () => {
        const app = mekik({ graph: greeter, reply: (s) => s.reply as string });
        const c = conn();
        await app.connect(c);

        assert.equal(types(c).includes("genui_components"), false);
    });

    test("the catalog frame is transient — it carries no seq and never replays", async () => {
        const app = withComponents();
        const c1 = conn();
        await app.connect(c1);
        await app.receive(c1, { type: "text", data: { text: "world" } });

        const frame = first(c1, "genui_components") as unknown as { seq?: number };
        assert.equal(frame.seq, undefined);

        // A reconnect at the current watermark replays the transcript tail only;
        // the one catalog frame it gets is this connect's own announcement.
        const c2 = conn();
        await app.connect(c2, { hello: { conversationId: welcomeOf(c1).conversationId, watermark: welcomeOf(c1).watermark } });
        assert.equal(c2.sent.filter((f) => f.type === "genui_components").length, 1);
    });

    /** Connect a throwaway connection just to read the catalog hash off it. */
    async function connected(app: ReturnType<typeof mekik>) {
        const c = conn();
        await app.connect(c);
        return c;
    }
});

// ── §10.4 component interaction ────────────────────────────────────────────────

describe("component events (§10.4)", () => {
    const clickEvent = { type: "genui_event" as const, streamId: "stream-1", eventType: "track_order", payload: { id: "ORD-42" } };

    test("without a handler a component event is inert", async () => {
        const app = mekik({ graph: greeter, reply: (s) => s.reply as string });
        const c = conn();
        await app.connect(c);
        const before = c.sent.length;

        await app.receive(c, clickEvent);

        assert.equal(c.sent.length, before);
    });

    test("a handler that returns an update runs a turn on it", async () => {
        const seen: GenUiEvent[] = [];
        const app = mekik({
            graph: greeter,
            reply: (s) => s.reply as string,
            onGenUiEvent: (ev) => {
                seen.push(ev);
                return { input: (ev.payload as { id: string }).id };
            },
        });
        const c = conn();
        await app.connect(c);
        await app.receive(c, clickEvent);

        assert.deepEqual(runStatuses(c), ["started", "finished"]);
        assert.ok(c.sent.some((f) => f.type === "text" && f.from === "bot" && f.data.text === "Hi, ORD-42!"));

        // The handler sees the whole interaction, not just the payload.
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.eventType, "track_order");
        assert.equal(seen[0]!.streamId, "stream-1");
        assert.deepEqual(seen[0]!.payload, { id: "ORD-42" });
        assert.equal(seen[0]!.conversationId, welcomeOf(c).conversationId);
        assert.equal(seen[0]!.userId, welcomeOf(c).userId);
    });

    test("a click is not an utterance — no user text lands in the transcript", async () => {
        const app = mekik({ graph: greeter, reply: (s) => s.reply as string, onGenUiEvent: () => ({ input: "ORD-42" }) });
        const c = conn();
        await app.connect(c);
        await app.receive(c, clickEvent);

        assert.equal(c.sent.some((f) => f.type === "text" && f.from === "user"), false);
    });

    test("a handler that returns undefined starts no turn", async () => {
        const app = mekik({ graph: greeter, reply: (s) => s.reply as string, onGenUiEvent: () => undefined });
        const c = conn();
        await app.connect(c);
        const before = c.sent.length;

        await app.receive(c, clickEvent);

        assert.equal(c.sent.length, before);
    });

    test("a submit answering an open interrupt resumes — the handler never sees it", async () => {
        let handled = 0;
        const app = mekik({
            graph: approval,
            reply: (s) => s.reply as string,
            onGenUiEvent: () => {
                handled++;
                return { input: "should not happen" };
            },
        });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "refund" } });
        const interruptId = first(c, "interrupt").id;

        await app.receive(c, {
            type: "genui_event",
            streamId: "stream-1",
            eventType: "submit",
            payload: { id: interruptId, answer: { approved: true } },
        });

        assert.equal(handled, 0, "the §4.4 shortcut wins over the handler");
        assert.equal(first(c, "interrupt_resolved").id, interruptId);
        assert.ok(c.sent.some((f) => f.type === "text" && f.from === "bot" && f.data.text === "approved"));
    });

    test("a submit naming no open interrupt falls through to the handler", async () => {
        const seen: string[] = [];
        const app = mekik({
            graph: greeter,
            reply: (s) => s.reply as string,
            onGenUiEvent: (ev) => {
                seen.push(ev.eventType);
                return undefined;
            },
        });
        const c = conn();
        await app.connect(c);

        await app.receive(c, { type: "genui_event", streamId: "stream-1", eventType: "submit", payload: { id: "no-such-interrupt" } });

        assert.deepEqual(seen, ["submit"]);
    });

    test("a component-driven turn cannot overtake a pause", async () => {
        const app = mekik({ graph: approval, reply: (s) => s.reply as string, onGenUiEvent: () => ({ input: "again" }) });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "refund" } });
        const before = c.sent.length;

        await app.receive(c, clickEvent);

        const err = c.sent.slice(before).find((f) => f.type === "error");
        assert.ok(err && err.type === "error" && err.data.code === "interrupted");
        assert.deepEqual(runStatuses(c), ["started", "interrupted"], "the parked run is untouched");
    });
});

// ── §10.4 a node waiting on a component's own event ────────────────────────────

describe("mekik.onEvent — the in-graph listener (§10.4)", () => {
    /** Start `awaiting` and park it on the card's `track_order`. */
    async function parked(onGenUiEvent?: (ev: GenUiEvent) => Record<string, unknown> | undefined) {
        const app = mekik({
            graph: awaiting,
            reply: (s) => s.reply as string,
            ...(onGenUiEvent ? { onGenUiEvent } : {}),
        });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "ORD-42" } });
        return { app, c };
    }

    test("the pause announces which event it waits for, and offers no chips", async () => {
        const { c } = await parked();

        assert.deepEqual(runStatuses(c), ["started", "interrupted"]);
        const intr = first(c, "interrupt");
        assert.equal(intr.data.event, "track_order");
        assert.equal(intr.data.actions, undefined, "a widget answers this, not default Approve/Cancel chips");
    });

    test("a component-event resolves it, and its payload is the return value", async () => {
        const { app, c } = await parked();

        await app.receive(c, {
            type: "genui_event",
            streamId: "stream-1",
            eventType: "track_order",
            scope: "component",
            payload: { id: "ORD-42" },
        });

        assert.deepEqual(runStatuses(c), ["started", "interrupted", "started", "finished"]);
        assert.ok(c.sent.some((f) => f.type === "text" && f.from === "bot" && f.data.text === "tracking ORD-42"));
    });

    test("a plain data-event resolves it too — an unscoped event tries both routes", async () => {
        const { app, c } = await parked();

        await app.receive(c, { type: "genui_event", streamId: "stream-1", eventType: "track_order", payload: { id: "ORD-42" } });

        assert.ok(c.sent.some((f) => f.type === "text" && f.from === "bot" && f.data.text === "tracking ORD-42"));
    });

    test("a mekik-event never resolves a pause — it is addressed to the graph", async () => {
        let handled = 0;
        const { app, c } = await parked(() => {
            handled++;
            return { input: "ORD-99" };
        });
        const before = c.sent.length;

        await app.receive(c, {
            type: "genui_event",
            streamId: "stream-1",
            eventType: "track_order",
            scope: "graph",
            payload: { id: "ORD-42" },
        });

        assert.equal(handled, 1, "it went to the graph handler, not the waiting node");
        const err = c.sent.slice(before).find((f) => f.type === "error");
        assert.ok(err && err.type === "error" && err.data.code === "interrupted", "…and a new turn cannot overtake the pause");
        assert.deepEqual(runStatuses(c), ["started", "interrupted"], "the pause still stands");
    });

    test("an event no node is waiting for does not reach the graph handler when component-scoped", async () => {
        let handled = 0;
        const { app, c } = await parked(() => {
            handled++;
            return undefined;
        });

        await app.receive(c, {
            type: "genui_event",
            streamId: "stream-1",
            eventType: "some_other_button",
            scope: "component",
            payload: {},
        });

        assert.equal(handled, 0, "a component-event is for a component's own pause, nothing else");
        assert.deepEqual(runStatuses(c), ["started", "interrupted"]);
    });

    test("a submit naming the interrupt still wins, whatever the scope says", async () => {
        const { app, c } = await parked();
        const interruptId = first(c, "interrupt").id;

        await app.receive(c, {
            type: "genui_event",
            streamId: "stream-1",
            eventType: "submit",
            scope: "graph",
            payload: { id: interruptId, answer: { id: "ORD-7" } },
        });

        assert.ok(c.sent.some((f) => f.type === "text" && f.from === "bot" && f.data.text === "tracking ORD-7"));
    });

    test("an unknown scope is a bad_request", async () => {
        const { app, c } = await parked();

        await app.receive(c, { type: "genui_event", streamId: "stream-1", eventType: "track_order", scope: "everywhere" });

        const err = c.sent.at(-1);
        assert.ok(err && err.type === "error" && err.data.code === "bad_request");
    });
});
