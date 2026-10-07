// Engine edge cases (PROTOCOL.md §1–§7). scenarios.test.ts pins the happy paths
// of the conformance scenario list; this suite pins what happens at the edges —
// malformed frames, watermarks that are stale or ahead, resumes that are
// partial, doubled or racing, two tabs answering one pause, auth corner cases,
// ports that fail. Every assertion is about frames in and frames out.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { channel, END, graph, START } from "@ilmek/core";

import { mekik } from "../src/index.ts";
import type { Connection } from "../src/engine.ts";
import type { OutgoingFrame, RunStatus } from "../src/protocol.ts";
import { InMemoryHistoryStore, type PersistentFrame } from "../src/stores.ts";
import type { Backplane, BackplaneMessage, Subscription, TurnLease, TurnLock } from "../src/scaling.ts";

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
const conn = (): FakeConn => new FakeConn(`edge-${++connSeq}`);

type Of<T extends OutgoingFrame["type"]> = Extract<OutgoingFrame, { type: T }>;
const all = <T extends OutgoingFrame["type"]>(c: FakeConn, t: T): Of<T>[] => c.sent.filter((f) => f.type === t) as Of<T>[];
const first = <T extends OutgoingFrame["type"]>(c: FakeConn, t: T): Of<T> => all(c, t)[0]!;
const types = (c: FakeConn): string[] => c.sent.map((f) => f.type);
const runStatuses = (c: FakeConn): RunStatus[] => all(c, "run").map((f) => f.data.status);
const errorCodes = (c: FakeConn): string[] => all(c, "error").map((f) => f.data.code);
const welcomeOf = (c: FakeConn) => first(c, "welcome").data;
const seqs = (c: FakeConn): number[] => c.sent.filter((f) => "seq" in f).map((f) => (f as { seq: number }).seq);
const botTexts = (c: FakeConn): string[] => all(c, "text").filter((f) => f.from === "bot").map((f) => f.data.text);
const since = (c: FakeConn, n: number): OutgoingFrame[] => c.sent.slice(n);

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

/** Yield to the event loop until `cond` holds (bounded, so a broken test fails instead of hanging). */
async function until(cond: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 1000; i++) {
        if (cond()) return;
        await new Promise((r) => setImmediate(r));
    }
    assert.fail(`timed out waiting for ${what}`);
}

// ── graphs ────────────────────────────────────────────────────────────────────

const echo = graph("echo")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("say", (s) => ({ reply: `echo:${s.input}` }))
    .edge(START, "say")
    .edge("say", END)
    .compile();

const approval = graph("approval")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("gate", async (s, ctx) => {
        const answer = await mekik.approve<{ approved: boolean }>(ctx, { title: `approve ${s.input}?` }, { actions: [{ label: "Yes", value: { approved: true } }] });
        return { reply: answer?.approved ? "approved" : "rejected" };
    })
    .edge(START, "gate")
    .edge("gate", END)
    .compile();

/** Replies with what the node sees in ctx.meta — the §6 context, observed. */
const metaProbe = graph("meta-probe")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("look", (_s, ctx) => {
        const m = ctx.meta as Record<string, unknown>;
        return { reply: JSON.stringify({ mekik: m.mekik, client: m.client, auth: m.auth }) };
    })
    .edge(START, "look")
    .edge("look", END)
    .compile();

const thrower = graph("thrower")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("boom", (s) => {
        if (s.input === "boom") throw new Error("kaput");
        return { reply: `ok:${s.input}` };
    })
    .edge(START, "boom")
    .edge("boom", END)
    .compile();

/** Streams "a", waits on `gate`, streams "b", replies — a run you can hold mid-stream. */
function stepper(gate: Promise<void>) {
    return graph("stepper")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("go", async (_s, ctx) => {
            mekik.text(ctx, "a");
            await gate;
            mekik.text(ctx, "b");
            return { reply: "done" };
        })
        .edge(START, "go")
        .edge("go", END)
        .compile();
}

/** Approves, then waits on `gate` before finishing — a resume you can hold in flight. */
function slowAfterApproval(gate: Promise<void>) {
    return graph("slow-approval")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("gate", async (_s, ctx) => {
            await mekik.approve(ctx, { title: "go?" });
            await gate;
            return { reply: "resumed" };
        })
        .edge(START, "gate")
        .edge("gate", END)
        .compile();
}

const replyOf = (s: Record<string, unknown>) => s.reply as string;

// ── malformed frames (§3.1) ───────────────────────────────────────────────────

