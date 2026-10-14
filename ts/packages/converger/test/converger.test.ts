// @mekik/converger against a fake hub: the handshake, the virtual-connection
// mapping, what is and is not answered, reconnects, eviction and the limits.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { channel, END, graph, START } from "@ilmek/core";

import { externalTranscript, mekik, type MekikOptions } from "@mekik/core";

import { connectConverger, type ConvergerOptions } from "../src/index.ts";
import { FakeHub } from "./fake-hub.ts";

type Frame = Record<string, unknown>;

/** Replies with what it saw: the text, the user, the verified claims and the client meta. */
const echo = graph("echo")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("n", (s, ctx) => {
        const meta = ctx.meta as { mekik?: { userId?: string }; auth?: unknown; client?: unknown };
        return { reply: JSON.stringify({ text: s.input, user: meta.mekik?.userId, auth: meta.auth ?? null, client: meta.client ?? null }) };
    })
    .edge(START, "n")
    .edge("n", END)
    .compile();

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

/** Blocks every run until the test releases it. */
function gated(): { graph: MekikOptions["graph"]; gate: () => { promise: Promise<void>; resolve: () => void }; release: () => void } {
    let current = deferred();
    const g = graph("gated")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("n", async (s) => {
            await current.promise;
            return { reply: `done: ${s.input}` };
        })
        .edge(START, "n")
        .edge("n", END)
        .compile();
    return {
        graph: g,
        gate: () => current,
        release: () => {
            current.resolve();
            current = deferred();
        },
    };
}

async function setup(
    t: { after: (fn: () => Promise<void> | void) => void },
    app: Partial<MekikOptions> = {},
    opts: Partial<ConvergerOptions> = {},
) {
    const hub = await FakeHub.start();
    const errors: Error[] = [];
    const transport = connectConverger(
        mekik({ graph: echo, reply: (s) => s.reply as string, context: (c) => ({ userId: c.userId }), ...externalTranscript(), ...app }),
        { url: hub.url, token: "tok-1", reconnect: { minMs: 10, maxMs: 40 }, onError: (e) => errors.push(e), ...opts },
    );
    t.after(async () => {
        await transport.close();
        await hub.close();
    });
    return { hub, transport, errors };
}

const replies = (hub: FakeHub, conv: string): Frame[] =>
    hub.framesOf(conv).filter((f) => f.type === "text" && f.from === "bot");
const replyJson = (f: Frame | undefined): Record<string, unknown> => JSON.parse((f?.data as { text: string }).text) as Record<string, unknown>;

describe("@mekik/converger — handshake", () => {
    test("one bare hello with the bearer token, then ready on the channel welcome", async (t) => {
        const { hub, transport } = await setup(t, {}, { group: "faq" });
        await transport.ready;
        assert.equal(transport.connected, true);
        assert.equal(hub.hellos.length, 1);
        assert.deepEqual(hub.hellos[0]!.frame, { type: "hello", protocol: "converger/1", group: "faq" });
        assert.equal(hub.hellos[0]!.bearer, "tok-1");
    });

    test("an app without the external-transcript profile is refused up front", () => {
        assert.throws(() => connectConverger(mekik({ graph: echo }), { url: "ws://127.0.0.1:1", token: "x" }), /externalTranscript/);
        assert.throws(() => connectConverger(mekik({ graph: echo, ...externalTranscript() }), { url: "ws://127.0.0.1:1" }), /token/);
    });

    test("secret mode mints a channel-scoped token and renews it before it expires", async (t) => {
        const calls: Array<{ url: string; auth: string | null; body: string }> = [];
        let n = 0;
        const fakeFetch = (async (url: URL | string, init?: RequestInit) => {
            calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: String(init?.body) });
            return new Response(JSON.stringify({ token: `minted-${++n}`, expires_in: 1800 }), { status: 200 });
        }) as typeof fetch;
        const hub = await FakeHub.start();
        hub.expiresAt = Date.now() + 61_000; // the refresh fires one minute early → right away
        const transport = connectConverger(mekik({ graph: echo, ...externalTranscript() }), {
            url: hub.url,
            secret: "chan-secret",
            apiUrl: "http://hub.example",
            fetch: fakeFetch,
        });
        t.after(async () => {
            await transport.close();
            await hub.close();
        });
        await transport.ready;
        assert.equal(hub.hellos[0]!.bearer, "minted-1");
        assert.equal(calls[0]!.url, "http://hub.example/api/v1/converger/tokens/generate");
        assert.equal(calls[0]!.auth, "Bearer chan-secret");
        assert.deepEqual(JSON.parse(calls[0]!.body), { scope: "channel" });
        await hub.waitFor(() => hub.bare.some((f) => f.type === "auth"), "the auth refresh");
        assert.deepEqual(hub.bare.find((f) => f.type === "auth"), { type: "auth", token: "minted-2" });
    });

    test("a fixed token refused with 4401 stops the transport instead of retrying", async (t) => {
        const hub = await FakeHub.start();
        hub.refuseWith = 4401;
        const transport = connectConverger(mekik({ graph: echo, ...externalTranscript() }), {
            url: hub.url,
            token: "revoked",
            reconnect: { minMs: 10, maxMs: 20 },
        });
        t.after(async () => {
            await transport.close();
            await hub.close();
        });
        await assert.rejects(transport.ready, /4401/);
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(hub.hellos.length, 1);
    });
});

