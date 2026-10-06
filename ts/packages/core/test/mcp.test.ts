// mekik as an MCP server (PROTOCOL.md §13). The JSON-RPC surface is pinned by
// conformance/mcp/rpc.json (shared with .NET); the turn mapping — a finished
// run, a paused run and its resume, a graph error, a refused turn, tool and
// skill traces — is driven through a real app here.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { channel, END, graph, InMemoryCheckpointer, START } from "@ilmek/core";

import { mekik } from "../src/index.ts";
import { MekikMcpServer, summarize, type McpCallToolResult } from "../src/mcp.ts";
import { canonicalize } from "../src/protocol.ts";

const rpcFixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../conformance/mcp/rpc.json"), "utf8")) as {
    options: { name: string; description: string; serverInfo: { name: string; version: string } };
    cases: Array<{ name: string; request: unknown; response: unknown }>;
};

// ── graphs ────────────────────────────────────────────────────────────────────

/** Answers, using a traced tool and a skill; asks for approval when the input says so. */
const desk = graph("desk")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("agent", async (s, ctx) => {
        if (s.input === "boom") throw new Error("kaboom");
        const order = await mekik.tool(ctx, "get_order", { id: "ORD-42" }, () => ({ id: "ORD-42", total: 249.9 }));
        mekik.loadSkill(ctx, "brand-voice");
        mekik.text(ctx, "Looking");
        mekik.text(ctx, " it up…");
        if (s.input.startsWith("refund")) {
            const ok = await mekik.choose(ctx, { title: `Refund ${order.total}?` }, [mekik.action("Approve", { approved: true }), "Cancel"]);
            return { reply: typeof ok === "object" && ok.approved ? "Refunded." : "Cancelled." };
        }
        return { reply: `Order ${order.id} totals ${order.total}.` };
    })
    .edge(START, "agent")
    .edge("agent", END)
    .compile();

const app = () =>
    mekik({
        graph: desk,
        checkpointer: new InMemoryCheckpointer(),
        reply: (s) => s.reply as string,
        skills: [{ name: "brand-voice", description: "House style.", instructions: "Short sentences." }],
    });

const server = (a = app(), extra: Partial<ConstructorParameters<typeof MekikMcpServer>[1]> = {}) =>
    new MekikMcpServer(a, { ...rpcFixture.options, ...extra });

// ── conformance/mcp/rpc.json ──────────────────────────────────────────────────

describe("JSON-RPC surface (conformance/mcp/rpc.json)", () => {
    for (const c of rpcFixture.cases) {
        test(c.name, async () => {
            const response = await server().handle(c.request);
            assert.equal(canonicalize(response), canonicalize(c.response));
        });
    }
});

// ── the turn mapping ──────────────────────────────────────────────────────────

