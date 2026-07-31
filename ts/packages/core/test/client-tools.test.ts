// Client tools (PROTOCOL.md §11) — the behavioural suite. Declaration and the
// opt-in policy, the per-turn snapshot and tag filtering, and both invocation
// modes: the durable round-trip over the interrupt machinery and the
// fire-and-forget event chunk.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { channel, END, graph, START } from "@ilmek/core";

import { mekik } from "../src/index.ts";
import { clientTools } from "../src/helpers.ts";
import type { Connection } from "../src/engine.ts";
import type { ClientToolDefinition, OutgoingFrame, RunStatus } from "../src/protocol.ts";

// ── test doubles ──────────────────────────────────────────────────────────────

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

let connSeq = 0;
const conn = (): FakeConn => new FakeConn(`ct-${++connSeq}`);

const types = (c: FakeConn): string[] => c.sent.map((f) => f.type);
const first = <T extends OutgoingFrame["type"]>(c: FakeConn, t: T): Extract<OutgoingFrame, { type: T }> =>
    c.sent.find((f) => f.type === t) as Extract<OutgoingFrame, { type: T }>;
/** The latest bot text frame — multi-tab fan-out also delivers user turns, so filter by `from`. */
const lastBot = (c: FakeConn): string =>
    c.sent
        .filter((f): f is Extract<OutgoingFrame, { type: "text" }> => f.type === "text" && (f as { from?: string }).from === "bot")
        .at(-1)!.data.text;
const runStatuses = (c: FakeConn): RunStatus[] =>
    c.sent.filter((f): f is Extract<OutgoingFrame, { type: "run" }> => f.type === "run").map((f) => f.data.status);
const toolCalls = (c: FakeConn) =>
    c.sent.filter((f): f is Extract<OutgoingFrame, { type: "tool_call" }> => f.type === "tool_call").map((f) => f.data);

// ── graphs ────────────────────────────────────────────────────────────────────

/** Replies with the tool names this turn sees — the snapshot, observed. */
const introspector = graph("introspector")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("look", (s, ctx) => {
        const tags = s.input ? s.input.split(",") : undefined;
        const defs = mekik.clientTools(ctx, tags ? { tags } : {});
        // Prefixed so an empty snapshot still yields a reply frame to assert on;
        // tags are printed so a test can see WHICH definition of a name won.
        return { reply: `tools:${defs.map((d) => (d.tags?.length ? `${d.name}[${d.tags.join(",")}]` : d.name)).join("|")}` };
    })
    .edge(START, "look")
    .edge("look", END)
    .compile();

/** Calls one client tool round-trip and replies with its result. */
const caller = graph("caller")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("call", async (s, ctx) => {
        const res = await mekik.callClientTool<{ date: string }>(ctx, "pick_date", { min: s.input });
        return { reply: `picked ${res.date}` };
    })
    .edge(START, "call")
    .edge("call", END)
    .compile();

/** A journaled side effect before the client tool call — the exactly-once check. */
let lookups = 0;
const gated = graph("gated")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("call", async (s, ctx) => {
        const order = await mekik.tool(ctx, "get_order", { id: s.input }, () => {
            lookups++;
            return { id: s.input };
        });
        const res = await mekik.callClientTool<string>(ctx, "confirm_address", { orderId: order.id });
        return { reply: res };
    })
    .edge(START, "call")
    .edge("call", END)
    .compile();

/** Fires a notify tool and finishes without pausing. */
const notifier = graph("notifier")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("show", async (_s, ctx) => {
        const out = await mekik.callClientTool(ctx, "show_confetti", { level: 3 });
        return { reply: out === undefined ? "fired" : "unexpected" };
    })
    .edge(START, "show")
    .edge("show", END)
    .compile();

const PICK_DATE: ClientToolDefinition = {
    name: "pick_date",
    description: "Open the date picker",
    parameters: { type: "object", properties: { min: { type: "string" } } },
};

// ── declaration & policy (§11.1) ──────────────────────────────────────────────