describe("@mekik/converger — virtual connections", () => {
    test("each conversation gets its own virtual connection; frames go back in its envelope", async (t) => {
        const { hub, transport } = await setup(t);
        await transport.ready;
        hub.userTurn("conv-a", "one");
        hub.userTurn("conv-b", "two", { sender: { id: "bob", role: "user" } });
        await hub.waitFor(() => replies(hub, "conv-a").length === 1 && replies(hub, "conv-b").length === 1, "both replies");
        assert.equal(transport.conversations, 2);
        assert.deepEqual(replyJson(replies(hub, "conv-a")[0]), { text: "one", user: "alice", auth: { userId: "alice", role: "user" }, client: null });
        assert.deepEqual(replyJson(replies(hub, "conv-b")[0]), { text: "two", user: "bob", auth: { userId: "bob", role: "user" }, client: null });
        // The run frames are relayed; no welcome and no echo of the user's turn.
        const types = hub.framesOf("conv-a").map((f) => f.type);
        assert.deepEqual(types, ["run", "text", "run"]);
        assert.ok(!hub.received.some((e) => e.frame.type === "welcome" || e.frame.from === "user"));
    });

    test("the bot's own frames, receipts and typing are not turns; a replayed seq is not run twice", async (t) => {
        const { hub, transport } = await setup(t);
        await transport.ready;
        hub.forward("conv-a", { type: "text", id: "x", seq: 1, from: "bot", data: { text: "agent says" }, timestamp: 1 });
        hub.forward("conv-a", { type: "tool_call", seq: 2, data: { id: "t", name: "n", status: "running" } });
        hub.forward("conv-a", { type: "typing", isTyping: true, from: "user", sender: { id: "alice", role: "user" } });
        hub.forward("conv-a", { type: "event", id: "e", seq: 3, from: "user", data: { name: "reaction", text: "alice reacted" }, timestamp: 1 });
        hub.forward("conv-a", { type: "deliveryStatus", data: { seq: 1, status: "read" } });
        const turn = { type: "text", id: "u", seq: 4, from: "user", sender: { id: "alice", role: "user" }, data: { text: "hi" }, timestamp: 1 };
        hub.forward("conv-a", turn);
        hub.forward("conv-a", turn); // the same seq again (a replay overlapping live delivery)
        await hub.waitFor(() => replies(hub, "conv-a").length === 1, "one reply");
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(replies(hub, "conv-a").length, 1);
        assert.equal(replyJson(replies(hub, "conv-a")[0]).text, "hi");
    });

    test("a rich user message with text is a turn; the meta allowlist picks from metadata and meta", async (t) => {
        const { hub, transport } = await setup(t, { acceptClientMeta: (m) => m }, { meta: ["channel", "locale"] });
        await transport.ready;
        hub.userTurn("conv-a", "Track", {
            type: "buttons",
            metadata: { channel: "whatsapp", secret: "no" },
            meta: { locale: "tr-TR", channel: "wa-main" },
        });
        await hub.waitFor(() => replies(hub, "conv-a").length === 1, "the reply");
        const seen = replyJson(replies(hub, "conv-a")[0]);
        assert.equal(seen.text, "Track");
        // hello.meta (the verified identity) under the turn's allowlisted meta (§6).
        assert.deepEqual(seen.client, { auth: { userId: "alice", role: "user" }, channel: "wa-main", locale: "tr-TR" });
    });

    test("forwarded frames reach the engine unchanged: abort stops a running turn", async (t) => {
        const g = gated();
        const { hub, transport } = await setup(t, { graph: g.graph });
        await transport.ready;
        hub.userTurn("conv-a", "slow");
        await hub.waitFor(() => hub.framesOf("conv-a").some((f) => f.type === "run"), "run started");
        hub.forward("conv-a", { type: "abort" });
        // The abort must not queue behind the running turn: it lands while the node is
        // still parked on the gate, so the run ends aborted once the node returns.
        await new Promise((r) => setTimeout(r, 30));
        g.release();
        await hub.waitFor(
            () => hub.framesOf("conv-a").some((f) => f.type === "run" && (f.data as { status: string }).status === "aborted"),
            "run aborted",
        );
        assert.equal(replies(hub, "conv-a").length, 0, "no reply from an aborted run");
    });

    test("the greeting goes to a fresh conversation (hub seq 1), never to one first seen through a forwarded frame", async (t) => {
        const { hub, transport } = await setup(t, { greeting: () => "Hello!" });
        await transport.ready;
        hub.userTurn("conv-new", "hi");
        await hub.waitFor(() => replies(hub, "conv-new").length === 2, "greeting and reply");
        assert.equal((replies(hub, "conv-new")[0]!.data as { text: string }).text, "Hello!");

        hub.forward("conv-old", { type: "resume", answers: { "x#0": true } });
        await hub.waitFor(() => hub.framesOf("conv-old").some((f) => f.type === "error"), "not_interrupted");
        assert.equal(replies(hub, "conv-old").length, 0);
    });

    test("an idle conversation is disconnected after idleMs and reconnected by its next turn", async (t) => {
        const { hub, transport } = await setup(t, {}, { idleMs: 30 });
        await transport.ready;
        hub.userTurn("conv-a", "one");
        await hub.waitFor(() => replies(hub, "conv-a").length === 1, "first reply");
        await hub.waitFor(() => transport.conversations === 0, "eviction");
        hub.userTurn("conv-a", "two");
        await hub.waitFor(() => replies(hub, "conv-a").length === 2, "second reply");
        assert.equal(replyJson(replies(hub, "conv-a")[1]).text, "two");
    });

    test("maxConcurrentTurns queues turns across conversations", async (t) => {
        const g = gated();
        const { hub, transport } = await setup(t, { graph: g.graph }, { maxConcurrentTurns: 1 });
        await transport.ready;
        hub.userTurn("conv-a", "a");
        await hub.waitFor(() => hub.framesOf("conv-a").some((f) => f.type === "run"), "a started");
        hub.userTurn("conv-b", "b");
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(hub.framesOf("conv-b").length, 0, "b waits for a slot");
        g.release();
        await hub.waitFor(() => replies(hub, "conv-a").length === 1, "a done");
        await hub.waitFor(() => hub.framesOf("conv-b").some((f) => f.type === "run"), "b started");
        g.release();
        await hub.waitFor(() => replies(hub, "conv-b").length === 1, "b done");
    });
});