describe("tools/call (§13.2)", () => {
    test("a finished turn returns the reply, the traced tools and the loaded skills", async () => {
        const s = server();
        const r = await s.callTool("support_desk", { message: "where is my order?" });
        assert.equal(r.isError, undefined);
        assert.deepEqual(r.content, [{ type: "text", text: "Order ORD-42 totals 249.9." }]);
        const sc = r.structuredContent;
        assert.equal(sc.status, "finished");
        assert.equal(sc.reply, "Order ORD-42 totals 249.9.");
        assert.match(sc.conversationId, /^conv-/);
        assert.deepEqual(sc.toolCalls.map((t) => [t.name, t.status]), [["get_order", "completed"]]);
        assert.deepEqual(sc.skills, ["brand-voice"]);
        assert.deepEqual(sc.pending, []);
        assert.equal(sc.frames, undefined);
    });

    test("a conversationId continues the same conversation; an unknown one starts a fresh one", async () => {
        const a = app();
        const s = server(a);
        const first = await s.callTool("support_desk", { message: "hi" });
        const again = await s.callTool("support_desk", { message: "hi again", conversationId: first.structuredContent.conversationId });
        assert.equal(again.structuredContent.conversationId, first.structuredContent.conversationId);
        const fresh = await s.callTool("support_desk", { message: "hi", conversationId: "conv-does-not-exist" });
        assert.notEqual(fresh.structuredContent.conversationId, "conv-does-not-exist");
        assert.equal((await a.history.after(again.structuredContent.conversationId, 0)).filter((f) => f.type === "text").length, 4, "two user turns, two replies");
    });

    test("a paused turn returns the pending interrupts; the resume tool answers them", async () => {
        const s = server();
        const paused = await s.callTool("support_desk", { message: "refund please" });
        assert.equal(paused.structuredContent.status, "interrupted");
        assert.equal(paused.isError, undefined);
        const [p] = paused.structuredContent.pending;
        assert.ok(p);
        assert.deepEqual(p.payload, { title: "Refund 249.9?" });
        assert.deepEqual(p.actions, [{ label: "Approve", value: { approved: true } }, { label: "Cancel" }]);
        assert.match(paused.content[0]!.text, /paused and needs input/);
        assert.match(paused.content[0]!.text, /options: \{"approved":true\}, "Cancel"/);
        assert.match(paused.content[0]!.text, new RegExp(`Call support_desk__resume with conversationId "${paused.structuredContent.conversationId}"`));

        const resumed = await s.callTool("support_desk__resume", {
            conversationId: paused.structuredContent.conversationId,
            answers: { [p.id]: { approved: true } },
        });
        assert.equal(resumed.structuredContent.status, "finished");
        assert.equal(resumed.structuredContent.reply, "Refunded.");
        assert.deepEqual(resumed.structuredContent.toolCalls.map((t) => t.status), ["completed"], "the journaled tool re-traces on replay, upserted");
    });

    test("a turn while parked, or a resume with nothing open, is a refused result — not a crash", async () => {
        const s = server();
        const paused = await s.callTool("support_desk", { message: "refund please" });
        const convId = paused.structuredContent.conversationId;
        const busy = await s.callTool("support_desk", { message: "hello?", conversationId: convId });
        assert.equal(busy.isError, true);
        assert.equal(busy.structuredContent.status, "refused");
        assert.match(busy.content[0]!.text, /^interrupted: answer the open interrupt/);

        const nothing = await s.callTool("support_desk__resume", { conversationId: (await s.callTool("support_desk", { message: "hi" })).structuredContent.conversationId, answers: { x: 1 } });
        assert.equal(nothing.structuredContent.status, "refused");
        assert.match(nothing.content[0]!.text, /^not_interrupted/);
    });

    test("a graph error is a result with isError, carrying the error text", async () => {
        const r = await server().callTool("support_desk", { message: "boom" });
        assert.equal(r.isError, true);
        assert.equal(r.structuredContent.status, "error");
        assert.match(r.content[0]!.text, /agent: kaboom/);
    });

    test("includeFrames puts the turn's persistent frames in structuredContent", async () => {
        const r = await server(app(), { includeFrames: true }).callTool("support_desk", { message: "hi" });
        const types = r.structuredContent.frames!.map((f) => f.type);
        assert.ok(types.includes("tool_call") && types.includes("skill") && types.includes("genui") && types.includes("text"));
        assert.ok(!types.includes("run"), "transient frames are not included");
    });

    test("argument shape errors throw McpArgumentError; the JSON-RPC layer maps them to -32602", async () => {
        const s = server();
        await assert.rejects(s.callTool("support_desk", { message: 5 }), /`message` \(string\) is required/);
        await assert.rejects(s.callTool("support_desk", { message: "x", conversationId: 5 }), /`conversationId` must be a string/);
        await assert.rejects(s.callTool("support_desk__resume", { answers: {} }), /`conversationId` \(string\) is required/);
        const viaRpc = await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "support_desk", arguments: { message: 5 } } });
        assert.equal(viaRpc?.error?.code, -32602);
        const ok = await s.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "support_desk", arguments: { message: "hi" } } });
        assert.equal((ok?.result as McpCallToolResult).structuredContent.status, "finished");
    });

    test("the tool name is validated", () => {
        assert.throws(() => new MekikMcpServer(app(), { name: "not valid!" }), /must be 1–64 letters/);
        assert.equal(new MekikMcpServer(app(), { name: "a-b_c" }).resumeName, "a-b_c__resume");
    });
});

describe("summarize (pure)", () => {
    test("streamed text stands in for a missing reply; a refused turn names the error; an aborted run says so", () => {
        const streamed = summarize("c", [
            { type: "run", data: { status: "started" } },
            { type: "genui", seq: 1, streamId: "s", done: false, chunk: { type: "text", content: "Hel", id: 1 } },
            { type: "genui", seq: 2, streamId: "s", done: false, chunk: { type: "text", content: "lo", id: 1 } },
            { type: "run", data: { status: "finished" } },
        ], "x__resume", false);
        assert.equal(streamed.content[0]!.text, "Hello");
        assert.equal(streamed.structuredContent.reply, "Hello");

        const refused = summarize("c", [{ type: "error", data: { code: "busy", message: "a run is already in flight" } }], "x__resume", false);
        assert.equal(refused.isError, true);
        assert.equal(refused.content[0]!.text, "busy: a run is already in flight");

        const aborted = summarize("c", [{ type: "run", data: { status: "aborted" } }], "x__resume", false);
        assert.equal(aborted.structuredContent.status, "aborted");
        assert.equal(aborted.isError, undefined);

        const empty = summarize("c", [{ type: "run", data: { status: "finished" } }], "x__resume", false);
        assert.equal(empty.content[0]!.text, "(no reply)");
    });

    test("a client-tool pause is described as unanswerable from here", () => {
        const r = summarize("c", [
            { type: "interrupt", seq: 1, id: "call/0:tool:pick_date", data: { payload: {}, tool: { name: "pick_date" } } },
            { type: "run", data: { status: "interrupted" } },
        ], "x__resume", false);
        assert.deepEqual(r.structuredContent.pending, [{ id: "call/0:tool:pick_date", payload: {}, tool: "pick_date" }]);
        assert.match(r.content[0]!.text, /client tool call \(pick_date\)/);
    });
});
