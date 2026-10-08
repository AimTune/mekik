// mekik as an A2A agent (PROTOCOL.md §14). The Agent Card and the JSON-RPC
// surface are pinned by conformance/a2a/rpc.json (shared with .NET); the task
// mapping — a turn as a task, a pause as input-required and its resume, cancel,
// history, errors — is driven through a real app here.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { channel, END, graph, InMemoryCheckpointer, START } from "@ilmek/core";

import { mekik } from "../src/index.ts";
import { answersFor, MekikA2aServer, parseMessage, type A2aMessage, type A2aServerOptions, type A2aTask } from "../src/a2a.ts";
import { canonicalize } from "../src/protocol.ts";

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../conformance/a2a/rpc.json"), "utf8")) as {
    options: A2aServerOptions;
    agentCard: unknown;
    replyArtifact: Record<string, boolean>;
    cases: Array<{ name: string; request: unknown; response: unknown }>;
};

const desk = graph("desk")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("agent", async (s, ctx) => {
        if (s.input === "boom") throw new Error("kaboom");
        const order = await mekik.tool(ctx, "get_order", { id: "ORD-42" }, () => ({ id: "ORD-42", total: 249.9 }));
        if (s.input.startsWith("refund")) {
            const ok = await mekik.choose(ctx, { title: `Refund ${order.total}?` }, [mekik.action("Approve", { approved: true }), "Cancel"]);
            return { reply: typeof ok === "object" && ok.approved ? "Refunded." : "Cancelled." };
        }
        return { reply: `Order ${order.id} totals ${order.total}.` };
    })
    .edge(START, "agent")
    .edge("agent", END)
    .compile();

const app = () => mekik({ graph: desk, checkpointer: new InMemoryCheckpointer(), reply: (s) => s.reply as string });

/** Two nodes pause in the same superstep — two concurrent interrupts on one task. */
const pair = graph("pair")
    .channel("input", channel.lastWrite<string>(""))
    .channel("log", channel.append<string>())
    .node("a", async (_s, ctx) => ({ log: [await mekik.approve<string>(ctx, { q: "first?" })] }))
    .node("b", async (_s, ctx) => ({ log: [await mekik.approve<string>(ctx, { q: "second?" })] }))
    .edge(START, "a")
    .edge(START, "b")
    .edge("a", END)
    .edge("b", END)
    .compile();
const pairApp = () => mekik({ graph: pair, checkpointer: new InMemoryCheckpointer(), reply: (s) => (s.log as string[]).join("+") });

let seq = 0;
const agent = (a = app(), extra: Partial<A2aServerOptions> = {}) =>
    new MekikA2aServer(a, { ...fixture.options, now: () => 1750000000000, mintId: (kind) => `${kind}-${++seq}`, ...extra });

const userMessage = (text: string, extra: Partial<A2aMessage> = {}): Record<string, unknown> => ({
    role: "user",
    messageId: `m-${++seq}`,
    parts: [{ kind: "text", text }],
    ...extra,
});

describe("Agent Card and JSON-RPC surface (conformance/a2a/rpc.json)", () => {
    test("the agent card", () => {
        assert.equal(canonicalize(agent().agentCard()), canonicalize(fixture.agentCard));
    });
    for (const c of fixture.cases) {
        test(c.name, async () => {
            assert.equal(canonicalize(await agent().handle(c.request)), canonicalize(c.response));
        });
    }
    test("the constructor validates name and url", () => {
        assert.throws(() => new MekikA2aServer(app(), { name: "", url: "http://x" }), /needs a name/);
        assert.throws(() => new MekikA2aServer(app(), { name: "x", url: "" }), /needs the url/);
    });
});