describe("@mekik/converger — reconnect", () => {
    test("re-hello with each conversation's watermark; persistent frames made while down are flushed, transient ones dropped", async (t) => {
        const g = gated();
        const { hub, transport } = await setup(t, { graph: g.graph });
        await transport.ready;
        hub.userTurn("conv-a", "first");
        await hub.waitFor(() => hub.framesOf("conv-a").some((f) => f.type === "run"), "run started");

        hub.drop();
        await hub.waitFor(() => !transport.connected, "the drop noticed");
        g.release(); // the reply and run{finished} are produced while the socket is down
        await hub.waitFor(() => hub.hellos.length === 2, "the re-hello");
        assert.deepEqual(hub.hellos[1]!.frame, { type: "hello", protocol: "converger/1", watermarks: { "conv-a": 1 } });

        await hub.waitFor(() => replies(hub, "conv-a").length === 1, "the buffered reply");
        assert.equal((replies(hub, "conv-a")[0]!.data as { text: string }).text, "done: first");
        const runs = hub.framesOf("conv-a").filter((f) => f.type === "run").map((f) => (f.data as { status: string }).status);
        assert.deepEqual(runs, ["started"], "run{finished} was live-only and is not replayed late");
    });

    test("an ack moves the conversation's watermark", async (t) => {
        const { hub, transport } = await setup(t);
        await transport.ready;
        hub.userTurn("conv-a", "one"); // seq 1; the reply is stored (and acked) as seq 2
        await hub.waitFor(() => replies(hub, "conv-a").length === 1, "the reply");
        await new Promise((r) => setTimeout(r, 30));
        hub.drop();
        await hub.waitFor(() => hub.hellos.length === 2, "the re-hello");
        assert.deepEqual(hub.hellos[1]!.frame.watermarks, { "conv-a": 2 });
    });
});
