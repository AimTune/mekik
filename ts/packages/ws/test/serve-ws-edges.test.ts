// serveWs at the edges, against the real engine: what a browser actually sends
// (garbage query strings, wrong-typed hello fields, malformed frames), sockets
// that close mid-handshake, auth rejection on the wire, path filtering, and an
// externally owned HTTP server. Every assertion is on frames a real `ws` client
// receives, or on what the engine observably did.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocket } from "ws";
import { channel, END, graph, START } from "@ilmek/core";

import { mekik, type MekikApp, type Connection, type ConnectParams, type MekikOptions } from "@mekik/core";

import { serveWs, type ServeWsHandle } from "../src/index.ts";

type Frame = { type: string; [k: string]: unknown };

/** A ws client that buffers every frame it receives, so no message is lost to a late listener. */
class Client {
    readonly frames: Frame[] = [];
    readonly ws: WebSocket;
    closeCode: number | null = null;
    constructor(url: string, options?: ConstructorParameters<typeof WebSocket>[2]) {
        this.ws = new WebSocket(url, options);
        this.ws.on("message", (raw) => this.frames.push(JSON.parse(raw.toString()) as Frame));
        this.ws.on("close", (code) => (this.closeCode = code));
    }
    async open(): Promise<this> {
        await once(this.ws, "open");
        return this;
    }
    send(frame: unknown): void {
        this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    }
    of(type: string): Frame[] {
        return this.frames.filter((f) => f.type === type);
    }
    async waitFor(pred: (c: this) => boolean, what: string): Promise<void> {
        const deadline = Date.now() + 3000;
        while (!pred(this)) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; got ${JSON.stringify(this.frames.map((f) => f.type))}`);
            await new Promise((r) => setTimeout(r, 5));
        }
    }
}

const echo = graph("echo")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("say", (s, ctx) => {
        const tools = (ctx.meta as { clientTools?: { name: string }[] }).clientTools ?? [];
        return { reply: `echo:${s.input}|tools:${tools.map((t) => t.name).join(",")}` };
    })
    .edge(START, "say")
    .edge("say", END)
    .compile();

async function serve(options: Partial<MekikOptions> = {}, path?: string) {
    const app = mekik({ graph: echo, reply: (s) => s.reply as string, ...options });
    const handle = serveWs(app, { port: 0, ...(path !== undefined ? { path } : {}) });
    await once(handle.server, "listening");
    const port = (handle.server.address() as AddressInfo).port;
    return { app, handle, url: (q = "") => `ws://127.0.0.1:${port}${path ?? "/"}${q}` };
}

const welcome = (c: Client) => c.of("welcome")[0]!.data as { conversationId: string; userId: string; watermark: number };
const botTexts = (c: Client) => c.of("text").filter((f) => f.from === "bot").map((f) => (f.data as { text: string }).text);

describe("serveWs edges — malformed input from a real client", () => {
    test("a malformed frame after the handshake is error{bad_request} and the socket stays usable", async (t) => {
        const { handle, url } = await serve();
        t.after(() => handle.close());
        const c = await new Client(url()).open();
        t.after(() => c.ws.close());
        c.send({ type: "hello" });
        await c.waitFor((x) => x.of("welcome").length === 1, "welcome");

        c.send("{definitely not json");
        c.send({ type: "text", data: { text: 5 } });
        c.send({ type: "text", data: { text: "fine" } });
        await c.waitFor((x) => x.of("run").length === 2, "the valid turn");

        assert.deepEqual(c.of("error").map((f) => (f.data as { code: string }).code), ["bad_request", "bad_request"]);
        assert.deepEqual(botTexts(c), ["echo:fine|tools:"]);
        assert.equal(c.ws.readyState, WebSocket.OPEN);
    });

    test("a malformed first frame still connects (identity from the query) and then draws bad_request", async (t) => {
        const { handle, url } = await serve();
        t.after(() => handle.close());
        const c = await new Client(url("?userId=q-user")).open();
        t.after(() => c.ws.close());
        c.send("not json at all");
        await c.waitFor((x) => x.of("error").length === 1, "the bad_request");
        assert.deepEqual(c.frames.map((f) => f.type), ["welcome", "error"]);
        assert.equal(welcome(c).userId, "q-user");
    });

    test("a non-numeric ?watermark= is ignored rather than suppressing replay", async (t) => {
        const { handle, url } = await serve();
        t.after(() => handle.close());
        const a = await new Client(url("?userId=u")).open();
        t.after(() => a.ws.close());
        a.send({ type: "text", data: { text: "one" } });
        await a.waitFor((x) => x.of("run").length === 2, "first turn");
        const conv = welcome(a).conversationId;

        const b = await new Client(url(`?userId=u&conversationId=${conv}&watermark=abc`)).open();
        t.after(() => b.ws.close());
        b.send({ type: "abort" });
        await b.waitFor((x) => x.of("welcome").length === 1, "welcome");
        await b.waitFor((x) => x.of("text").length === 2, "the replayed transcript");
        assert.deepEqual(b.of("text").map((f) => f.seq), [1, 2]);
    });

    test("wrong-typed hello fields are dropped, never put on the wire", async (t) => {
        const { handle, url } = await serve();
        t.after(() => handle.close());
        const c = await new Client(url()).open();
        t.after(() => c.ws.close());
        c.send({ type: "hello", userId: 42, conversationId: { $ne: null }, watermark: "7", token: ["x"], meta: "junk" });
        await c.waitFor((x) => x.of("welcome").length === 1, "welcome");
        const w = welcome(c);
        assert.equal(typeof w.userId, "string", "a minted id, not 42");
        assert.match(w.userId, /^user-/);
        assert.equal(typeof w.conversationId, "string");
        assert.equal(w.watermark, 0);
    });
});

describe("serveWs edges — hello.meta end to end (§6)", () => {
    test("an object hello.meta reaches the node's meta.client through the allowlist", async (t) => {
        const probe = graph("meta")
            .channel("input", channel.lastWrite<string>(""))
            .channel("reply", channel.lastWrite<string>(""))
            .node("n", (_s, ctx) => ({ reply: JSON.stringify((ctx.meta as { client?: unknown }).client ?? null) }))
            .edge(START, "n")
            .edge("n", END)
            .compile();
        const app = mekik({ graph: probe, reply: (s) => s.reply as string, acceptClientMeta: (m) => ({ locale: m.locale }) });
        const handle = serveWs(app, { port: 0 });
        t.after(() => handle.close());
        await once(handle.server, "listening");
        const c = await new Client(`ws://127.0.0.1:${(handle.server.address() as AddressInfo).port}/`).open();
        t.after(() => c.ws.close());

        c.send({ type: "hello", meta: { locale: "tr-TR", secret: "x" } });
        c.send({ type: "text", data: { text: "hi" } });
        await c.waitFor((x) => x.of("run").length === 2, "the turn");
        assert.deepEqual(botTexts(c), ['{"locale":"tr-TR"}']);
    });
});

describe("serveWs edges — lifecycle against the engine", () => {
    test("a socket that closes mid-handshake is disconnected once the handshake lands — it leaves no ghost tools", async (t) => {
        let releaseAuth!: () => void;
        const slow = new Promise<void>((r) => (releaseAuth = r));
        const { handle, url } = await serve({
            clientTools: true,
            authenticator: {
                authenticate: async (cred) => {
                    if (cred.token === "slow") await slow;
                    return { ok: true, userId: "u" };
                },
            },
        });
        t.after(() => handle.close());

        const live = await new Client(url("?token=fast")).open();
        t.after(() => live.ws.close());
        live.send({ type: "hello" });
        await live.waitFor((x) => x.of("welcome").length === 1, "welcome");
        const conversationId = welcome(live).conversationId;

        // A second tab declares a tool, then vanishes while auth is still pending.
        const ghost = await new Client(url("?token=slow")).open();
        ghost.send({ type: "hello", conversationId, tools: [{ name: "ghost_tool" }] });
        await new Promise((r) => setTimeout(r, 20));
        ghost.ws.close();
        await once(ghost.ws, "close");
        await new Promise((r) => setTimeout(r, 20));
        releaseAuth();
        await new Promise((r) => setTimeout(r, 20));

        live.send({ type: "text", data: { text: "x" } });
        await live.waitFor((x) => x.of("run").length === 2, "the turn");
        assert.deepEqual(botTexts(live), ["echo:x|tools:"], "the closed tab's declaration is gone");
    });

    test("an auth rejection arrives as error{unauthorized} and the socket closes with 4401", async (t) => {
        const { handle, url } = await serve({ authenticator: { authenticate: () => ({ ok: false, reason: "bad token" }) } });
        t.after(() => handle.close());
        const c = await new Client(url("?token=nope")).open();
        c.send({ type: "hello" });
        await once(c.ws, "close");
        assert.equal(c.closeCode, 4401);
        assert.deepEqual(c.frames, [{ type: "error", data: { code: "unauthorized", message: "bad token" } }]);
    });

    test("a Bearer header authenticates when neither the query nor hello carries a token", async (t) => {
        const seen: unknown[] = [];
        const { handle, url } = await serve({ authenticator: { authenticate: (cred) => (seen.push(cred.token), { ok: true, userId: "bearer-user" }) } });
        t.after(() => handle.close());
        const c = await new Client(url(), { headers: { Authorization: "Bearer abc.def" } }).open();
        t.after(() => c.ws.close());
        c.send({ type: "hello" });
        await c.waitFor((x) => x.of("welcome").length === 1, "welcome");
        assert.deepEqual(seen, ["abc.def"]);
        assert.equal(welcome(c).userId, "bearer-user");
    });
});

describe("serveWs edges — server wiring", () => {
    test("with a path, upgrades on any other path are refused", async (t) => {
        const { handle, url } = await serve({}, "/ws");
        t.after(() => handle.close());
        const ok = await new Client(url()).open();
        t.after(() => ok.ws.close());

        const wrong = new WebSocket(url().replace("/ws", "/other"));
        const outcome = await Promise.race([
            once(wrong, "open").then(() => "open"),
            once(wrong, "error").then(() => "error"),
            once(wrong, "unexpected-response").then(() => "rejected"),
        ]);
        assert.notEqual(outcome, "open");
        wrong.terminate();
    });

    test("an injected HTTP server is attached to, and left running by close()", async () => {
        const server = createServer((_req, res) => res.end("still here"));
        server.listen(0);
        await once(server, "listening");
        const port = (server.address() as AddressInfo).port;
        const app = mekik({ graph: echo, reply: (s) => s.reply as string });
        const handle = serveWs(app, { server, port: 1 /* ignored when server is given */ });

        const c = await new Client(`ws://127.0.0.1:${port}/`).open();
        c.send({ type: "hello" });
        await c.waitFor((x) => x.of("welcome").length === 1, "welcome over the injected server");

        await handle.close();
        assert.equal(server.listening, true, "close() does not own an injected server");
        const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
        assert.equal(body, "still here");
        await new Promise<void>((r) => server.close(() => r()));
    });
});

describe("serveWs edges — ordering against a spy app", () => {
    // A stand-in that records the order of the three calls serveWs makes.
    class OrderApp {
        readonly log: string[] = [];
        gate: Promise<void> = Promise.resolve();
        async connect(conn: Connection, _p?: ConnectParams): Promise<void> {
            this.log.push(`connect-start:${conn.id.length > 0}`);
            await this.gate;
            this.log.push("connect-end");
        }
        async receive(): Promise<void> {
            this.log.push("receive");
        }
        disconnect(): void {
            this.log.push("disconnect");
        }
    }

    test("disconnect never overtakes an in-flight connect", async (t) => {
        const app = new OrderApp();
        let open!: () => void;
        app.gate = new Promise((r) => (open = r));
        const handle: ServeWsHandle = serveWs(app as unknown as MekikApp, { port: 0 });
        t.after(() => handle.close());
        await once(handle.server, "listening");
        const port = (handle.server.address() as AddressInfo).port;

        const c = await new Client(`ws://127.0.0.1:${port}/`).open();
        c.send({ type: "hello" });
        await new Promise((r) => setTimeout(r, 20));
        c.ws.close();
        await once(c.ws, "close");
        await new Promise((r) => setTimeout(r, 20));
        open();
        const deadline = Date.now() + 2000;
        while (!app.log.includes("disconnect") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
        assert.deepEqual(app.log, ["connect-start:true", "connect-end", "disconnect"]);
    });
});
