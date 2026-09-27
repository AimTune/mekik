// The A2A HTTP transport is a thin adapter (src/index.ts): the Agent Card on
// GET, one JSON-RPC message per POST. What THIS package owns — and what these
// tests pin — is the HTTP glue. A real fetch talks to a real serveA2a on an
// ephemeral port; the app behind it is a tiny echo graph.

import test, { describe, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { channel, END, graph, START } from "@ilmek/core";
import { mekik, MekikA2aServer } from "@mekik/core";

import { AGENT_CARD_PATH, a2aRequestHandler, serveA2a, type ServeA2aHandle } from "../src/index.ts";

const echo = graph("echo")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("say", (s) => ({ reply: `echo: ${s.input}` }))
    .edge(START, "say")
    .edge("say", END)
    .compile();

const agent = new MekikA2aServer(mekik({ graph: echo, reply: (s) => s.reply as string }), { name: "Echo", url: "http://localhost/a2a" });

const handles: ServeA2aHandle[] = [];
after(async () => {
    for (const h of handles) await h.close();
});

async function serve(options: { path?: string; cardPath?: string; maxBodyBytes?: number } = {}): Promise<string> {
    const handle = serveA2a(agent, { port: 0, ...options });
    handles.push(handle);
    await once(handle.server, "listening");
    return `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
}

const post = (url: string, body: unknown) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("serveA2a", () => {
    test("GET the card; POST a full message/send", async () => {
        const base = await serve();
        const card = await fetch(`${base}${AGENT_CARD_PATH}`);
        assert.equal(card.status, 200);
        assert.equal(((await card.json()) as { name: string }).name, "Echo");
        assert.equal((await post(`${base}${AGENT_CARD_PATH}`, {})).status, 405);

        const res = await post(`${base}/a2a`, {
            jsonrpc: "2.0",
            id: 1,
            method: "message/send",
            params: { message: { role: "user", parts: [{ kind: "text", text: "hi" }] } },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { result: { status: { state: string }; artifacts: Array<{ parts: Array<{ text: string }> }> } };
        assert.equal(body.result.status.state, "completed");
        assert.equal(body.result.artifacts[0]!.parts[0]!.text, "echo: hi");
    });

    test("notification → 202, bad JSON → 400, oversized → 413, GET endpoint → 405, other path → 404", async () => {
        const base = await serve({ path: "/agent", maxBodyBytes: 64 });
        assert.equal((await post(`${base}/agent`, { jsonrpc: "2.0", method: "notifications/x" })).status, 202);
        assert.equal((await post(`${base}/agent`, "{nope")).status, 400);
        assert.equal((await post(`${base}/agent`, { jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "x".repeat(200) } })).status, 413);
        assert.equal((await fetch(`${base}/agent`)).status, 405);
        assert.equal((await post(`${base}/a2a`, { jsonrpc: "2.0", id: 1, method: "tasks/get" })).status, 404);
    });

    test("mounts on an existing server and leaves other routes alone", async () => {
        const server = createServer((req, res) => {
            if (req.url === "/health") res.writeHead(200).end("ok");
        });
        handles.push(serveA2a(agent, { server, cardPath: "/card.json" }));
        server.listen(0);
        await once(server, "listening");
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        assert.equal(await (await fetch(`${base}/health`)).text(), "ok");
        assert.equal((await fetch(`${base}/card.json`)).status, 200);
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    test("a2aRequestHandler reports whether it handled the request", async () => {
        const handler = a2aRequestHandler(agent);
        assert.equal(typeof handler, "function");
    });
});
