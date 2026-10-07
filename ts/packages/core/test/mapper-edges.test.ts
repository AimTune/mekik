// The event→frame mapper (PROTOCOL.md §4) at its edges — the paths the golden
// fixtures do not walk: chunk-id rules with explicit and mixed ids, payloads that
// look like mekik's own but are malformed, error formatting, reply selection,
// and the interrupt unwrapping of hand-built `$mekik` bags. Plus the pure
// protocol helpers the engine leans on (classification, canonical JSON, the
// in-memory history store).

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import type { IlmekEvent, Pending } from "@ilmek/core";

import { awaitedEvent, eventToFrames, interruptFrameData, TurnMapper, unwrapInterrupt, type TurnMapperDeps } from "../src/mapper.ts";
import { canonicalize, isMessageFrame, isPersistent, type GenUIFrame, type OutgoingFrame } from "../src/protocol.ts";
import { InMemoryConversationStore, InMemoryHistoryStore } from "../src/stores.ts";

function deps(over: Partial<TurnMapperDeps> = {}): TurnMapperDeps {
    let seq = 0;
    let stream = 0;
    let msg = 0;
    return { allocSeq: () => ++seq, mint: { message: () => `msg-${++msg}`, stream: () => `stream-${++stream}` }, now: () => 1, ...over };
}

const ev = (e: Record<string, unknown>) => e as unknown as IlmekEvent;
const custom = (payload: unknown) => ev({ type: "custom", payload });
const chunk = (c: Record<string, unknown>) => custom({ $mekik: "genui", chunk: c });
const token = (text: string) => custom({ type: "token", text });
const done = (state: Record<string, unknown> = {}) => ev({ type: "run_end", status: "done", state });
const errored = (errors: unknown[]) => ev({ type: "run_end", status: "error", errors });
const pending = (id: string, payload: unknown) => ({ id, key: "k", payload, ns: [], taskId: "t" }) as unknown as Pending;

const genuiIds = (frames: OutgoingFrame[]) => frames.filter((f): f is GenUIFrame => f.type === "genui").map((f) => f.chunk.id);

describe("chunk ids (§4.1, §6)", () => {
    test("an explicit id is kept verbatim and closes the open text run", () => {
        const frames = eventToFrames([token("a"), token("b"), chunk({ type: "text", content: "x", id: "fixed" }), token("c"), done()], deps());
        assert.deepEqual(genuiIds(frames), [1, 1, "fixed", 2, 3]);
    });

    test("an event chunk closes the text run like a ui chunk", () => {
        const frames = eventToFrames([token("a"), chunk({ type: "event", name: "ping" }), token("b"), done()], deps());
        assert.deepEqual(genuiIds(frames), [1, 2, 3, 4]);
    });

    test("genui text chunks without an id join the token run", () => {
        const frames = eventToFrames([token("a"), chunk({ type: "text", content: "b" }), token("c"), done()], deps());
        assert.deepEqual(genuiIds(frames), [1, 1, 1, 2]);
    });

    test("non-genui frames between tokens do not break the text run", () => {
        const tool = custom({ $mekik: "tool", call: { id: "t1", name: "x", status: "running" } });
        const frames = eventToFrames([token("a"), tool, token("b"), done()], deps());
        assert.deepEqual(genuiIds(frames), [1, 1, 2]);
    });

    test("one stream id per turn, minted lazily on the first chunk", () => {
        let streams = 0;
        const d = deps({ mint: { message: () => "m", stream: () => `s-${++streams}` } });
        const mapper = new TurnMapper(d);
        assert.deepEqual(mapper.map(ev({ type: "run_start" })), [{ type: "run", data: { status: "started" } }]);
        assert.equal(streams, 0, "no chunk yet, no stream");
        mapper.map(token("a"));
        mapper.map(chunk({ type: "ui", component: "c" }));
        assert.equal(streams, 1);
    });

    test("the closing stream_done is done:true and the only done:true chunk", () => {
        const frames = eventToFrames([token("a"), done()], deps());
        const g = frames.filter((f): f is GenUIFrame => f.type === "genui");
        assert.deepEqual(g.map((f) => f.done), [false, true]);
        assert.deepEqual(g[1]!.chunk, { type: "event", name: "stream_done", id: 2 });
    });

    test("a run with no chunks closes no stream", () => {
        const frames = eventToFrames([ev({ type: "run_start" }), done()], deps());
        assert.deepEqual(frames.map((f) => f.type), ["run", "run"]);
    });

    test("an interrupted or aborted run leaves the stream open — no stream_done", () => {
        for (const status of ["interrupted", "aborted"]) {
            const frames = eventToFrames([token("a"), ev({ type: "run_end", status })], deps());
            assert.deepEqual(genuiIds(frames), [1], status);
            assert.deepEqual(frames.at(-1), { type: "run", data: { status } });
        }
    });
});

