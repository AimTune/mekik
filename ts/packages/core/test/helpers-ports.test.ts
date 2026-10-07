// Author helpers and ports at their edges: a failing `mekik.tool`, hand-rolled
// traces, the recursion budget, the reference authenticator, the single-node
// scaling defaults, and the A2A task lifecycle after a cancel.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { channel, END, graph, InMemoryCheckpointer, START } from "@ilmek/core";

import { mekik } from "../src/index.ts";
import { nextToolCallId, skillResourcesAvailable, toolTrace } from "../src/helpers.ts";
import { StaticTokenAuthenticator } from "../src/auth.ts";
import { LocalTurnLock, NoopBackplane } from "../src/scaling.ts";
import { MekikMcpServer } from "../src/mcp.ts";
import { MekikA2aServer, stateOf, type A2aTask, type A2aTaskStore } from "../src/a2a.ts";
import type { Connection } from "../src/engine.ts";
import type { OutgoingFrame } from "../src/protocol.ts";

class FakeConn implements Connection {
    readonly id: string;
    readonly sent: OutgoingFrame[] = [];
    constructor(id: string) {
        this.id = id;
    }
    send(frame: OutgoingFrame): void {
        this.sent.push(frame);
    }
    close(): void {}
}
let n = 0;
const conn = () => new FakeConn(`hp-${++n}`);
type Of<T extends OutgoingFrame["type"]> = Extract<OutgoingFrame, { type: T }>;
const all = <T extends OutgoingFrame["type"]>(c: FakeConn, t: T): Of<T>[] => c.sent.filter((f) => f.type === t) as Of<T>[];
const botTexts = (c: FakeConn) => all(c, "text").filter((f) => f.from === "bot").map((f) => f.data.text);

async function turn(g: Parameters<typeof mekik>[0]["graph"], text = "x", extra: Partial<Parameters<typeof mekik>[0]> = {}) {
    const app = mekik({ graph: g, reply: (s) => s.reply as string, ...extra });
    const c = conn();
    await app.connect(c);
    await app.receive(c, { type: "text", data: { text } });
    return c;
}

describe("mekik.tool failures (§6)", () => {
    const failing = (thrown: unknown) =>
        graph("failing-tool")
            .channel("input", channel.lastWrite<string>(""))
            .channel("reply", channel.lastWrite<string>(""))
            .node("n", async (_s, ctx) => {
                await mekik.tool(ctx, "charge", { amount: 5 }, () => {
                    throw thrown;
                });
                return { reply: "unreachable" };
            })
            .edge(START, "n")
            .edge("n", END)
            .compile();

    test("a thrown Error ends the trace in error with its message and fails the run", async () => {
        const c = await turn(failing(new Error("card declined")));
        const traces = all(c, "tool_call").map((f) => f.data);
        assert.deepEqual(traces.map((t) => t.status), ["running", "error"]);
        assert.equal(traces[0]!.id, traces[1]!.id, "one upserted trace");
        assert.equal(traces[1]!.error, "card declined");
        assert.deepEqual(traces[0]!.params, { amount: 5 });
        assert.equal(all(c, "run").at(-1)!.data.status, "error");
        assert.match(botTexts(c)[0]!, /card declined/);
    });

    test("a thrown non-Error is stringified into the trace", async () => {
        const c = await turn(failing("insufficient funds"));
        assert.equal(all(c, "tool_call").at(-1)!.data.error, "insufficient funds");
    });

    test("hand-rolled traces: nextToolCallId mints distinct per-ctx ids and toolTrace emits them verbatim", async () => {
        const g = graph("manual-trace")
            .channel("input", channel.lastWrite<string>(""))
            .node("n", (_s, ctx) => {
                const a = nextToolCallId(ctx);
                const b = nextToolCallId(ctx);
                toolTrace(ctx, { id: a, name: "lookup", status: "completed", result: { ok: true } });
                toolTrace(ctx, { id: b, name: "lookup", status: "error", error: "nope" });
                return {};
            })
            .edge(START, "n")
            .edge("n", END)
            .compile();
        const c = await turn(g);
        const traces = all(c, "tool_call").map((f) => f.data);
        assert.equal(traces.length, 2);
        assert.notEqual(traces[0]!.id, traces[1]!.id);
        assert.match(traces[0]!.id, /:tool:0$/);
        assert.match(traces[1]!.id, /:tool:1$/);
        assert.deepEqual(traces[0], { id: traces[0]!.id, name: "lookup", status: "completed", result: { ok: true } });
    });
});