describe("client tool declaration (§11.1)", () => {
    test("declarations are ignored entirely unless the app opts in", async () => {
        const app = mekik({ graph: introspector, reply: (s) => s.reply as string });
        const c = conn();
        await app.connect(c, { hello: { tools: [PICK_DATE] } });
        await app.receive(c, { type: "text", data: { text: "" } });
        assert.equal(lastBot(c), "tools:");
    });

    test("hello.tools reach ctx.meta.clientTools when the app opts in", async () => {
        const app = mekik({ graph: introspector, reply: (s) => s.reply as string, clientTools: true });
        const c = conn();
        await app.connect(c, { hello: { tools: [PICK_DATE, { name: "show_map" }] } });
        await app.receive(c, { type: "text", data: { text: "" } });
        assert.equal(lastBot(c), "tools:pick_date|show_map");
    });

    test("malformed declarations are sanitized: no name → dropped, duplicate name → last wins", async () => {
        const app = mekik({ graph: introspector, reply: (s) => s.reply as string, clientTools: true });
        const c = conn();
        await app.connect(c, {
            hello: {
                tools: [
                    { name: "" },
                    { nope: true },
                    "junk",
                    { name: "a", mode: "weird", tags: ["x", 5] },
                    { name: "a", description: "the keeper" },
                ] as unknown as ClientToolDefinition[],
            },
        });
        await app.receive(c, { type: "text", data: { text: "" } });
        assert.equal(lastBot(c), "tools:a");
    });

    test("the policy function is the allowlist: only what it returns survives", async () => {
        const app = mekik({
            graph: introspector,
            reply: (s) => s.reply as string,
            clientTools: (tools) => tools.filter((t) => t.name === "pick_date"),
        });
        const c = conn();
        await app.connect(c, { hello: { tools: [PICK_DATE, { name: "evil_tool" }] } });
        await app.receive(c, { type: "text", data: { text: "" } });
        assert.equal(lastBot(c), "tools:pick_date");
    });

    test("a client_tools frame replaces the connection's set; [] withdraws everything", async () => {
        const app = mekik({ graph: introspector, reply: (s) => s.reply as string, clientTools: true });
        const c = conn();
        await app.connect(c, { hello: { tools: [PICK_DATE] } });

        await app.receive(c, { type: "client_tools", tools: [{ name: "show_map" }] });
        await app.receive(c, { type: "text", data: { text: "" } });
        assert.equal(lastBot(c), "tools:show_map");

        await app.receive(c, { type: "client_tools", tools: [] });
        await app.receive(c, { type: "text", data: { text: "" } });
        assert.equal(lastBot(c), "tools:");
    });

    test("a client_tools frame without a tools array is a bad_request", async () => {
        const app = mekik({ graph: introspector, reply: (s) => s.reply as string, clientTools: true });
        const c = conn();
        await app.connect(c);
        await app.receive(c, { type: "client_tools" });
        assert.equal(first(c, "error").data.code, "bad_request");
    });

    test("multi-tab: the snapshot is the union; the latest declaration of a name wins", async () => {
        const app = mekik({ graph: introspector, reply: (s) => s.reply as string, clientTools: true });
        const c1 = conn();
        await app.connect(c1, { hello: { userId: "u1", tools: [{ name: "a" }, { name: "b" }] } });
        const convId = first(c1, "welcome").data.conversationId;

        const c2 = conn();
        await app.connect(c2, { hello: { userId: "u1", conversationId: convId, tools: [{ name: "a", tags: ["v2"] }, { name: "c" }] } });

        await app.receive(c1, { type: "text", data: { text: "" } });
        // Union of both tabs, deduped by name: "a" keeps its first position but
        // carries tab 2's (later) definition — the [v2] tag proves which one won.
        assert.equal(lastBot(c2), "tools:a[v2]|b|c");
    });
});

// ── tag filtering (§11.2) ─────────────────────────────────────────────────────

