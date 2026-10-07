// serveMcp at the HTTP edges (PROTOCOL.md §13.2 "Transport"): the body cap at
// its exact boundary and in bytes rather than characters, empty and non-object
// bodies, the path filter with a query string or a trailing slash, every other
// method, a failing handler, and a turn whose message is not ASCII.

import test, { describe, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { channel, END, graph, START } from "@ilmek/core";
import { mekik, MekikMcpServer } from "@mekik/core";

import { serveMcp, type ServeMcpHandle } from "../src/index.ts";

const echo = graph("echo")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("say", (s) => ({ reply: `echo: ${s.input}` }))
    .edge(START, "say")
    .edge("say", END)
    .compile();

const handles: ServeMcpHandle[] = [];
after(async () => {
    for (const h of handles) await h.close();
});

async function serve(mcp: MekikMcpServer, options: { path?: string; maxBodyBytes?: number } = {}): Promise<string> {
    const handle = serveMcp(mcp, { port: 0, ...options });
    handles.push(handle);
    await once(handle.server, "listening");
    return `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
}
const server = () => new MekikMcpServer(mekik({ graph: echo, reply: (s) => s.reply as string }), { name: "echo" });
const post = (url: string, body: string) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });

describe("serveMcp edges", () => {
    test("the body cap is inclusive and counted in bytes, not characters", async () => {
        const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
        const exact = Buffer.byteLength(ping, "utf8");
        const base = await serve(server(), { maxBodyBytes: exact });
        assert.equal((await post(`${base}/mcp`, ping)).status, 200, "exactly at the cap");
        assert.equal((await post(`${base}/mcp`, ping + " ")).status, 413, "one byte over");

        // Same character count as `ping`, more bytes: "₺" is three bytes in UTF-8.
        const wide = ping.replace("ping", "pin₺");
        const res = await post(`${base}/mcp`, wide);
        assert.equal(res.status, 413);
        assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "request body too large" } });
    });

    test("an empty body is a parse error; a JSON non-object is an invalid request with 200", async () => {
        const base = await serve(server());
        const empty = await post(`${base}/mcp`, "");
        assert.equal(empty.status, 400);
        assert.equal(((await empty.json()) as { error: { code: number } }).error.code, -32700);

        const nul = await post(`${base}/mcp`, "null");
        assert.equal(nul.status, 200);
        assert.equal(((await nul.json()) as { error: { code: number } }).error.code, -32600);
    });

    test("the path filter ignores the query string but not a trailing slash", async () => {
        const base = await serve(server());
        const ping = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
        assert.equal((await post(`${base}/mcp?session=abc`, ping)).status, 200);
        assert.equal((await post(`${base}/mcp/`, ping)).status, 404);
    });

    test("PUT and PATCH are 405 with Allow: POST, DELETE", async () => {
        const base = await serve(server());
        for (const method of ["PUT", "PATCH"]) {
            const res = await fetch(`${base}/mcp`, { method, body: "{}" });
            assert.equal(res.status, 405, method);
            assert.equal(res.headers.get("allow"), "POST, DELETE");
        }
    });

    test("a handler that throws is a 500 carrying -32603, and the server keeps serving", async () => {
        const broken = server();
        let fail = true;
        const real = broken.handle.bind(broken);
        broken.handle = async (m) => {
            if (fail) throw new Error("exploded");
            return real(m);
        };
        const base = await serve(broken);
        const res = await post(`${base}/mcp`, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }));
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: null, error: { code: -32603, message: "exploded" } });
        fail = false;
        assert.equal((await post(`${base}/mcp`, JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }))).status, 200);
    });

    test("a non-ASCII message round-trips through a whole turn", async () => {
        const base = await serve(server());
        const res = await post(
            `${base}/mcp`,
            JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo", arguments: { message: "İade 249,90 ₺ 🎉" } } }),
        );
        const body = (await res.json()) as { result: { content: { text: string }[] } };
        assert.equal(body.result.content[0]!.text, "echo: İade 249,90 ₺ 🎉");
        assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    });
});