describe("skill resources availability (§12.5)", () => {
    const probe = graph("res-probe")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("n", (_s, ctx) => ({ reply: String(skillResourcesAvailable(ctx)) }))
        .edge(START, "n")
        .edge("n", END)
        .compile();

    test("false without skills, false for an inline list, true for a source with files", async () => {
        assert.deepEqual(botTexts(await turn(probe)), ["false"]);
        assert.deepEqual(botTexts(await turn(probe, "x", { skills: [{ name: "a", description: "d", instructions: "i" }] })), ["false"]);
        const source = {
            list: () => [{ name: "a", description: "d" }],
            get: () => ({ name: "a", description: "d", instructions: "i" }),
            readResource: async () => "file",
        };
        assert.deepEqual(botTexts(await turn(probe, "x", { skills: source })), ["true"]);
    });
});

describe("the recursion budget", () => {
    const loop = graph("loop")
        .channel("input", channel.lastWrite<string>(""))
        .channel("count", channel.lastWrite<number>(0))
        .channel("reply", channel.lastWrite<string>(""))
        .node("spin", (s) => ({ count: s.count + 1 }))
        .edge(START, "spin")
        .edge("spin", "spin")
        .compile();

    test("a run that exceeds recursionLimit ends on run{error} for every tab, and the lock is freed", async () => {
        const app = mekik({ graph: loop, recursionLimit: 3 });
        const a = conn();
        await app.connect(a, { hello: { userId: "u" } });
        const b = conn();
        await app.connect(b, { hello: { userId: "u", conversationId: all(a, "welcome")[0]!.data.conversationId } });

        await app.receive(a, { type: "text", data: { text: "go" } });

        for (const tab of [a, b]) {
            assert.deepEqual(all(tab, "run").map((f) => f.data.status), ["started", "error"], "a started run always ends on a terminal run frame");
            assert.match(botTexts(tab)[0]!, /^⚠️ .*exceeded 3 supersteps/);
        }
        await app.receive(a, { type: "text", data: { text: "again" } });
        assert.deepEqual(all(a, "error"), [], "no busy lock left behind");
        assert.deepEqual(all(a, "run").map((f) => f.data.status), ["started", "error", "started", "error"]);
    });

    test("the failure text is persistent, so a later tab replays it", async () => {
        const app = mekik({ graph: loop, recursionLimit: 2 });
        const a = conn();
        await app.connect(a, { hello: { userId: "u" } });
        await app.receive(a, { type: "text", data: { text: "go" } });
        const late = conn();
        await app.connect(late, { hello: { userId: "u", conversationId: all(a, "welcome")[0]!.data.conversationId } });
        assert.match(botTexts(late)[0]!, /exceeded 2 supersteps/);
    });

    test("over MCP it is a result with isError — a failure inside the graph, not an RPC error", async () => {
        const server = new MekikMcpServer(mekik({ graph: loop, recursionLimit: 2 }), { name: "spinner" });
        const res = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "spinner", arguments: { message: "go" } } });
        assert.equal(res?.error, undefined);
        const result = res?.result as { isError?: boolean; structuredContent: { status: string } };
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.status, "error");
    });
});

describe("reference ports", () => {
    test("StaticTokenAuthenticator: no token, unknown token, and a hit without claims", () => {
        const auth = new StaticTokenAuthenticator({ t1: { userId: "u1" } });
        assert.deepEqual(auth.authenticate({}), { ok: false, reason: "no token presented" });
        assert.deepEqual(auth.authenticate({ token: "t2" }), { ok: false, reason: "invalid token" });
        assert.deepEqual(auth.authenticate({ token: "t1" }), { ok: true, userId: "u1" });
    });

    test("an inherited key is not a token (the table is a Map, not an object lookup)", () => {
        const auth = new StaticTokenAuthenticator({});
        assert.equal(auth.authenticate({ token: "constructor" }).ok, false);
        assert.equal(auth.authenticate({ token: "__proto__" }).ok, false);
    });

    test("LocalTurnLock always grants a no-op lease; NoopBackplane never delivers", async () => {
        const lease = await new LocalTurnLock().acquire("c");
        await lease.renew();
        await lease.release();
        const bp = new NoopBackplane();
        let delivered = 0;
        const sub = await bp.subscribe("c", () => delivered++);
        await bp.publish("c", { originId: "other", frame: { type: "run", data: { status: "started" } } });
        await sub.unsubscribe();
        assert.equal(delivered, 0);
    });
});

