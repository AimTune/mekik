// The Streamable HTTP transport is a thin adapter (src/index.ts): one JSON-RPC
// message per POST, handed to MekikMcpServer.handle. What THIS package owns —
// and what these tests pin — is the HTTP glue: method handling, the 202 for a
// notification, the 400 for bad JSON, the 413 body cap, the path filter, and
// mounting on a shared server. A real fetch talks to a real serveMcp on an
// ephemeral port; the app behind it is a tiny echo graph.

import test, { describe, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { channel, END, graph, START } from "@ilmek/core";
import { mekik, MekikMcpServer } from "@mekik/core";

import { mcpRequestHandler, serveMcp, type ServeMcpHandle } from "../src/index.ts";

const echo = graph("echo")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("say", (s) => ({ reply: `echo: ${s.input}` }))
    .edge(START, "say")
    .edge("say", END)
    .compile();

const mcp = new MekikMcpServer(mekik({ graph: echo, reply: (s) => s.reply as string }), { name: "echo" });

const handles: ServeMcpHandle[] = [];
after(async () => {
    for (const h of handles) await h.close();
});

async function serve(options: { path?: string; maxBodyBytes?: number } = {}): Promise<string> {
    const handle = serveMcp(mcp, { port: 0, ...options });
    handles.push(handle);
    await once(handle.server, "listening");
    return `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
}

const post = (url: string, body: unknown) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("serveMcp", () => {
    test("POST answers a request; a notification gets 202", async () => {
        const base = await serve();
        const res = await post(`${base}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "application/json");
        const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
        assert.deepEqual(body.result.tools.map((t) => t.name), ["echo", "echo__resume"]);

        const note = await post(`${base}/mcp`, { jsonrpc: "2.0", method: "notifications/initialized" });
        assert.equal(note.status, 202);
    });

    test("a full turn over HTTP", async () => {
        const base = await serve();
        const res = await post(`${base}/mcp`, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo", arguments: { message: "hi" } } });
        const body = (await res.json()) as { result: { content: Array<{ text: string }>; structuredContent: { status: string } } };
        assert.equal(body.result.content[0]!.text, "echo: hi");
        assert.equal(body.result.structuredContent.status, "finished");
    });

    test("bad JSON is 400 with a parse error; an oversized body is 413", async () => {
        const base = await serve({ maxBodyBytes: 64 });
        const bad = await post(`${base}/mcp`, "{not json");
        assert.equal(bad.status, 400);
        assert.equal(((await bad.json()) as { error: { code: number } }).error.code, -32700);

        const big = await post(`${base}/mcp`, { jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(200) } });
        assert.equal(big.status, 413);
    });

    test("GET is 405, DELETE is 200, another path is 404", async () => {
        const base = await serve({ path: "/agent" });
        assert.equal((await fetch(`${base}/agent`)).status, 405);
        assert.equal((await fetch(`${base}/agent`, { method: "DELETE" })).status, 200);
        assert.equal((await post(`${base}/mcp`, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404);
    });

    test("mounts on an existing server and leaves other routes alone", async () => {
        const server = createServer((req, res) => {
            if (req.url === "/health") res.writeHead(200).end("ok");
        });
        const handle = serveMcp(mcp, { server, path: "/mcp" });
        handles.push(handle);
        server.listen(0);
        await once(server, "listening");
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        assert.equal(await (await fetch(`${base}/health`)).text(), "ok");
        assert.equal((await post(`${base}/mcp`, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 200);
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    test("mcpRequestHandler is exported for other frameworks", () => {
        assert.equal(typeof mcpRequestHandler(mcp), "function");
    });
});