describe("tag filtering (§11.2)", () => {
    const stubCtx = (defs: ClientToolDefinition[]) => ({ meta: { clientTools: defs } }) as never;
    const defs: ClientToolDefinition[] = [
        { name: "everywhere" },
        { name: "billing_only", tags: ["billing"] },
        { name: "support_only", tags: ["support"] },
        { name: "both", tags: ["billing", "support"] },
        { name: "notify_me", mode: "notify" },
    ];

    test("no filter returns everything", () => {
        assert.deepEqual(clientTools(stubCtx(defs)).map((d) => d.name), ["everywhere", "billing_only", "support_only", "both", "notify_me"]);
    });

    test("a tag query returns untagged tools plus the intersecting ones", () => {
        assert.deepEqual(clientTools(stubCtx(defs), { tags: ["billing"] }).map((d) => d.name), ["everywhere", "billing_only", "both", "notify_me"]);
    });

    test("a query no tagged tool matches still returns the untagged (unrestricted) ones", () => {
        assert.deepEqual(clientTools(stubCtx(defs), { tags: ["nothing"] }).map((d) => d.name), ["everywhere", "notify_me"]);
    });

    test("mode narrows by invocation kind", () => {
        assert.deepEqual(clientTools(stubCtx(defs), { mode: "notify" }).map((d) => d.name), ["notify_me"]);
        assert.deepEqual(clientTools(stubCtx(defs), { mode: "call", tags: ["support"] }).map((d) => d.name), ["everywhere", "support_only", "both"]);
    });

    test("the engine-side snapshot honours the same filter end to end", async () => {
        const app = mekik({ graph: introspector, reply: (s) => s.reply as string, clientTools: true });
        const c = conn();
        await app.connect(c, { hello: { tools: [{ name: "general" }, { name: "map", tags: ["geo"] }, { name: "pay", tags: ["billing"] }] } });
        await app.receive(c, { type: "text", data: { text: "geo" } });
        assert.equal(lastBot(c), "tools:general|map[geo]");
    });
});

// ── the round-trip call (§11.3) ───────────────────────────────────────────────

