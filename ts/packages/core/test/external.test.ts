// The external-transcript profile (PROTOCOL.md "Running behind a hub"): opt-in
// ports for a hub that owns the transcript, the seq space and identity.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { channel, END, graph, START } from "@ilmek/core";

import {
    ExternalTranscript,
    ExternalTranscriptHistoryStore,
    externalTranscript,
    HubAuthenticator,
    HubConversationStore,
    mekik,
} from "../src/index.ts";
import type { Connection } from "../src/engine.ts";
import type { OutgoingFrame } from "../src/protocol.ts";

class FakeConn implements Connection {
    readonly sent: OutgoingFrame[] = [];
    readonly id: string;
    closed: number | undefined;
    constructor(id: string) {
        this.id = id;
    }
    send(frame: OutgoingFrame): void {
        this.sent.push(frame);
    }
    close(code?: number): void {
        this.closed = code;
    }
}

const echo = graph("echo")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("n", (s) => ({ reply: `echo: ${s.input}` }))
    .edge(START, "n")
    .edge("n", END)
    .compile();

describe("external transcript — the ports", () => {
    test("the history store keeps nothing, replays nothing and seeds seq from the hub", async () => {
        const transcript = new ExternalTranscript();
        const history = new ExternalTranscriptHistoryStore(transcript);
        await history.record("c", { type: "text", id: "m", seq: 3, from: "bot", data: { text: "x" }, timestamp: 1 });
        assert.deepEqual(await history.after("c", 0), []);
        assert.equal(await history.currentSeq("c"), 0);
        transcript.observe("c", { userId: "alice", seq: 7 });
        assert.equal(await history.currentSeq("c"), 7);
    });

    test("the conversation store answers from what the hub reported; the first owner sticks; create is a no-op", async () => {
        const transcript = new ExternalTranscript();
        const store = new HubConversationStore(transcript);
        assert.equal(await store.get("c"), null);
        transcript.observe("c", { userId: "alice", seq: 1 });
        transcript.observe("c", { userId: "mallory", seq: 2 });
        assert.deepEqual(await store.get("c"), { conversationId: "c", userId: "alice", createdAt: 0, meta: {} });
        await store.create({ conversationId: "d", userId: "bob", createdAt: 0, meta: {} });
        assert.equal(await store.get("d"), null);
        transcript.forget("c");
        assert.equal(await store.get("c"), null);
        assert.equal(transcript.size, 0);
    });

    test("the authenticator trusts only the hub identity at credential.meta.auth", () => {
        const auth = new HubAuthenticator();
        assert.deepEqual(auth.authenticate({ meta: { auth: { userId: "alice", role: "user" } } }), {
            ok: true,
            userId: "alice",
            claims: { userId: "alice", role: "user" },
        });
        assert.equal(auth.authenticate({ token: "anything" }).ok, false);
        assert.equal(auth.authenticate({ meta: { auth: { userId: "" } } }).ok, false);
        assert.equal(auth.authenticate({ meta: { auth: "alice" } }).ok, false);
    });
});

describe("external transcript — the engine", () => {
    test("a hub conversation is adopted, not minted; the user turn is numbered but neither echoed nor stored", async () => {
        const profile = externalTranscript();
        const app = mekik({ graph: echo, reply: (s) => s.reply as string, ...profile });
        profile.history.transcript.observe("conv-hub", { userId: "alice", seq: 4 });
        const a = new FakeConn("a");
        const b = new FakeConn("b");
        const credential = { meta: { auth: { userId: "alice" } } };
        await app.connect(a, { hello: { conversationId: "conv-hub" }, credential });
        await app.connect(b, { hello: { conversationId: "conv-hub" }, credential });
        const welcome = a.sent.find((f) => f.type === "welcome");
        assert.ok(welcome?.type === "welcome");
        assert.equal(welcome.data.conversationId, "conv-hub");
        assert.equal(welcome.data.userId, "alice");
        assert.equal(welcome.data.watermark, 4);

        await app.receive(a, { type: "text", data: { text: "hi" } });
        // Not even the other connection sees the user's turn: the hub delivered it.
        assert.ok(!b.sent.some((f) => f.type === "text" && f.from === "user"));
        const reply = b.sent.find((f) => f.type === "text" && f.from === "bot");
        assert.ok(reply?.type === "text");
        assert.equal(reply.seq, 6, "the unsent user turn took seq 5");
        assert.deepEqual(await app.history.after("conv-hub", 0), []);
    });

    test("no hub identity: the connection is refused like any failed authenticator", async () => {
        const app = mekik({ graph: echo, ...externalTranscript() });
        const c = new FakeConn("c");
        await app.connect(c, { hello: { userId: "alice", conversationId: "x" } });
        assert.equal(c.closed, 4401);
        assert.deepEqual(c.sent[0], { type: "error", data: { code: "unauthorized", message: "no hub-verified identity" } });
    });

    test("default apps are unchanged: the user turn still reaches the other tab and the transcript", async () => {
        const app = mekik({ graph: echo });
        const a = new FakeConn("a");
        await app.connect(a, { hello: { userId: "u" } });
        const conv = (a.sent[0] as Extract<OutgoingFrame, { type: "welcome" }>).data.conversationId;
        const b = new FakeConn("b");
        await app.connect(b, { hello: { userId: "u", conversationId: conv } });
        await app.receive(a, { type: "text", data: { text: "hi" } });
        assert.ok(b.sent.some((f) => f.type === "text" && f.from === "user"));
        assert.equal((await app.history.after(conv, 0))[0]?.type, "text");
    });
});