describe("malformed frames draw error{bad_request} and leave the connection usable (§3.1)", () => {
    const cases: Array<[string, unknown]> = [
        ["invalid JSON text", "{not json"],
        ["a JSON string, not an object", '"hello"'],
        ["a JSON number", "42"],
        ["JSON null", "null"],
        ["a JSON array", "[]"],
        ["a parsed null", null],
        ["a missing type", { data: { text: "hi" } }],
        ["a non-string type", { type: 7 }],
        ["an unknown type", { type: "typing" }],
        ["a server-only type sent by a client", { type: "welcome", data: {} }],
        ["text without data", { type: "text" }],
        ["text whose data.text is not a string", { type: "text", data: { text: 42 } }],
        ["text whose data is null", { type: "text", data: null }],
        ["resume without answers", { type: "resume" }],
        ["resume whose answers is an array", { type: "resume", answers: [] }],
        ["resume whose answers is null", { type: "resume", answers: null }],
        ["resume whose answers is a string", { type: "resume", answers: "yes" }],
        ["genui_event without streamId", { type: "genui_event", eventType: "x" }],
        ["genui_event with a numeric eventType", { type: "genui_event", streamId: "s", eventType: 1 }],
        ["genui_event with an unknown scope", { type: "genui_event", streamId: "s", eventType: "x", scope: "page" }],
        ["client_tools whose tools is an object", { type: "client_tools", tools: {} }],
        ["client_tools without tools", { type: "client_tools" }],
        ["client_skills whose skills is a string", { type: "client_skills", skills: "pdf" }],
        ["client_skills without skills", { type: "client_skills" }],
    ];

    for (const [what, raw] of cases) {
        test(`${what} → bad_request, then a valid turn still runs`, async () => {
            const app = mekik({ graph: echo, reply: replyOf });
            const c = conn();
            await app.connect(c);
            const before = c.sent.length;

            await app.receive(c, raw);

            const after = since(c, before);
            assert.equal(after.length, 1, "exactly one frame answers a malformed one");
            assert.equal(after[0]!.type, "error");
            assert.equal((after[0] as Of<"error">).data.code, "bad_request");
            assert.equal(typeof (after[0] as Of<"error">).data.message, "string");
            assert.equal(c.closed, null, "the connection is never closed for a bad frame");

            await app.receive(c, { type: "text", data: { text: "still here" } });
            assert.deepEqual(botTexts(c), ["echo:still here"]);
        });
    }

    test("a valid frame as a JSON string is accepted the same as a parsed object", async () => {
        const app = mekik({ graph: echo, reply: replyOf });
        const c = conn();
        await app.connect(c);
        await app.receive(c, JSON.stringify({ type: "text", data: { text: "raw" } }));
        assert.deepEqual(botTexts(c), ["echo:raw"]);
    });

    test("unknown extra fields on a known frame are ignored (additive-change rule)", async () => {
        const app = mekik({ graph: echo, reply: replyOf });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "x", extra: true }, future: { v: 2 } });
        assert.deepEqual(errorCodes(c), []);
        assert.deepEqual(botTexts(c), ["echo:x"]);
    });

    test("a frame before connect draws error{no_session}", async () => {
        const app = mekik({ graph: echo, reply: replyOf });
        const c = conn();
        await app.receive(c, { type: "text", data: { text: "early" } });
        assert.deepEqual(errorCodes(c), ["no_session"]);
        assert.equal(c.sent.some((f) => f.type === "run"), false, "no run starts for an unknown connection");
    });

    test("a frame after disconnect draws error{no_session}", async () => {
        const app = mekik({ graph: echo, reply: replyOf });
        const c = conn();
        await app.connect(c);
        app.disconnect(c);
        const before = c.sent.length;
        await app.receive(c, { type: "text", data: { text: "late" } });
        assert.deepEqual(since(c, before).map((f) => f.type), ["error"]);
        assert.deepEqual(errorCodes(c), ["no_session"]);
    });

    test("a malformed frame before connect is a bad_request, not no_session (parse comes first)", async () => {
        const app = mekik({ graph: echo, reply: replyOf });
        const c = conn();
        await app.receive(c, "nope");
        assert.deepEqual(errorCodes(c), ["bad_request"]);
    });
});

// ── hello / handshake (§1) ────────────────────────────────────────────────────

describe("handshake edges (§1)", () => {
    test("a re-hello mid-session is ignored: no frames, identity unchanged", async () => {
        const app = mekik({ graph: echo, reply: replyOf });
        const c = conn();
        await app.connect(c);
        const { conversationId } = welcomeOf(c);
        const before = c.sent.length;

        await app.receive(c, { type: "hello", userId: "someone-else", conversationId: "conv-other", watermark: 0 });

        assert.equal(c.sent.length, before);
        await app.receive(c, { type: "text", data: { text: "x" } });
        const transcript = await app.history.after(conversationId, 0);
        assert.equal(transcript.length, 2, "the turn landed on the original conversation");
    });

    test("an unknown asserted conversation is replaced by a fresh one; the watermark resets", async () => {
        const app = mekik({ graph: echo, reply: replyOf, greeting: () => "hi" });
        const c = conn();
        await app.connect(c, { hello: { userId: "u1", conversationId: "conv-does-not-exist", watermark: 50 } });
        const w = welcomeOf(c);
        assert.notEqual(w.conversationId, "conv-does-not-exist");
        assert.equal(w.userId, "u1");
        assert.equal(w.watermark, 0);
        // The greeting still lands (seq 1) — the stale watermark of 50 did not hide it.
        assert.deepEqual(seqs(c), [1]);
    });

    test("the owner re-adopts its conversation; the asserted userId is kept", async () => {
        const app = mekik({ graph: echo, reply: replyOf });
        const a = conn();
        await app.connect(a, { hello: { userId: "u1" } });
        const { conversationId } = welcomeOf(a);
        await app.receive(a, { type: "text", data: { text: "x" } });

        const b = conn();
        await app.connect(b, { hello: { userId: "u1", conversationId } });
        assert.equal(welcomeOf(b).conversationId, conversationId);
        assert.equal(welcomeOf(b).watermark, 2);
    });

    test("an anonymous connect cannot adopt a conversation (the minted user never owns it)", async () => {
        const app = mekik({ graph: echo, reply: replyOf });
        const a = conn();
        await app.connect(a, { hello: { userId: "u1" } });
        const { conversationId } = welcomeOf(a);
        await app.receive(a, { type: "text", data: { text: "secret" } });

        const b = conn();
        await app.connect(b, { hello: { conversationId, watermark: 0 } });
        assert.notEqual(welcomeOf(b).conversationId, conversationId);
        assert.deepEqual(types(b), ["welcome"], "nothing of u1's transcript replays");
    });

    test("every connection gets its own connectionId echoed in welcome", async () => {
        const app = mekik({ graph: echo, reply: replyOf });
        const a = conn();
        const b = conn();
        await app.connect(a);
        await app.connect(b);
        assert.equal(welcomeOf(a).connectionId, a.id);
        assert.equal(welcomeOf(b).connectionId, b.id);
        assert.notEqual(welcomeOf(a).conversationId, welcomeOf(b).conversationId, "two anonymous connects are two conversations");
        assert.notEqual(welcomeOf(a).userId, welcomeOf(b).userId);
    });

    test("frame order on connect: welcome → genui_components → skills → replay tail", async () => {
        const app = mekik({
            graph: echo,
            reply: replyOf,
            components: [{ name: "order-card", template: "<b>{{x}}</b>" }],
            skills: [{ name: "pdf", description: "PDFs.", instructions: "…" }],
        });
        const a = conn();
        await app.connect(a, { hello: { userId: "u" } });
        await app.receive(a, { type: "text", data: { text: "x" } });

        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId: welcomeOf(a).conversationId, watermark: 0 } });
        assert.deepEqual(types(b), ["welcome", "genui_components", "skills", "text", "text"]);
    });
});