describe("message/send (§14.2)", () => {
    test("a finished turn is a completed task with the reply as an artifact", async () => {
        const task = await agent().sendMessage({ message: userMessage("where is my order?") });
        assert.equal(task.kind, "task");
        assert.equal(task.status.state, "completed");
        assert.equal(task.status.timestamp, "2025-06-15T15:06:40.000Z");
        assert.equal(task.status.message, undefined);
        assert.match(task.contextId, /^conv-/);
        assert.deepEqual(task.artifacts, [{ artifactId: task.artifacts![0]!.artifactId, name: "reply", parts: [{ kind: "text", text: "Order ORD-42 totals 249.9." }] }]);
        assert.equal(task.history!.length, 1, "the user's message");
        assert.equal(task.history![0]!.taskId, task.id);
        assert.equal(task.history![0]!.contextId, task.contextId);
        const meta = task.metadata!.mekik as { status: string; toolCalls: Array<{ name: string }> };
        assert.equal(meta.status, "finished");
        assert.deepEqual(meta.toolCalls.map((t) => t.name), ["get_order"]);
    });

    test("contextId continues the conversation; each turn is its own task", async () => {
        const a = agent();
        const first = await a.sendMessage({ message: userMessage("hi") });
        const second = await a.sendMessage({ message: userMessage("again", { contextId: first.contextId }) });
        assert.equal(second.contextId, first.contextId);
        assert.notEqual(second.id, first.id);
    });

    test("a paused turn is input-required with the pending interrupts; a text reply on the task resumes it", async () => {
        const a = agent();
        const paused = await a.sendMessage({ message: userMessage("refund please") });
        assert.equal(paused.status.state, "input-required");
        const status = paused.status.message!;
        assert.equal(status.role, "agent");
        assert.equal(status.taskId, paused.id);
        assert.match((status.parts[0] as { text: string }).text, /needs input before it can continue/);
        assert.match((status.parts[0] as { text: string }).text, /options: Approve, Cancel/);
        const data = (status.parts[1] as unknown as { data: { pending: Array<{ id: string }> } }).data;
        assert.equal(data.pending.length, 1);
        assert.deepEqual(paused.metadata!.pending, data.pending);

        const done = await a.sendMessage({ message: userMessage("Approve", { taskId: paused.id }) });
        assert.equal(done.id, paused.id);
        assert.equal(done.status.state, "completed");
        assert.deepEqual(done.artifacts!.at(-1)!.parts[0], { kind: "text", text: "Refunded." });
        assert.equal(done.history!.length, 3, "user, agent status, user answer");
        assert.equal(done.metadata!.pending, undefined);
    });

    test("a data part with answers resolves several open interrupts at once; text alone is refused", async () => {
        const a = agent(pairApp());
        const paused = await a.sendMessage({ message: userMessage("two please") });
        assert.equal(paused.status.state, "input-required");
        const pending = paused.metadata!.pending as Array<{ id: string }>;
        assert.equal(pending.length, 2);

        await assert.rejects(a.sendMessage({ message: userMessage("yes", { taskId: paused.id }) }), /2 open interrupts; answer them all/);

        const done = await a.sendMessage({
            message: { role: "user", taskId: paused.id, parts: [{ kind: "data", data: { answers: { [pending[0]!.id]: "A", [pending[1]!.id]: "B" } } }] },
        });
        assert.equal(done.status.state, "completed");
        assert.match((done.artifacts!.at(-1)!.parts[0] as { text: string }).text, /^(A\+B|B\+A)$/);
    });

    test("a message on a completed task is refused", async () => {
        const a = agent();
        const done = await a.sendMessage({ message: userMessage("hi") });
        await assert.rejects(a.sendMessage({ message: userMessage("more", { taskId: done.id }) }), /is completed and takes no more input/);
    });

    test("a graph error is a failed task; a turn on a parked conversation is rejected", async () => {
        const a = agent();
        const failed = await a.sendMessage({ message: userMessage("boom") });
        assert.equal(failed.status.state, "failed");
        assert.match((failed.status.message!.parts[0] as { text: string }).text, /agent: kaboom/);

        const paused = await a.sendMessage({ message: userMessage("refund please") });
        const rejected = await a.sendMessage({ message: userMessage("hello?", { contextId: paused.contextId }) });
        assert.equal(rejected.status.state, "rejected");
        assert.match((rejected.status.message!.parts[0] as { text: string }).text, /^interrupted: answer the open interrupt/);
    });

    test("only the states the fixture's replyArtifact allows attach the reply artifact", async () => {
        const a = agent();
        const completed = await a.sendMessage({ message: userMessage("hi") });
        const failed = await a.sendMessage({ message: userMessage("boom") });
        const paused = await a.sendMessage({ message: userMessage("refund please") });
        const rejected = await a.sendMessage({ message: userMessage("hello?", { contextId: paused.contextId }) });

        for (const task of [completed, failed, rejected]) {
            const replies = (task.artifacts ?? []).filter((x) => x.name === "reply");
            assert.equal(replies.length > 0, fixture.replyArtifact[task.status.state], `${task.status.state} task`);
        }
        assert.deepEqual(failed.artifacts, [], "the error text is the status message, not an artifact");
        assert.deepEqual(rejected.artifacts, []);
    });
});