describe("customs the mapper must not mistake for its own (§4.1)", () => {
    const dropped: Array<[string, unknown]> = [
        ["genui without a chunk", { $mekik: "genui" }],
        ["genui with a non-object chunk", { $mekik: "genui", chunk: "text" }],
        ["tool without a call", { $mekik: "tool" }],
        ["tool with an array call", { $mekik: "tool", call: [] }],
        ["skill without a use name", { $mekik: "skill", use: { id: "x", status: "loaded" } }],
        ["message without a messageType", { $mekik: "message", data: {} }],
        ["message with non-object data", { $mekik: "message", messageType: "image", data: "x" }],
        ["message naming a reserved frame type", { $mekik: "message", messageType: "run", data: {} }],
        ["message naming typing", { $mekik: "message", messageType: "typing", data: {} }],
        ["an unknown $mekik kind", { $mekik: "debug", data: 1 }],
        ["a non-object payload", "token"],
        ["null", null],
        ["an array", [{ type: "token", text: "x" }]],
    ];
    for (const [what, payload] of dropped) {
        test(`${what} → nothing`, () => {
            assert.deepEqual(new TurnMapper(deps()).map(custom(payload)), []);
        });
    }

    test("internal ilmek events surface nothing in v1", () => {
        const m = new TurnMapper(deps());
        for (const type of ["node_start", "node_end", "node_error", "node_retry", "step_start", "state", "checkpoint"]) {
            assert.deepEqual(m.map(ev({ type })), [], type);
        }
    });

    test("a `text` rich message is a regular persistent text frame, minted id unless supplied", () => {
        const m = new TurnMapper(deps());
        const [a] = m.map(custom({ $mekik: "message", messageType: "text", data: { text: "hi", urls: ["u"] } }));
        const [b] = m.map(custom({ $mekik: "message", messageType: "card", data: { title: "t" }, id: "card-9" }));
        assert.deepEqual(a, { type: "text", id: "msg-1", seq: 1, from: "bot", data: { text: "hi", urls: ["u"] }, timestamp: 1 });
        assert.equal((b as { id: string }).id, "card-9");
    });
});

describe("run_end mapping (§4.1, §4.3)", () => {
    test("error with no recorded errors says the run failed", () => {
        const frames = eventToFrames([errored([])], deps());
        assert.equal((frames[0] as { data: { text: string } }).data.text, "⚠️ the run failed");
    });

    test("several errors are joined with '; ', each prefixed by its node; non-Errors are stringified", () => {
        const frames = eventToFrames([errored([["a", new Error("one")], ["b", "two"], ["c", 3]])], deps());
        assert.equal((frames[0] as { data: { text: string } }).data.text, "⚠️ a: one; b: two; c: 3");
        assert.deepEqual(frames[1], { type: "run", data: { status: "error" } });
    });

    test("the reply selector sees the final state; a non-string or empty reply emits no text", () => {
        const seen: unknown[] = [];
        for (const r of [undefined, "", 42 as unknown as string]) {
            const frames = eventToFrames([done({ reply: "x" })], deps({ reply: (s) => (seen.push(s), r) }));
            assert.deepEqual(frames.map((f) => f.type), ["run"], String(r));
        }
        assert.deepEqual(seen[0], { reply: "x" });
    });

    test("fail() closes a run whose stream threw: the same ⚠️ text then run{error} as run_end{error}", () => {
        const m = new TurnMapper(deps());
        m.map(ev({ type: "run_start" }));
        m.map(token("partial"));
        assert.deepEqual(m.fail(new Error("exceeded 3 supersteps")), [
            { type: "text", id: "msg-1", seq: 2, from: "bot", data: { text: "⚠️ exceeded 3 supersteps" }, timestamp: 1 },
            { type: "run", data: { status: "error" } },
        ]);
        assert.equal((new TurnMapper(deps()).fail("disk full")[0] as { data: { text: string } }).data.text, "⚠️ disk full");
    });

    test("the reply comes after stream_done and before run{finished}", () => {
        const frames = eventToFrames([token("a"), done()], deps({ reply: () => "bye" }));
        assert.deepEqual(frames.map((f) => (f.type === "genui" ? `genui:${(f as GenUIFrame).done}` : f.type)), ["genui:false", "genui:true", "text", "run"]);
    });
});