// ── context (§6) ──────────────────────────────────────────────────────────────

describe("graph context (§6)", () => {
    test("meta.mekik is the context function's result for this conversation and turn", async () => {
        const app = mekik({
            graph: metaProbe,
            reply: replyOf,
            context: (conv, turn) => ({ conv: conv.conversationId, user: conv.userId, said: turn.text, turnMeta: turn.meta ?? null }),
        });
        const c = conn();
        await app.connect(c, { hello: { userId: "u7" } });
        await app.receive(c, { type: "text", data: { text: "hi" }, meta: { page: "/cart" } });

        const seen = JSON.parse(botTexts(c)[0]!) as { mekik: Record<string, unknown> };
        assert.deepEqual(seen.mekik, { conv: welcomeOf(c).conversationId, user: "u7", said: "hi", turnMeta: { page: "/cart" } });
    });

    test("client meta is dropped by default — no acceptClientMeta, no meta.client", async () => {
        const app = mekik({ graph: metaProbe, reply: replyOf });
        const c = conn();
        await app.connect(c, { hello: { meta: { plan: "pro" } } });
        await app.receive(c, { type: "text", data: { text: "x" }, meta: { page: "/cart" } });
        assert.deepEqual(JSON.parse(botTexts(c)[0]!), {});
    });

    test("acceptClientMeta is the allowlist for frame meta", async () => {
        const app = mekik({
            graph: metaProbe,
            reply: replyOf,
            acceptClientMeta: (m) => (typeof m.page === "string" ? { page: m.page } : undefined),
        });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "x" }, meta: { page: "/cart", isAdmin: true } });
        assert.deepEqual(JSON.parse(botTexts(c)[0]!).client, { page: "/cart" });
    });

    test("an allowlist returning undefined leaves meta.client absent", async () => {
        const app = mekik({ graph: metaProbe, reply: replyOf, acceptClientMeta: () => undefined });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "x" }, meta: { page: "/cart" } });
        assert.equal(JSON.parse(botTexts(c)[0]!).client, undefined);
    });

    test("hello.meta reaches meta.client through the allowlist, and frame meta overrides it per key", async () => {
        const app = mekik({ graph: metaProbe, reply: replyOf, acceptClientMeta: (m) => m });
        const c = conn();
        await app.connect(c, { hello: { meta: { locale: "tr-TR", page: "/home" } } });

        await app.receive(c, { type: "text", data: { text: "one" } });
        assert.deepEqual(JSON.parse(botTexts(c)[0]!).client, { locale: "tr-TR", page: "/home" }, "hello.meta alone");

        await app.receive(c, { type: "text", data: { text: "two" }, meta: { page: "/cart" } });
        assert.deepEqual(JSON.parse(botTexts(c)[1]!).client, { locale: "tr-TR", page: "/cart" }, "frame meta wins per key");
    });

    test("hello.meta is per-connection: another tab's hello.meta never leaks into this tab's turn", async () => {
        const app = mekik({ graph: metaProbe, reply: replyOf, acceptClientMeta: (m) => m });
        const a = conn();
        await app.connect(a, { hello: { userId: "u", meta: { tab: "a" } } });
        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId: welcomeOf(a).conversationId, meta: { tab: "b" } } });

        await app.receive(b, { type: "text", data: { text: "x" } });
        assert.deepEqual(JSON.parse(botTexts(b)[0]!).client, { tab: "b" });
    });
});

// ── watermark replay (§2) ─────────────────────────────────────────────────────