describe("tasks/get and tasks/cancel (§14.4)", () => {
    test("get returns the task; historyLength truncates", async () => {
        const a = agent();
        const paused = await a.sendMessage({ message: userMessage("refund please") });
        const done = await a.sendMessage({ message: userMessage("Cancel", { taskId: paused.id }) });
        const got = await a.getTask(done.id);
        assert.equal(got.history!.length, 3);
        assert.equal((await a.getTask(done.id, 1)).history!.length, 1);
        assert.equal((await a.getTask(done.id, 0)).history!.length, 0);
        const viaRpc = await a.handle({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: done.id, historyLength: 2 } });
        assert.equal((viaRpc!.result as A2aTask).history!.length, 2);
    });

    test("cancel marks an input-required task canceled and refuses a completed one", async () => {
        const a = agent();
        const paused = await a.sendMessage({ message: userMessage("refund please") });
        const canceled = await a.cancelTask(paused.id);
        assert.equal(canceled.status.state, "canceled");
        assert.equal((await a.getTask(paused.id)).status.state, "canceled");
        const done = await a.sendMessage({ message: userMessage("hi") });
        const err = await a.handle({ jsonrpc: "2.0", id: 1, method: "tasks/cancel", params: { id: done.id } });
        assert.equal(err!.error!.code, -32002);
    });
});

describe("pure helpers", () => {
    test("parseMessage validates and mints a messageId when absent", () => {
        const m = parseMessage({ role: "user", parts: [{ kind: "text", text: "hi" }, { kind: "data", data: { a: 1 } }] });
        assert.match(m.messageId, /^message-/);
        assert.equal(m.parts.length, 2);
        assert.throws(() => parseMessage({ role: "bot", parts: [{ kind: "text", text: "x" }] }), /role/);
        assert.throws(() => parseMessage({ role: "user", parts: [{ kind: "audio" }] }), /text, data or file part/);
        assert.throws(() => parseMessage({ role: "user", parts: [{ kind: "text", text: "x" }], taskId: 5 }), /taskId/);
    });

    test("answersFor: label match → action value, text → text, data → data, explicit answers win", () => {
        const pending = [{ id: "p1", payload: {}, actions: [{ label: "Approve", value: { approved: true } }, { label: "Cancel" }] }];
        const msg = (parts: A2aMessage["parts"]): A2aMessage => ({ kind: "message", messageId: "m", role: "user", parts });
        assert.deepEqual(answersFor(msg([{ kind: "text", text: "Approve" }]), pending), { p1: { approved: true } });
        assert.deepEqual(answersFor(msg([{ kind: "text", text: "Cancel" }]), pending), { p1: "Cancel" });
        assert.deepEqual(answersFor(msg([{ kind: "text", text: "maybe later" }]), pending), { p1: "maybe later" });
        assert.deepEqual(answersFor(msg([{ kind: "data", data: { approved: false } }]), pending), { p1: { approved: false } });
        assert.deepEqual(answersFor(msg([{ kind: "data", data: { answers: { p1: 1, p2: 2 } } }]), pending), { p1: 1, p2: 2 });
        assert.throws(() => answersFor(msg([{ kind: "text", text: "x" }]), []), /no open interrupt/);
        assert.throws(() => answersFor(msg([{ kind: "file", file: {} }]), pending), /needs a text or data part/);
    });
});