describe("client tool round-trip (§11.3)", () => {
    test("callClientTool parks the run on an interrupt carrying data.tool, and the trace shows running", async () => {
        const app = mekik({ graph: caller, reply: (s) => s.reply as string, clientTools: true });
        const c = conn();
        await app.connect(c, { hello: { tools: [PICK_DATE] } });
        await app.receive(c, { type: "text", data: { text: "2026-08-01" } });

        assert.deepEqual(runStatuses(c), ["started", "interrupted"]);
        const intr = first(c, "interrupt");
        assert.deepEqual(intr.data.tool, { name: "pick_date", params: { min: "2026-08-01" } });
        assert.equal(intr.data.event, undefined);
        assert.equal(intr.data.actions, undefined);
        assert.deepEqual(intr.data.payload, {});
        assert.deepEqual(toolCalls(c).at(-1), {
            id: toolCalls(c).at(-1)!.id,
            name: "pick_date",
            status: "running",
            params: { min: "2026-08-01" },
        });
    });

    test("a resume with {ok:true, result} resolves the call: completed trace + reply", async () => {
        const app = mekik({ graph: caller, reply: (s) => s.reply as string, clientTools: true });
        const c = conn();
        await app.connect(c, { hello: { tools: [PICK_DATE] } });
        await app.receive(c, { type: "text", data: { text: "2026-08-01" } });
        const id = first(c, "interrupt").id;

        await app.receive(c, { type: "resume", answers: { [id]: { ok: true, result: { date: "2026-08-15" } } } });

        assert.deepEqual(runStatuses(c), ["started", "interrupted", "started", "finished"]);
        assert.equal(types(c).includes("interrupt_resolved"), true);
        const calls = toolCalls(c);
        const completed = calls.at(-1)!;
        assert.equal(completed.status, "completed");
        assert.deepEqual(completed.result, { date: "2026-08-15" });
        // The re-emitted running trace upserts: same id on every trace for this call.
        assert.equal(new Set(calls.map((t) => t.id)).size, 1);
        assert.equal(lastBot(c), "picked 2026-08-15");
    });

    test("a resume with {ok:false, error} makes the call throw — the run errors with the message", async () => {
        const app = mekik({ graph: caller, reply: (s) => s.reply as string, clientTools: true });
        const c = conn();
        await app.connect(c, { hello: { tools: [PICK_DATE] } });
        await app.receive(c, { type: "text", data: { text: "x" } });
        const id = first(c, "interrupt").id;

        await app.receive(c, { type: "resume", answers: { [id]: { ok: false, error: "user closed the picker" } } });

        assert.deepEqual(runStatuses(c), ["started", "interrupted", "started", "error"]);
        const errored = toolCalls(c).find((t) => t.status === "error");
        assert.equal(errored?.error, "user closed the picker");
    });

    test("a bare answer (no envelope) is taken as the result — a human can answer from chips", async () => {
        const app = mekik({ graph: caller, reply: (s) => s.reply as string, clientTools: true });
        const c = conn();
        await app.connect(c, { hello: { tools: [PICK_DATE] } });
        await app.receive(c, { type: "text", data: { text: "x" } });
        const id = first(c, "interrupt").id;

        await app.receive(c, { type: "resume", answers: { [id]: { date: "1999-12-31" } } });
        assert.equal(lastBot(c), "picked 1999-12-31");
    });

    test("welcome.pending re-announces an open tool call with data.tool (reconnect mid-call)", async () => {
        const app = mekik({ graph: caller, reply: (s) => s.reply as string, clientTools: true });
        const c1 = conn();
        await app.connect(c1, { hello: { userId: "u1", tools: [PICK_DATE] } });
        const convId = first(c1, "welcome").data.conversationId;
        await app.receive(c1, { type: "text", data: { text: "x" } });

        const c2 = conn();
        await app.connect(c2, { hello: { userId: "u1", conversationId: convId } });
        const pending = first(c2, "welcome").data.pending;
        assert.equal(pending.length, 1);
        assert.deepEqual(pending[0]!.data.tool, { name: "pick_date", params: { min: "x" } });
    });

    test("a journaled side effect before the call runs exactly once across the pause", async () => {
        lookups = 0;
        const app = mekik({ graph: gated, reply: (s) => s.reply as string, clientTools: true });
        const c = conn();
        await app.connect(c, { hello: { tools: [{ name: "confirm_address" }] } });
        await app.receive(c, { type: "text", data: { text: "ORD-1" } });
        const id = first(c, "interrupt").id;
        await app.receive(c, { type: "resume", answers: { [id]: { ok: true, result: "confirmed" } } });

        assert.equal(lookups, 1);
        assert.deepEqual(runStatuses(c), ["started", "interrupted", "started", "finished"]);
        assert.equal(lastBot(c), "confirmed");
        // Two distinct tools, each with one stable id across the replay.
        const ids = new Set(toolCalls(c).map((t) => t.id));
        assert.equal(ids.size, 2);
    });
});

// ── the notify mode (§11.3) ───────────────────────────────────────────────────

describe("client tool notify mode (§11.3)", () => {
    test("a notify tool streams a client_tool event chunk and never parks", async () => {
        const app = mekik({ graph: notifier, reply: (s) => s.reply as string, clientTools: true });
        const c = conn();
        await app.connect(c, { hello: { tools: [{ name: "show_confetti", mode: "notify" }] } });
        await app.receive(c, { type: "text", data: { text: "" } });

        assert.deepEqual(runStatuses(c), ["started", "finished"]);
        assert.equal(types(c).includes("interrupt"), false);

        const chunk = c.sent
            .filter((f): f is Extract<OutgoingFrame, { type: "genui" }> => f.type === "genui")
            .map((f) => f.chunk)
            .find((ch) => ch.type === "event" && ch.name === "client_tool");
        assert.ok(chunk && chunk.type === "event");
        assert.deepEqual(chunk.payload, { name: "show_confetti", params: { level: 3 } });

        const calls = toolCalls(c);
        assert.deepEqual(calls.map((t) => t.status), ["running", "completed"]);
        assert.equal(calls[0]!.id, calls[1]!.id);
        // The chunk is keyed by the trace id, so a replay pass upserts it.
        assert.equal(chunk.id, calls[0]!.id);

        assert.equal(lastBot(c), "fired");
    });
});