describe("A2A task lifecycle edges (§14.4)", () => {
    const gate = graph("a2a-gate")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("n", async (s, ctx) => {
            const ok = await mekik.approve<string>(ctx, { q: `ship ${s.input}?` }, { actions: [mekik.action("Yes", "yes")] });
            return { reply: `answer:${ok}` };
        })
        .edge(START, "n")
        .edge("n", END)
        .compile();
    let id = 0;
    const server = (store?: A2aTaskStore) =>
        new MekikA2aServer(mekik({ graph: gate, checkpointer: new InMemoryCheckpointer(), reply: (s) => s.reply as string }), {
            name: "desk",
            url: "http://x/a2a",
            now: () => 0,
            mintId: (k) => `${k}-${++id}`,
            ...(store ? { tasks: store } : {}),
        });
    const say = (text: string, extra: Record<string, unknown> = {}) => ({ message: { role: "user", parts: [{ kind: "text", text }], ...extra } });

    test("a canceled task takes no more input; the conversation stays parked for other doors", async () => {
        const s = server();
        const task = await s.sendMessage(say("ORD-1"));
        assert.equal(task.status.state, "input-required");
        const canceled = await s.cancelTask(task.id);
        assert.equal(canceled.status.state, "canceled");
        assert.equal(canceled.status.message, undefined);

        const res = await s.handle({ jsonrpc: "2.0", id: 1, method: "message/send", params: say("Yes", { taskId: task.id }) });
        assert.deepEqual(res?.error, { code: -32602, message: `task "${task.id}" is canceled and takes no more input` });

        const next = await s.sendMessage(say("hello", { contextId: task.contextId }));
        assert.equal(next.status.state, "rejected", "the pause still stands");
        assert.match(JSON.stringify(next.status.message), /interrupted/);
    });

    test("canceling twice is TaskNotCancelable", async () => {
        const s = server();
        const task = await s.sendMessage(say("ORD-2"));
        await s.cancelTask(task.id);
        const res = await s.handle({ jsonrpc: "2.0", id: 2, method: "tasks/cancel", params: { id: task.id } });
        assert.equal(res?.error?.code, -32002);
    });

    test("historyLength: negative means none, larger than the history means all", async () => {
        const s = server();
        const task = await s.sendMessage(say("ORD-3"));
        assert.deepEqual((await s.getTask(task.id, -5)).history, []);
        assert.equal((await s.getTask(task.id, 99)).history?.length, task.history?.length);
        const viaRpc = await s.handle({ jsonrpc: "2.0", id: 3, method: "tasks/get", params: { id: task.id, historyLength: "2" } });
        assert.equal((viaRpc?.result as A2aTask).history?.length, task.history?.length, "a non-numeric historyLength is ignored");
    });

    test("an unexpected failure (a broken task store) is -32603 with the message, not a crash", async () => {
        const broken: A2aTaskStore = {
            get: async () => {
                throw new Error("store offline");
            },
            put: async () => {},
        };
        const res = await server(broken).handle({ jsonrpc: "2.0", id: 4, method: "tasks/get", params: { id: "t" } });
        assert.deepEqual(res?.error, { code: -32603, message: "store offline" });
    });

    test("an action label answers with the action's value", async () => {
        const s = server();
        const task = await s.sendMessage(say("ORD-4"));
        const done = await s.sendMessage(say("Yes", { taskId: task.id }));
        assert.equal(done.status.state, "completed");
        assert.equal(done.artifacts?.at(-1)?.parts[0]?.kind === "text" ? (done.artifacts.at(-1)!.parts[0] as { text: string }).text : "", "answer:yes");
    });

    test("every turn status maps to its task state", () => {
        assert.deepEqual(
            (["finished", "interrupted", "error", "aborted", "refused"] as const).map(stateOf),
            ["completed", "input-required", "failed", "canceled", "rejected"],
        );
    });
});