describe("watermark replay edges (§2)", () => {
    async function withTranscript() {
        const app = mekik({ graph: echo, reply: replyOf });
        const a = conn();
        await app.connect(a, { hello: { userId: "u" } });
        await app.receive(a, { type: "text", data: { text: "one" } }); // seq 1 (user), 2 (bot)
        await app.receive(a, { type: "text", data: { text: "two" } }); // seq 3, 4
        return { app, conversationId: welcomeOf(a).conversationId };
    }

    test("no watermark replays the whole transcript", async () => {
        const { app, conversationId } = await withTranscript();
        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId } });
        assert.deepEqual(seqs(b), [1, 2, 3, 4]);
    });

    test("a watermark equal to the server's replays nothing", async () => {
        const { app, conversationId } = await withTranscript();
        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId, watermark: 4 } });
        assert.deepEqual(types(b), ["welcome"]);
        assert.equal(welcomeOf(b).watermark, 4);
    });

    test("a watermark beyond the server's replays nothing and welcome reports the server's watermark", async () => {
        const { app, conversationId } = await withTranscript();
        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId, watermark: 999 } });
        assert.deepEqual(types(b), ["welcome"]);
        assert.equal(welcomeOf(b).watermark, 4, "the client learns where the server really is");
    });

    test("a negative watermark is treated like zero — the whole transcript", async () => {
        const { app, conversationId } = await withTranscript();
        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId, watermark: -3 } });
        assert.deepEqual(seqs(b), [1, 2, 3, 4]);
    });

    test("replay carries user turns too — including the replaying tab's own", async () => {
        const { app, conversationId } = await withTranscript();
        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId, watermark: 0 } });
        assert.deepEqual(
            all(b, "text").map((f) => `${f.from}:${f.data.text}`),
            ["user:one", "bot:echo:one", "user:two", "bot:echo:two"],
        );
    });

    test("after a replay, live frames continue the seq without a gap or a repeat", async () => {
        const { app, conversationId } = await withTranscript();
        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId, watermark: 2 } });
        await app.receive(b, { type: "text", data: { text: "three" } });
        // Replay 3,4; then live 6 (bot) — 5 is b's own user turn, not echoed to b.
        assert.deepEqual(seqs(b), [3, 4, 6]);
    });

    test("a tab that connects mid-stream sees every frame exactly once, in seq order", async () => {
        const gate = deferred();
        const history = new HeldHistory();
        const app = mekik({ graph: stepper(gate.promise), reply: replyOf, history });
        const a = conn();
        await app.connect(a, { hello: { userId: "u" } });
        const { conversationId } = welcomeOf(a);

        const running = app.receive(a, { type: "text", data: { text: "go" } });
        await until(() => all(a, "genui").length === 1, "the first streamed chunk");

        // The second tab's replay read is held, so live frames land while it is
        // still catching up — the window where a frame could arrive twice.
        const held = history.holdNextAfter();
        const b = conn();
        const joining = app.connect(b, { hello: { userId: "u", conversationId, watermark: 0 } });
        await until(() => held.reached, "the replay read");
        gate.resolve();
        await running;
        held.release();
        await joining;

        const bSeqs = seqs(b);
        assert.deepEqual(bSeqs, [...bSeqs].sort((x, y) => x - y), "strictly in seq order");
        assert.equal(new Set(bSeqs).size, bSeqs.length, `no seq delivered twice: ${bSeqs.join(",")}`);
        const transcript = await app.history.after(conversationId, 0);
        assert.deepEqual(bSeqs, transcript.map((f) => f.seq), "every persistent frame, none missing");
        assert.equal(b.sent[0]!.type, "welcome", "welcome is still the first frame");
    });
});

/** A history store whose next `after()` can be held open — to widen the replay window. */
class HeldHistory extends InMemoryHistoryStore {
    private hold: { reached: boolean; gate: Promise<void> } | null = null;

    holdNextAfter(): { readonly reached: boolean; release: () => void } {
        const d = deferred();
        const h = { reached: false, gate: d.promise };
        this.hold = h;
        return {
            get reached() {
                return h.reached;
            },
            release: () => d.resolve(),
        };
    }

    override async after(conversationId: string, watermark: number): Promise<PersistentFrame[]> {
        const h = this.hold;
        if (h) {
            this.hold = null;
            h.reached = true;
            await h.gate;
        }
        return super.after(conversationId, watermark);
    }
}

// ── interrupts & resume (§4.4, §5) ────────────────────────────────────────────

