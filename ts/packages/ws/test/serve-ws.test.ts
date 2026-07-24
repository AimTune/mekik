// The WebSocket transport is a thin adapter (src/index.ts): it turns each socket
// into a `Connection` and drives a `MekikApp`. All the protocol logic lives in
// the engine, so what THIS package owns — and what these tests pin down — is the
// glue around it: identity merged from the query string and the first `hello`
// frame, the per-socket serialization (handshake before any frame, frames in
// order), a handler error surfaced as an `error` frame instead of a silent drop,
// and the connect/disconnect lifecycle. A real `ws` client talks to a real
// `serveWs` server on an ephemeral port; the app is a spy that only records what
// the transport hands it, so a failure here is a transport bug, not an engine one.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { WebSocket } from "ws";

import type { MekikApp, Connection, ConnectParams } from "@mekik/core";

import { serveWs, type ServeWsHandle } from "../src/index.ts";

// ── a MekikApp stand-in ───────────────────────────────────────────────────────
// serveWs calls exactly three methods on the app; a spy over them isolates the
// transport from the engine. `failReceive` lets a test make `receive` throw so
// the error-framing path can be exercised.
class SpyApp {
    connects: { id: string; params: ConnectParams | undefined }[] = [];
    receives: { id: string; raw: unknown }[] = [];
    disconnects: string[] = [];
    failReceive: Error | null = null;

    connect(conn: Connection, params?: ConnectParams): Promise<void> {
        this.connects.push({ id: conn.id, params });
        return Promise.resolve();
    }
    receive(conn: Connection, raw: string | unknown): Promise<void> {
        this.receives.push({ id: conn.id, raw });
        return this.failReceive ? Promise.reject(this.failReceive) : Promise.resolve();
    }
    disconnect(conn: Connection): void {
        this.disconnects.push(conn.id);
    }
}

// serveWs's parameter is the concrete MekikApp class; the spy implements the
// slice it actually uses, so we cross the type boundary once, here.
async function serve(app: SpyApp, options: { path?: string } = {}): Promise<{ handle: ServeWsHandle; port: number }> {
    const handle = serveWs(app as unknown as MekikApp, { port: 0, ...options });
    await once(handle.server, "listening");
    const addr = handle.server.address() as AddressInfo;
    return { handle, port: addr.port };
}

async function connect(port: number, target = "/"): Promise<WebSocket> {
    const client = new WebSocket(`ws://127.0.0.1:${port}${target}`);
    await once(client, "open");
    return client;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
        await delay(5);
    }
}

describe("serveWs — identity handshake", () => {
    test("a hello frame supplies identity and is consumed by the handshake, not re-delivered", async (t) => {
        const app = new SpyApp();
        const { handle, port } = await serve(app);
        t.after(() => handle.close());
        const client = await connect(port);
        t.after(() => client.close());

        client.send(JSON.stringify({ type: "hello", userId: "u1", conversationId: "c1" }));
        await waitFor(() => app.connects.length === 1, "connect");

        const call = app.connects[0];
        assert.ok(call);
        assert.equal(call.params?.hello?.userId, "u1");
        assert.equal(call.params?.hello?.conversationId, "c1");

        // The hello frame drove the handshake; it must NOT also arrive as a message.
        await delay(20);
        assert.equal(app.receives.length, 0);
    });

    test("query-string identity + a non-hello first frame: connect, then that frame is delivered", async (t) => {
        const app = new SpyApp();
        const { handle, port } = await serve(app);
        t.after(() => handle.close());
        const client = await connect(port, "/?userId=u2");
        t.after(() => client.close());

        const first = JSON.stringify({ type: "text", data: { text: "hi" } });
        client.send(first);
        await waitFor(() => app.receives.length === 1, "first frame delivered");

        assert.equal(app.connects.length, 1);
        assert.equal(app.connects[0]?.params?.hello?.userId, "u2");
        // Identity came from the query string, so the first (non-hello) frame is
        // still real traffic and must reach the engine.
        assert.equal(app.receives[0]?.raw, first);
    });

    test("the hello frame wins over the query string; watermark is coerced to a number", async (t) => {
        const app = new SpyApp();
        const { handle, port } = await serve(app);
        t.after(() => handle.close());
        const client = await connect(port, "/?userId=fromQuery&watermark=7&foo=bar");
        t.after(() => client.close());

        client.send(JSON.stringify({ type: "hello", userId: "fromFrame", conversationId: "c9" }));
        await waitFor(() => app.connects.length === 1, "connect");

        const params = app.connects[0]?.params;
        assert.equal(params?.hello?.userId, "fromFrame"); // frame overrides query
        assert.equal(params?.hello?.conversationId, "c9");
        assert.equal(params?.hello?.watermark, 7); // untouched by the frame → kept from the query
        assert.equal(typeof params?.hello?.watermark, "number"); // and coerced out of its string form
        assert.equal(params?.credential?.query?.foo, "bar"); // raw query preserved for the authenticator
    });

    test("a Bearer Authorization header becomes the credential token", async (t) => {
        const app = new SpyApp();
        const { handle, port } = await serve(app);
        t.after(() => handle.close());
        const client = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { authorization: "Bearer sekret" } });
        t.after(() => client.close());
        await once(client, "open");

        client.send(JSON.stringify({ type: "hello", userId: "u4" }));
        await waitFor(() => app.connects.length === 1, "connect");

        const params = app.connects[0]?.params;
        assert.equal(params?.hello?.token, "sekret");
        assert.equal(params?.credential?.token, "sekret");
    });
});

