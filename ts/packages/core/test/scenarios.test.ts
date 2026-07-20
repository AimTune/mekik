// The behavioural conformance suite (conformance/README.md, "Scenario suites").
// Drives the real ConversationEngine over in-memory connections and real ilmek
// graphs - the things a pure event→frame fixture can't cover: handshake, replay,
// fan-out, resume routing, the turn lock, auth.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { channel, command, END, graph, send, START } from "@ilmek/core";

import { mekik } from "../src/index.ts";
import type { Connection } from "../src/engine.ts";
import type { OutgoingFrame, RunStatus } from "../src/protocol.ts";
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