describe("resume edges (§4.4)", () => {
    async function parked() {
        const app = mekik({ graph: approval, reply: replyOf });
        const c = conn();
        await app.connect(c, { hello: { userId: "u" } });
        await app.receive(c, { type: "text", data: { text: "refund" } });
        return { app, c, id: first(c, "interrupt").id };
    }

    test("resume with nothing parked → not_interrupted, no run", async () => {
        const app = mekik({ graph: echo, reply: replyOf });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "resume", answers: { "anything": true } });
        assert.deepEqual(errorCodes(c), ["not_interrupted"]);
        assert.deepEqual(runStatuses(c), []);
    });

    test("resume with empty answers {} → incomplete_resume naming the open id", async () => {
        const { app, c, id } = await parked();
        await app.receive(c, { type: "resume", answers: {} });
        const err = all(c, "error").at(-1)!;
        assert.equal(err.data.code, "incomplete_resume");
        assert.ok(err.data.message.includes(id), "the message names what is missing");
        assert.deepEqual(runStatuses(c), ["started", "interrupted"]);
    });

    test("resume naming only an unknown id → incomplete_resume; the pause stands", async () => {
        const { app, c } = await parked();
        await app.receive(c, { type: "resume", answers: { "no-such-interrupt": true } });
        assert.deepEqual(errorCodes(c), ["incomplete_resume"]);
        assert.equal(all(c, "interrupt_resolved").length, 0);

        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId: welcomeOf(c).conversationId } });
        assert.equal(welcomeOf(b).pending.length, 1, "still parked");
    });

    test("an extra unknown id alongside the real one: only the open pause is resolved", async () => {
        const { app, c, id } = await parked();
        await app.receive(c, { type: "resume", answers: { [id]: { approved: true }, bogus: 1 } });
        assert.deepEqual(all(c, "interrupt_resolved").map((f) => f.id), [id]);
        assert.deepEqual(botTexts(c), ["approved"]);
    });

    test("a double resume: the second is not_interrupted and resolves nothing twice", async () => {
        const { app, c, id } = await parked();
        await app.receive(c, { type: "resume", answers: { [id]: { approved: true } } });
        await app.receive(c, { type: "resume", answers: { [id]: { approved: false } } });
        assert.deepEqual(errorCodes(c), ["not_interrupted"]);
        assert.equal(all(c, "interrupt_resolved").length, 1);
        assert.deepEqual(botTexts(c), ["approved"], "the first answer stands");
    });

    test("interrupt_resolved carries the answer and is persisted for replay", async () => {
        const { app, c, id } = await parked();
        await app.receive(c, { type: "resume", answers: { [id]: { approved: false } } });
        const resolved = first(c, "interrupt_resolved");
        assert.deepEqual(resolved.data, { answer: { approved: false } });

        const transcript = await app.history.after(welcomeOf(c).conversationId, 0);
        assert.deepEqual(
            transcript.map((f) => f.type),
            ["text", "interrupt", "interrupt_resolved", "text"],
            "user turn, the pause, its resolution, the reply",
        );
    });

    test("a null answer is a real answer — it resolves the pause", async () => {
        const { app, c, id } = await parked();
        await app.receive(c, { type: "resume", answers: { [id]: null } });
        assert.deepEqual(all(c, "interrupt_resolved").map((f) => f.data.answer), [null]);
        assert.deepEqual(botTexts(c), ["rejected"]);
    });

    test("welcome.pending re-announces actions and payload, minus seq", async () => {
        const { app, c, id } = await parked();
        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId: welcomeOf(c).conversationId } });
        const [p] = welcomeOf(b).pending;
        assert.deepEqual(p, { id, data: { payload: { title: "approve refund?" }, actions: [{ label: "Yes", value: { approved: true } }] } });
    });

    test("after the resume finishes, welcome.pending is empty again", async () => {
        const { app, c, id } = await parked();
        await app.receive(c, { type: "resume", answers: { [id]: { approved: true } } });
        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId: welcomeOf(c).conversationId } });
        assert.deepEqual(welcomeOf(b).pending, []);
    });

    test("a resume racing a new turn: the text is refused busy while the resume runs", async () => {
        const gate = deferred();
        const app = mekik({ graph: slowAfterApproval(gate.promise), reply: replyOf });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "x" } });
        const id = first(c, "interrupt").id;

        const resuming = app.receive(c, { type: "resume", answers: { [id]: true } });
        await app.receive(c, { type: "text", data: { text: "impatient" } });
        await app.receive(c, { type: "resume", answers: { [id]: true } });
        assert.deepEqual(errorCodes(c), ["busy", "busy"]);

        gate.resolve();
        await resuming;
        assert.deepEqual(runStatuses(c), ["started", "interrupted", "started", "finished"]);
        assert.deepEqual(botTexts(c), ["resumed"]);
    });
});

// ── two tabs, one conversation (§1) ───────────────────────────────────────────

describe("two tabs on one conversation (§1)", () => {
    async function twoTabs(g = approval) {
        const app = mekik({ graph: g, reply: replyOf });
        const a = conn();
        await app.connect(a, { hello: { userId: "u" } });
        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId: welcomeOf(a).conversationId } });
        return { app, a, b };
    }

    test("an interrupt raised by tab A is answered by tab B; both see it resolved and finished", async () => {
        const { app, a, b } = await twoTabs();
        await app.receive(a, { type: "text", data: { text: "refund" } });
        const id = first(b, "interrupt").id;
        assert.equal(first(a, "interrupt").id, id, "both tabs got the same pause");

        await app.receive(b, { type: "resume", answers: { [id]: { approved: true } } });

        for (const tab of [a, b]) {
            assert.deepEqual(all(tab, "interrupt_resolved").map((f) => f.id), [id]);
            assert.deepEqual(runStatuses(tab), ["started", "interrupted", "started", "finished"]);
            assert.deepEqual(botTexts(tab), ["approved"]);
        }
        assert.deepEqual(seqs(a), seqs(b).filter((s) => s !== 1), "same persistent frames, minus a's own user turn");
    });

    test("a text from tab B while tab A's pause is open is refused only to B", async () => {
        const { app, a, b } = await twoTabs();
        await app.receive(a, { type: "text", data: { text: "refund" } });
        const aBefore = a.sent.length;
        await app.receive(b, { type: "text", data: { text: "hello?" } });
        assert.deepEqual(errorCodes(b), ["interrupted"]);
        assert.equal(a.sent.length, aBefore, "a refusal is sent to the sender only");
    });

    test("busy goes to the sender only; the other tab sees just the running turn", async () => {
        const gate = deferred();
        const { app, a, b } = await twoTabs(stepper(gate.promise));
        const running = app.receive(a, { type: "text", data: { text: "go" } });
        await until(() => all(b, "genui").length === 1, "the stream reaching tab B");
        await app.receive(b, { type: "text", data: { text: "me too" } });
        gate.resolve();
        await running;

        assert.deepEqual(errorCodes(b), ["busy"]);
        assert.deepEqual(errorCodes(a), []);
        assert.equal(all(a, "text").filter((f) => f.from === "user").length, 0, "the refused turn reached nobody");
    });

    test("abort from the other tab stops the run for both", async () => {
        const gate = deferred();
        const { app, a, b } = await twoTabs(stepper(gate.promise));
        const running = app.receive(a, { type: "text", data: { text: "go" } });
        await until(() => all(a, "genui").length === 1, "the run to start streaming");
        await app.receive(b, { type: "abort" });
        gate.resolve();
        await running;
        assert.equal(runStatuses(a).at(-1), "aborted");
        assert.equal(runStatuses(b).at(-1), "aborted");
    });

    test("a disconnected tab stops receiving; the other keeps going and the seq never resets", async () => {
        const { app, a, b } = await twoTabs(echo);
        await app.receive(a, { type: "text", data: { text: "one" } });
        app.disconnect(b);
        const bBefore = b.sent.length;
        await app.receive(a, { type: "text", data: { text: "two" } });
        assert.equal(b.sent.length, bBefore);
        assert.deepEqual(seqs(a), [2, 4]);

        // B comes back where it left off and gets exactly what it missed.
        const b2 = conn();
        await app.connect(b2, { hello: { userId: "u", conversationId: welcomeOf(a).conversationId, watermark: 2 } });
        assert.deepEqual(seqs(b2), [3, 4]);
    });

    test("the last tab leaving and a new one arriving keeps the seq counter", async () => {
        const { app, a, b } = await twoTabs(echo);
        await app.receive(a, { type: "text", data: { text: "one" } });
        app.disconnect(a);
        app.disconnect(b);
        const c = conn();
        await app.connect(c, { hello: { userId: "u", conversationId: welcomeOf(a).conversationId, watermark: 2 } });
        await app.receive(c, { type: "text", data: { text: "two" } });
        assert.deepEqual(seqs(c), [4], "user turn is 3, the reply 4 — no reuse of 1/2");
    });

    test("disconnecting twice, or an unknown connection, is a no-op", async () => {
        const { app, a } = await twoTabs(echo);
        app.disconnect(a);
        app.disconnect(a);
        app.disconnect(conn());
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "fine" } });
        assert.deepEqual(botTexts(c), ["echo:fine"]);
    });

    test("a tab that sends and immediately disconnects still gets its turn run for the others", async () => {
        const { app, a, b } = await twoTabs(echo);
        const sending = app.receive(a, { type: "text", data: { text: "fire and forget" } });
        app.disconnect(a);
        await sending;
        assert.deepEqual(runStatuses(b), ["started", "finished"]);
        assert.deepEqual(all(b, "text").map((f) => `${f.from}:${f.data.text}`), ["user:fire and forget", "bot:echo:fire and forget"]);
    });
});