describe("serveWs — ordering & errors", () => {
    test("frames are delivered in order, and only after the handshake", async (t) => {
        const app = new SpyApp();
        const { handle, port } = await serve(app);
        t.after(() => handle.close());
        const client = await connect(port, "/?userId=u5");
        t.after(() => client.close());

        // A back-to-back burst: the first is the hello-less first frame, the rest
        // pile up behind it. The per-socket chain must keep them ordered.
        const frames = [0, 1, 2, 3, 4].map((i) => JSON.stringify({ type: "text", data: { text: `m${i}` } }));
        for (const frame of frames) client.send(frame);

        await waitFor(() => app.receives.length === frames.length, "all frames delivered");
        assert.equal(app.connects.length, 1); // connect ran once, ahead of the frames
        assert.deepEqual(
            app.receives.map((r) => r.raw),
            frames,
        );
    });

    test("a throwing receive surfaces an error frame and keeps the socket open", async (t) => {
        const app = new SpyApp();
        app.failReceive = new Error("boom");
        const { handle, port } = await serve(app);
        t.after(() => handle.close());
        const client = await connect(port, "/?userId=u6");
        t.after(() => client.close());

        const message = once(client, "message");
        client.send(JSON.stringify({ type: "text", data: { text: "hi" } }));
        const [raw] = await message;
        const frame = JSON.parse(raw.toString());

        assert.equal(frame.type, "error");
        assert.equal(frame.data.code, "internal");
        assert.equal(frame.data.message, "boom");
        assert.equal(client.readyState, WebSocket.OPEN); // the handler error did not take the socket down
        assert.equal(app.connects.length, 1);
    });
});

describe("serveWs — lifecycle", () => {
    test("closing after the handshake disconnects; closing before it does not", async (t) => {
        const app = new SpyApp();
        const { handle, port } = await serve(app);
        t.after(() => handle.close());

        // (a) closed before the first frame → connect never ran → no disconnect.
        const early = await connect(port);
        early.close();
        await once(early, "close");
        await delay(20);
        assert.equal(app.connects.length, 0);
        assert.equal(app.disconnects.length, 0);

        // (b) closed after the handshake → disconnect fires for that connection.
        const live = await connect(port);
        t.after(() => live.close());
        live.send(JSON.stringify({ type: "hello", userId: "u7" }));
        await waitFor(() => app.connects.length === 1, "connect");
        const id = app.connects[0]?.id;

        live.close();
        await waitFor(() => app.disconnects.length === 1, "disconnect");
        assert.equal(app.disconnects[0], id);
    });

    test("handle.close() resolves and drops live clients", async (t) => {
        const app = new SpyApp();
        const { handle, port } = await serve(app);
        const client = await connect(port);
        t.after(() => client.close());

        const closed = once(client, "close");
        await handle.close(); // resolves once the server and every socket are down
        await closed;
        assert.equal(client.readyState, WebSocket.CLOSED);
    });
});
