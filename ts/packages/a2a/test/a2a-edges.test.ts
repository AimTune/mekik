// serveA2a at the HTTP edges (PROTOCOL.md §14.4 "Transport"): a custom card
// path, the method rules on both paths, the body cap in bytes, a failing
// handler, and a whole message/send whose text is not ASCII.

import test, { describe, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { channel, END, graph, START } from "@ilmek/core";
import { mekik, MekikA2aServer } from "@mekik/core";

import { serveA2a, AGENT_CARD_PATH, type ServeA2aHandle } from "../src/index.ts";

const echo = graph("echo")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("say", (s) => ({ reply: `echo: ${s.input}` }))
    .edge(START, "say")
    .edge("say", END)
    .compile();

const agent = () => new MekikA2aServer(mekik({ graph: echo, reply: (s) => s.reply as string }), { name: "Echo", url: "http://localhost/a2a" });

const handles: ServeA2aHandle[] = [];
after(async () => {
    for (const h of handles) await h.close();
});
async function serve(a: MekikA2aServer, options: { path?: string; cardPath?: string; maxBodyBytes?: number } = {}): Promise<string> {
    const handle = serveA2a(a, { port: 0, ...options });
    handles.push(handle);
    await once(handle.server, "listening");
    return `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
}
const post = (url: string, body: string) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });

describe("serveA2a edges", () => {
    test("a custom card path serves the card; the default path is then 404", async () => {
        const base = await serve(agent(), { cardPath: "/card.json" });
        const res = await fetch(`${base}/card.json`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /application\/json/);
        assert.equal(((await res.json()) as { name: string }).name, "Echo");
        assert.equal((await fetch(`${base}${AGENT_CARD_PATH}`)).status, 404);
    });

    test("only GET on the card path (Allow: GET) and only POST on the endpoint (Allow: POST)", async () => {
        const base = await serve(agent());
        for (const method of ["POST", "PUT", "DELETE"]) {
            const res = await fetch(`${base}${AGENT_CARD_PATH}`, { method });
            assert.equal(res.status, 405, `${method} card`);
            assert.equal(res.headers.get("allow"), "GET");
        }
        for (const method of ["GET", "PUT", "DELETE"]) {
            const res = await fetch(`${base}/a2a`, { method });
            assert.equal(res.status, 405, `${method} endpoint`);
            assert.equal(res.headers.get("allow"), "POST");
        }
    });

    test("the body cap is inclusive and in bytes", async () => {
        const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "t" } });
        const base = await serve(agent(), { maxBodyBytes: Buffer.byteLength(req) });
        assert.equal((await post(`${base}/a2a`, req)).status, 200);
        assert.equal((await post(`${base}/a2a`, req.replace(`"t"`, `"₺"`))).status, 413);
    });

    test("a handler that throws is a 500 carrying -32603", async () => {
        const broken = agent();
        broken.handle = async () => {
            throw new Error("exploded");
        };
        const base = await serve(broken);
        const res = await post(`${base}/a2a`, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: "t" } }));
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: null, error: { code: -32603, message: "exploded" } });
    });

    test("a whole message/send with non-ASCII text comes back as a completed task", async () => {
        const base = await serve(agent());
        const res = await post(
            `${base}/a2a`,
            JSON.stringify({ jsonrpc: "2.0", id: 3, method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "Şubat 🎉" }] } } }),
        );
        const task = ((await res.json()) as { result: { status: { state: string }; artifacts: { parts: { text: string }[] }[] } }).result;
        assert.equal(task.status.state, "completed");
        assert.equal(task.artifacts[0]!.parts[0]!.text, "echo: Şubat 🎉");
    });
});