// ── turn lifecycle (§5) ───────────────────────────────────────────────────────

describe("turn lifecycle edges (§5)", () => {
    test("abort while idle is a no-op: no frames, and the next turn runs", async () => {
        const app = mekik({ graph: echo, reply: replyOf });
        const c = conn();
        await app.connect(c);
        const before = c.sent.length;
        await app.receive(c, { type: "abort" });
        assert.equal(c.sent.length, before);
        await app.receive(c, { type: "text", data: { text: "x" } });
        assert.deepEqual(runStatuses(c), ["started", "finished"]);
    });

    test("after an abort the turn lock is free and the thread resumable", async () => {
        const gate = deferred();
        const app = mekik({ graph: stepper(gate.promise), reply: replyOf });
        const c = conn();
        await app.connect(c);
        const running = app.receive(c, { type: "text", data: { text: "go" } });
        await until(() => all(c, "genui").length === 1, "the run to start");
        await app.receive(c, { type: "abort" });
        gate.resolve();
        await running;

        await app.receive(c, { type: "text", data: { text: "again" } });
        assert.deepEqual(runStatuses(c), ["started", "aborted", "started", "finished"]);
        assert.equal(all(c, "text").filter((f) => f.from === "bot" && f.data.text.startsWith("⚠️")).length, 0, "an abort writes no error text");
    });

    test("a graph error emits a ⚠️ bot text then run{error}, and frees the lock", async () => {
        const app = mekik({ graph: thrower, reply: replyOf });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "boom" } });

        const tail = since(c, 1).map((f) => (f.type === "run" ? `run:${f.data.status}` : f.type));
        assert.deepEqual(tail, ["run:started", "text", "run:error"]);
        assert.match(botTexts(c)[0]!, /^⚠️ .*kaput/);

        await app.receive(c, { type: "text", data: { text: "fine" } });
        assert.equal(botTexts(c).at(-1), "ok:fine");
        assert.equal(runStatuses(c).at(-1), "finished");
    });

    test("an error text is persistent: a later tab replays it", async () => {
        const app = mekik({ graph: thrower, reply: replyOf });
        const a = conn();
        await app.connect(a, { hello: { userId: "u" } });
        await app.receive(a, { type: "text", data: { text: "boom" } });
        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId: welcomeOf(a).conversationId } });
        assert.deepEqual(types(b), ["welcome", "text", "text"]);
        assert.match(all(b, "text")[1]!.data.text, /kaput/);
    });

    test("an empty reply emits no bot text frame — the run still finishes", async () => {
        const app = mekik({ graph: echo, reply: () => "" });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "x" } });
        assert.deepEqual(types(c), ["welcome", "run", "run"]);
    });

    test("each turn gets a fresh genui stream id; chunks within a turn share one", async () => {
        const g = graph("two-chunks")
            .channel("input", channel.lastWrite<string>(""))
            .node("n", (_s, ctx) => {
                mekik.ui(ctx, "a", {});
                mekik.ui(ctx, "b", {});
                return {};
            })
            .edge(START, "n")
            .edge("n", END)
            .compile();
        const app = mekik({ graph: g });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "1" } });
        await app.receive(c, { type: "text", data: { text: "2" } });
        const streams = all(c, "genui").map((f) => f.streamId);
        assert.equal(streams.length, 6, "two chunks + stream_done, twice");
        assert.equal(new Set(streams.slice(0, 3)).size, 1);
        assert.equal(new Set(streams.slice(3)).size, 1);
        assert.notEqual(streams[0], streams[3]);
        // Chunk ids restart per stream: 1, 2 and stream_done 3 each turn.
        assert.deepEqual(all(c, "genui").map((f) => f.chunk.id), [1, 2, 3, 1, 2, 3]);
    });
});