describe("interrupt unwrapping (§4.2)", () => {
    test("a non-object payload passes through as the payload", () => {
        for (const p of ["approve?", 3, null, [1, 2]]) assert.deepEqual(unwrapInterrupt(p), { payload: p });
    });

    test("a $mekik that is not an object is not the envelope — the payload is left untouched", () => {
        assert.deepEqual(unwrapInterrupt({ title: "t", $mekik: "genui" }), { payload: { title: "t", $mekik: "genui" } });
    });

    test("$mekik is stripped and every other key kept", () => {
        assert.deepEqual(unwrapInterrupt({ a: 1, b: { c: 2 }, $mekik: {} }), { payload: { a: 1, b: { c: 2 } } });
    });

    test("a malformed tool (no string name) is dropped; a non-string event is dropped", () => {
        assert.deepEqual(unwrapInterrupt({ $mekik: { tool: { params: {} }, event: 7 } }), { payload: {} });
        assert.deepEqual(unwrapInterrupt({ $mekik: { tool: "pick_date" } }), { payload: {} });
    });

    test("ui, actions, event and tool all split out together", () => {
        const out = unwrapInterrupt({ x: 1, $mekik: { ui: { component: "f" }, actions: [{ label: "A" }], event: "e", tool: { name: "t" } } });
        assert.deepEqual(out, { payload: { x: 1 }, ui: { component: "f" }, actions: [{ label: "A" }], event: "e", tool: { name: "t" } });
    });

    test("awaitedEvent names the event only for onEvent pauses", () => {
        assert.equal(awaitedEvent(pending("i", { $mekik: { event: "rate" } })), "rate");
        assert.equal(awaitedEvent(pending("i", { title: "plain" })), undefined);
    });

    test("interruptFrameData omits absent fields rather than sending undefined", () => {
        const data = interruptFrameData(pending("i", { $mekik: { actions: [{ label: "ok" }] } }));
        assert.deepEqual(Object.keys(data).sort(), ["actions", "payload"]);
    });

    test("one interrupt event with several pending yields one frame per pause, in order, each with its own seq", () => {
        const frames = eventToFrames([ev({ type: "interrupt", pending: [pending("a", 1), pending("b", 2)] })], deps());
        assert.deepEqual(frames.map((f) => [f.type, (f as { id: string }).id, (f as { seq: number }).seq]), [
            ["interrupt", "a", 1],
            ["interrupt", "b", 2],
        ]);
    });
});

describe("frame classification and canonical JSON (§2, §9)", () => {
    test("persistent: the closed list plus rich messages; transient never", () => {
        const persistent: OutgoingFrame[] = [
            { type: "text", id: "m", seq: 1, from: "bot", data: { text: "" }, timestamp: 0 },
            { type: "tool_call", seq: 1, data: { id: "t", name: "n", status: "running" } },
            { type: "skill", seq: 1, data: { id: "s", name: "pdf", status: "loaded" } },
            { type: "genui", seq: 1, streamId: "s", done: false, chunk: { type: "text", content: "" } },
            { type: "interrupt", seq: 1, id: "i", data: { payload: {} } },
            { type: "interrupt_resolved", seq: 1, id: "i", data: {} },
            { type: "image", id: "m", seq: 1, from: "bot", data: {}, timestamp: 0 },
        ];
        for (const f of persistent) assert.equal(isPersistent(f), true, f.type);
        const transient: OutgoingFrame[] = [
            { type: "run", data: { status: "started" } },
            { type: "error", data: { code: "busy", message: "" } },
            { type: "skills", hash: "h" },
            { type: "genui_components", hash: "h" },
            { type: "welcome", data: { protocol: "mekik/1", conversationId: "c", userId: "u", connectionId: "x", watermark: 0, pending: [] } },
        ];
        for (const f of transient) assert.equal(isPersistent(f), false, f.type);
    });

    test("a rich message needs the text envelope: no id or no seq is not one", () => {
        assert.equal(isMessageFrame({ type: "image", seq: 1, from: "bot", data: {}, timestamp: 0 } as unknown as OutgoingFrame), false);
        assert.equal(isMessageFrame({ type: "image", id: "m", from: "bot", data: {}, timestamp: 0 } as unknown as OutgoingFrame), false);
        assert.equal(isMessageFrame({ type: "run", id: "m", seq: 1 } as unknown as OutgoingFrame), false, "a reserved type never is");
    });

    test("canonicalize sorts keys at every depth, keeps array order, drops undefined", () => {
        assert.equal(canonicalize({ b: 1, a: [{ d: undefined, c: 2 }, 1], u: undefined }), '{"a":[{"c":2},1],"b":1}');
        assert.equal(canonicalize([3, "x", null, true]), '[3,"x",null,true]');
        assert.equal(canonicalize("ş"), '"ş"');
    });
});

describe("in-memory stores (§1, §2)", () => {
    test("the history store refuses a transient frame", async () => {
        const h = new InMemoryHistoryStore();
        await assert.rejects(h.record("c", { type: "run", data: { status: "started" } } as never), /transient run frame/);
        assert.equal(await h.currentSeq("c"), 0);
    });

    test("after() filters by seq, so watermarks past the end or before the start behave", async () => {
        const h = new InMemoryHistoryStore();
        for (const seq of [1, 2, 3]) await h.record("c", { type: "interrupt_resolved", seq, id: "i", data: {} });
        assert.deepEqual((await h.after("c", 1)).map((f) => f.seq), [2, 3]);
        assert.deepEqual(await h.after("c", 3), []);
        assert.deepEqual(await h.after("c", 99), []);
        assert.deepEqual((await h.after("c", -1)).map((f) => f.seq), [1, 2, 3]);
        assert.deepEqual(await h.after("other", 0), []);
        assert.equal(await h.currentSeq("c"), 3);
    });

    test("conversations are isolated by id; an unknown id is null", async () => {
        const s = new InMemoryConversationStore();
        await s.create({ conversationId: "a", userId: "u", createdAt: 1, meta: {} });
        assert.equal((await s.get("a"))?.userId, "u");
        assert.equal(await s.get("b"), null);
    });
});