// ── auth (§7) ─────────────────────────────────────────────────────────────────

describe("auth edges (§7)", () => {
    test("a rejection sends error{unauthorized} with the reason, closes 4401, and registers nothing", async () => {
        const app = mekik({ graph: echo, reply: replyOf, authenticator: { authenticate: () => ({ ok: false, reason: "expired" }) } });
        const c = conn();
        await app.connect(c, { hello: { token: "t" } });
        assert.deepEqual(types(c), ["error"], "no welcome on a rejected connect");
        assert.deepEqual(first(c, "error").data, { code: "unauthorized", message: "expired" });
        assert.deepEqual(c.closed, { code: 4401, reason: "unauthorized" });

        await app.receive(c, { type: "text", data: { text: "sneak" } });
        assert.deepEqual(errorCodes(c), ["unauthorized", "no_session"]);
    });

    test("a rejection without a reason says unauthorized", async () => {
        const app = mekik({ graph: echo, authenticator: { authenticate: async () => ({ ok: false }) } });
        const c = conn();
        await app.connect(c);
        assert.deepEqual(first(c, "error").data, { code: "unauthorized", message: "unauthorized" });
    });

    test("the credential param wins over hello.token", async () => {
        const seen: unknown[] = [];
        const app = mekik({
            graph: echo,
            authenticator: {
                authenticate: (cred) => {
                    seen.push(cred);
                    return { ok: true, userId: "u" };
                },
            },
        });
        await app.connect(conn(), { hello: { token: "from-hello" }, credential: { token: "from-header", headers: { cookie: "s=1" } } });
        assert.deepEqual(seen, [{ token: "from-header", headers: { cookie: "s=1" } }]);
    });

    test("no token anywhere hands the authenticator an empty credential", async () => {
        const seen: unknown[] = [];
        const app = mekik({ graph: echo, authenticator: { authenticate: (cred) => (seen.push(cred), { ok: false }) } });
        await app.connect(conn());
        assert.deepEqual(seen, [{}]);
    });

    test("a verdict without a userId keeps the asserted one", async () => {
        const app = mekik({ graph: echo, authenticator: { authenticate: () => ({ ok: true }) } });
        const c = conn();
        await app.connect(c, { hello: { userId: "asserted" } });
        assert.equal(welcomeOf(c).userId, "asserted");
    });

    test("verified claims reach the node at meta.auth; the client cannot forge them via meta", async () => {
        const app = mekik({
            graph: metaProbe,
            reply: replyOf,
            acceptClientMeta: (m) => m,
            authenticator: { authenticate: () => ({ ok: true, userId: "u", claims: { role: "agent" } }) },
        });
        const c = conn();
        await app.connect(c, { hello: { token: "t" } });
        await app.receive(c, { type: "text", data: { text: "x" }, meta: { auth: { role: "admin" } } });
        const seen = JSON.parse(botTexts(c)[0]!);
        assert.deepEqual(seen.auth, { role: "agent" });
        assert.deepEqual(seen.client, { auth: { role: "admin" } }, "client meta stays under meta.client");
    });

    test("claims also reach a resumed run", async () => {
        const g = graph("claims-after-pause")
            .channel("input", channel.lastWrite<string>(""))
            .channel("reply", channel.lastWrite<string>(""))
            .node("n", async (_s, ctx) => {
                await mekik.approve(ctx, { title: "ok?" });
                return { reply: JSON.stringify((ctx.meta as Record<string, unknown>).auth) };
            })
            .edge(START, "n")
            .edge("n", END)
            .compile();
        const app = mekik({ graph: g, reply: replyOf, authenticator: { authenticate: () => ({ ok: true, userId: "u", claims: { tier: 2 } }) } });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "x" } });
        await app.receive(c, { type: "resume", answers: { [first(c, "interrupt").id]: true } });
        assert.deepEqual(JSON.parse(botTexts(c)[0]!), { tier: 2 });
    });
});

// ── the greeting (§1) ─────────────────────────────────────────────────────────

describe("greeting edges", () => {
    test("a greeting function returning undefined sends nothing", async () => {
        const app = mekik({ graph: echo, greeting: () => undefined });
        const c = conn();
        await app.connect(c);
        assert.deepEqual(types(c), ["welcome"]);
    });

    test("empty strings inside a greeting list are skipped; the rest keep their order and seq", async () => {
        const app = mekik({ graph: echo, greeting: () => ["", "one", "", "two"] });
        const c = conn();
        await app.connect(c);
        assert.deepEqual(all(c, "text").map((f) => [f.seq, f.data.text]), [[1, "one"], [2, "two"]]);
    });

    test("an explicit text spec greets with its extras intact", async () => {
        const app = mekik({ graph: echo, greeting: () => ({ type: "text", data: { text: "see", urls: ["https://x"] }, id: "g-1" }) });
        const c = conn();
        await app.connect(c);
        const t = first(c, "text");
        assert.equal(t.id, "g-1");
        assert.deepEqual(t.data, { text: "see", urls: ["https://x"] });
    });

    test("the greeting is computed for the resolved conversation and user", async () => {
        const seen: unknown[] = [];
        const app = mekik({ graph: echo, greeting: (conv) => (seen.push(conv), "hi") });
        const c = conn();
        await app.connect(c, { hello: { userId: "u9" } });
        assert.deepEqual(seen, [{ conversationId: welcomeOf(c).conversationId, userId: "u9" }]);
    });

    test("a second tab on a greeted conversation is not greeted again", async () => {
        let calls = 0;
        const app = mekik({ graph: echo, greeting: () => (calls++, "hi") });
        const a = conn();
        await app.connect(a, { hello: { userId: "u" } });
        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId: welcomeOf(a).conversationId, watermark: 1 } });
        assert.equal(calls, 1);
        assert.deepEqual(types(b), ["welcome"]);
    });
});

// ── scaling ports (docs/SCALING.md) ───────────────────────────────────────────

/** An in-process pub/sub shared by several engines — the backplane contract without Redis. */
class MemoryBus implements Backplane {
    private readonly handlers = new Map<string, Set<(m: BackplaneMessage) => void>>();
    published = 0;
    async publish(conversationId: string, message: BackplaneMessage): Promise<void> {
        this.published++;
        // Round-trip through JSON, as a real wire would.
        const copy = JSON.parse(JSON.stringify(message)) as BackplaneMessage;
        for (const h of this.handlers.get(conversationId) ?? []) h(copy);
    }
    async subscribe(conversationId: string, handler: (m: BackplaneMessage) => void): Promise<Subscription> {
        const set = this.handlers.get(conversationId) ?? new Set();
        set.add(handler);
        this.handlers.set(conversationId, set);
        return { unsubscribe: async () => void set.delete(handler) };
    }
}

describe("scaling ports", () => {
    test("two nodes on one backplane: frames produced on A reach B's tab exactly once, and A gets no echo", async () => {
        const bus = new MemoryBus();
        const history = new InMemoryHistoryStore();
        const { InMemoryConversationStore } = await import("../src/stores.ts");
        const conversations = new InMemoryConversationStore();
        const nodeA = mekik({ graph: echo, reply: replyOf, backplane: bus, history, conversations });
        const nodeB = mekik({ graph: echo, reply: replyOf, backplane: bus, history, conversations });

        const a = conn();
        await nodeA.connect(a, { hello: { userId: "u" } });
        const b = conn();
        await nodeB.connect(b, { hello: { userId: "u", conversationId: welcomeOf(a).conversationId } });

        await nodeA.receive(a, { type: "text", data: { text: "cross" } });

        assert.deepEqual(all(b, "text").map((f) => `${f.from}:${f.data.text}`), ["user:cross", "bot:echo:cross"]);
        assert.deepEqual(runStatuses(b), ["started", "finished"], "transient frames cross too");
        assert.deepEqual(seqs(a), [2], "A's tab got its reply once — no backplane echo");
        assert.deepEqual(seqs(b), [1, 2]);
        const transcript = await history.after(welcomeOf(a).conversationId, 0);
        assert.deepEqual(transcript.map((f) => f.seq), [1, 2], "recorded once, by the producing node");
    });

    test("a turn lock that refuses answers busy and starts no run", async () => {
        const lock: TurnLock = { acquire: async () => null };
        const app = mekik({ graph: echo, reply: replyOf, turnLock: lock });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "x" } });
        assert.deepEqual(errorCodes(c), ["busy"]);
        assert.deepEqual(runStatuses(c), []);
        const transcript = await app.history.after(welcomeOf(c).conversationId, 0);
        assert.equal(transcript.length, 0, "a refused turn writes nothing to the transcript");
    });

    test("the lease is released after every turn — finished, errored, or refused as interrupted", async () => {
        const events: string[] = [];
        const lock: TurnLock = {
            acquire: async (id) => {
                events.push(`acquire:${id.slice(0, 4)}`);
                return { renew: async () => {}, release: async () => void events.push("release") };
            },
        };
        const app = mekik({ graph: thrower, reply: replyOf, turnLock: lock });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "ok" } });
        await app.receive(c, { type: "text", data: { text: "boom" } });
        assert.deepEqual(events, ["acquire:conv", "release", "acquire:conv", "release"]);
    });

    test("a lease whose release fails does not wedge the conversation", async () => {
        let calls = 0;
        const lease: TurnLease = {
            renew: async () => {},
            release: async () => {
                if (calls++ === 0) throw new Error("redis went away");
            },
        };
        const app = mekik({ graph: echo, reply: replyOf, turnLock: { acquire: async () => lease } });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "one" } }).catch(() => {});
        await app.receive(c, { type: "text", data: { text: "two" } });
        assert.deepEqual(errorCodes(c), [], "the second turn is not refused busy");
        assert.deepEqual(botTexts(c), ["echo:one", "echo:two"]);
    });

    test("a turn lock that throws on acquire frees the local lock", async () => {
        let fail = true;
        const app = mekik({
            graph: echo,
            reply: replyOf,
            turnLock: {
                acquire: async () => {
                    if (fail) throw new Error("lock backend down");
                    return { renew: async () => {}, release: async () => {} };
                },
            },
        });
        const c = conn();
        await app.connect(c);
        await assert.rejects(app.receive(c, { type: "text", data: { text: "one" } }), /lock backend down/);
        fail = false;
        await app.receive(c, { type: "text", data: { text: "two" } });
        assert.deepEqual(botTexts(c), ["echo:two"]);
    });
});
