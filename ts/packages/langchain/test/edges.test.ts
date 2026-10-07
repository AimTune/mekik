// @mekik/langchain at its edges: the observability-only callback handler, the
// approval answer forms clients actually send, the agent loop's corners
// (unknown tool, empty answer, turn budget, non-streaming, skills without a
// system prompt, array content), route normalization, and a skill source whose
// listing and lookup disagree. Asserted on frames and on what the model is told.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { tool as lcTool, type StructuredToolInterface } from "@langchain/core/tools";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";
import { channel, END, graph, InMemoryCheckpointer, START, type Context } from "@ilmek/core";

import { mekik } from "@mekik/core";
import type { Connection, OutgoingFrame } from "@mekik/core";

import { LOAD_SKILL_TOOL, mekikCallbacks, REDACTED, route, runAgent, withMekikTools, withSkills } from "../src/index.ts";

class FakeConn implements Connection {
    readonly id: string;
    readonly sent: OutgoingFrame[] = [];
    constructor(id = "lc-edge") {
        this.id = id;
    }
    send(f: OutgoingFrame): void {
        this.sent.push(f);
    }
    close(): void {}
}
type ToolFrame = Extract<OutgoingFrame, { type: "tool_call" }>;
const traces = (c: FakeConn) => c.sent.filter((f): f is ToolFrame => f.type === "tool_call").map((f) => f.data);
const botTexts = (c: FakeConn) =>
    c.sent.filter((f) => f.type === "text" && (f as { from?: string }).from === "bot").map((f) => (f as { data: { text: string } }).data.text);

/** One node that runs `body` and replies with its result. */
async function runNode(body: (ctx: Context<any>, input: string) => Promise<string> | string, input = "go", extra: Record<string, unknown> = {}) {
    const g = graph("edge")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("n", async (s, ctx) => ({ reply: await body(ctx, s.input) }))
        .edge(START, "n")
        .edge("n", END)
        .compile();
    const app = mekik({ graph: g, checkpointer: new InMemoryCheckpointer(), reply: (s) => s.reply as string, ...extra });
    const c = new FakeConn();
    await app.connect(c);
    await app.receive(c, { type: "text", data: { text: input } });
    return { app, c };
}

function mkTool(name: string, fn: (input: any) => Promise<unknown>, schema: z.ZodTypeAny = z.object({})): StructuredToolInterface {
    return lcTool(fn as never, { name, description: name, schema: schema as never }) as unknown as StructuredToolInterface;
}

interface Turn {
    content?: unknown;
    toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}
/** A non-streaming scripted model that also records what it was shown. */
function scripted(turns: Turn[]) {
    const seen: BaseMessage[][] = [];
    let i = 0;
    const invoke = (messages: BaseMessage[]) => {
        seen.push([...messages]);
        const t = turns[i++] ?? {};
        return Promise.resolve(new AIMessage({ content: (t.content ?? "") as string, tool_calls: t.toolCalls ?? [] }));
    };
    const model = { bindTools: () => ({ invoke }), invoke } as unknown as BaseChatModel;
    return { model, seen };
}

// ── mekikCallbacks — the observability-only fallback ──────────────────────────

describe("mekikCallbacks", () => {
    test("start → end emits running → completed under one id, with JSON input parsed into params", async () => {
        const { c } = await runNode((ctx) => {
            const cb = mekikCallbacks(ctx);
            cb.handleToolStart({ name: "get_order" }, '{"id":"ORD-1"}', "run-1");
            cb.handleToolEnd({ total: 5 }, "run-1");
            return "ok";
        });
        const t = traces(c);
        assert.deepEqual(t.map((x) => x.status), ["running", "completed"]);
        assert.equal(t[0]!.id, t[1]!.id);
        assert.deepEqual(t[0]!.params, { id: "ORD-1" });
        assert.deepEqual(t[1]!.result, { total: 5 });
    });

    test("non-JSON and non-object inputs become {input}", async () => {
        const { c } = await runNode((ctx) => {
            const cb = mekikCallbacks(ctx);
            cb.handleToolStart({ name: "a" }, "plain words", "r1");
            cb.handleToolStart({ name: "b" }, "[1,2]", "r2");
            cb.handleToolStart({ name: "c" }, "42", "r3");
            return "ok";
        });
        assert.deepEqual(traces(c).map((t) => t.params), [{ input: "plain words" }, { input: [1, 2] }, { input: 42 }]);
    });

    test("the name falls back to runName, then to 'tool'", async () => {
        const { c } = await runNode((ctx) => {
            const cb = mekikCallbacks(ctx);
            cb.handleToolStart({}, "{}", "r1", undefined, undefined, undefined, "fromRunName");
            cb.handleToolStart(undefined, "{}", "r2");
            return "ok";
        });
        assert.deepEqual(traces(c).map((t) => t.name), ["fromRunName", "tool"]);
    });

    test("an error ends the trace with the message; a non-Error is stringified", async () => {
        const { c } = await runNode((ctx) => {
            const cb = mekikCallbacks(ctx);
            cb.handleToolStart({ name: "a" }, "{}", "r1");
            cb.handleToolError(new Error("timeout"), "r1");
            cb.handleToolStart({ name: "b" }, "{}", "r2");
            cb.handleToolError("bad gateway", "r2");
            return "ok";
        });
        assert.deepEqual(
            traces(c).filter((t) => t.status === "error").map((t) => t.error),
            ["timeout", "bad gateway"],
        );
    });

    test("end/error for an unknown or already-closed run id is ignored", async () => {
        const { c } = await runNode((ctx) => {
            const cb = mekikCallbacks(ctx);
            cb.handleToolEnd({}, "never-started");
            cb.handleToolError(new Error("x"), "never-started");
            cb.handleToolStart({ name: "a" }, "{}", "r1");
            cb.handleToolEnd("first", "r1");
            cb.handleToolEnd("second", "r1");
            return "ok";
        });
        assert.deepEqual(traces(c).map((t) => t.status), ["running", "completed"]);
    });

    test("show:false hides a tool entirely, including its end; redact masks params and nested results", async () => {
        const { c } = await runNode((ctx) => {
            const cb = mekikCallbacks(ctx, { secret: { show: false }, charge: { redact: ["card"] } });
            cb.handleToolStart({ name: "secret" }, "{}", "r1");
            cb.handleToolEnd("hidden", "r1");
            cb.handleToolStart({ name: "charge" }, '{"card":"4111","amount":5}', "r2");
            cb.handleToolEnd({ receipts: [{ card: "4111", ok: true }] }, "r2");
            return "ok";
        });
        const t = traces(c);
        assert.deepEqual(t.map((x) => x.name), ["charge", "charge"]);
        assert.deepEqual(t[0]!.params, { card: REDACTED, amount: 5 });
        assert.deepEqual(t[1]!.result, { receipts: [{ card: REDACTED, ok: true }] });
    });

    test("defaultPolicy applies to tools the map does not name", async () => {
        const { c } = await runNode((ctx) => {
            const cb = mekikCallbacks(ctx, {}, { defaultPolicy: { show: false } });
            cb.handleToolStart({ name: "anything" }, "{}", "r1");
            return "ok";
        });
        assert.deepEqual(traces(c), []);
    });
});

// ── approval answers ──────────────────────────────────────────────────────────

describe("approval answer forms (withMekikTools approve policy)", () => {
    const cases: Array<[unknown, boolean]> = [
        [true, true],
        [{ approved: true }, true],
        ["yes", true],
        ["  OK ", true],
        ["Approve", true],
        ["evet", true],
        ["Onay", true],
        [false, false],
        [{ approved: false }, false],
        [{ approved: "yes" }, false],
        ["no", false],
        ["", false],
        [1, false],
        [null, false],
    ];
    for (const [answer, runs] of cases) {
        test(`${JSON.stringify(answer)} ${runs ? "lets the tool run" : "keeps the tool from running"}`, async () => {
            let ran = 0;
            const refund = mkTool("refund", async () => {
                ran++;
                return "refunded";
            });
            const { app, c } = await runNode(async (ctx) => {
                const [t] = withMekikTools(ctx, [refund], { refund: { approve: {} } });
                const out = await t!.invoke({} as never);
                return typeof out === "string" ? out : JSON.stringify(out);
            });
            const intr = c.sent.find((f) => f.type === "interrupt") as Extract<OutgoingFrame, { type: "interrupt" }>;
            assert.deepEqual(intr.data.actions?.map((a) => a.label), ["Approve", "Reject"], "default chips");
            await app.receive(c, { type: "resume", answers: { [intr.id]: answer } });
            assert.equal(ran, runs ? 1 : 0);
        });
    }
});

// ── the agent loop ────────────────────────────────────────────────────────────

describe("runAgent corners", () => {
    test("a model without bindTools is refused up front", async () => {
        const { c } = await runNode((ctx) => runAgent(ctx, { invoke: async () => new AIMessage("x") } as unknown as BaseChatModel, { system: "s", input: "i" }));
        assert.match(botTexts(c)[0]!, /needs a tool-calling chat model/);
    });

    test("a call to a tool the agent does not have is answered as an observation, and the loop continues", async () => {
        const { model, seen } = scripted([{ toolCalls: [{ id: "t1", name: "nope", args: {} }] }, { content: "recovered" }]);
        const { c } = await runNode((ctx, input) => runAgent(ctx, model, { system: "s", input, stream: false }));
        assert.deepEqual(botTexts(c), ["recovered"]);
        const toolMsg = seen[1]!.at(-1)!;
        assert.equal(toolMsg.content, "Unknown tool nope.");
    });

    test("an empty final answer is the emptyReply", async () => {
        const { model } = scripted([{ content: "" }]);
        const { c } = await runNode((ctx, input) => runAgent(ctx, model, { system: "s", input, stream: false, emptyReply: "(nothing)" }));
        assert.deepEqual(botTexts(c), ["(nothing)"]);
    });

    test("running out of turns is the budgetReply", async () => {
        const echoTool = mkTool("echo", async () => "again");
        const loop = Array.from({ length: 5 }, (_, i) => ({ toolCalls: [{ id: `t${i}`, name: "echo", args: {} }] }));
        const { model } = scripted(loop);
        const { c } = await runNode((ctx, input) =>
            runAgent(ctx, model, { system: "s", input, tools: [echoTool], stream: false, maxTurns: 2, budgetReply: "out of steps" }),
        );
        assert.deepEqual(botTexts(c), ["out of steps"]);
        assert.equal(traces(c).filter((t) => t.status === "completed").length, 2, "one tool run per turn");
    });

    test("array content is read as its text parts only", async () => {
        const { model } = scripted([{ content: [{ type: "text", text: "Hello " }, { type: "image_url", image_url: "x" }, { type: "text", text: "world" }, "junk"] }]);
        const { c } = await runNode((ctx, input) => runAgent(ctx, model, { system: "s", input, stream: false }));
        assert.deepEqual(botTexts(c), ["Hello world"]);
    });

    test("skills with no system prompt: the prompt is the skills block alone, and load_skill is offered", async () => {
        const { model, seen } = scripted([{ content: "done" }]);
        await runNode((ctx, input) => runAgent(ctx, model, { system: "", input, stream: false, skills: { tags: ["docs"] } }), "go", {
            skills: [
                { name: "pdf", description: "PDFs.", instructions: "i", tags: ["docs"] },
                { name: "other", description: "Elsewhere.", instructions: "i", tags: ["ops"] },
            ],
        });
        const system = String(seen[0]![0]!.content);
        assert.ok(system.startsWith("You have the following skills"), system.slice(0, 40));
        assert.ok(system.includes("<name>pdf</name>") && !system.includes("<name>other</name>"), "the filter applies to the prompt");
    });
});

// ── withSkills against an inconsistent source ─────────────────────────────────

describe("withSkills edges", () => {
    test("a listed skill the source cannot load is an observation, not a crash; empty instructions say so", async () => {
        const source = {
            list: () => [
                { name: "ghost", description: "Listed, not loadable." },
                { name: "blank", description: "No body." },
            ],
            get: (name: string) => (name === "blank" ? { name, description: "No body.", instructions: "" } : undefined),
        };
        const { c } = await runNode(
            async (ctx) => {
                const [load] = withSkills(ctx);
                assert.equal(load!.name, LOAD_SKILL_TOOL);
                const a = await load!.invoke({ name: "ghost" } as never);
                const b = await load!.invoke({ name: "blank" } as never);
                return `${a}|${b}`;
            },
            "go",
            { skills: source },
        );
        assert.deepEqual(botTexts(c), ['Error loading skill ghost: unknown skill "ghost"|(skill blank has no instructions)']);
        const skillFrames = c.sent.filter((f) => f.type === "skill").map((f) => (f as { data: { status: string } }).data.status);
        assert.deepEqual(skillFrames, ["error", "loaded"]);
    });
});

// ── route ─────────────────────────────────────────────────────────────────────

describe("route normalization", () => {
    const pick = async (answer: string, routes: { name: string; description: string }[], fallback?: string) => {
        const { model } = scripted([{ content: answer }]);
        let picked = "";
        await runNode(async (ctx, input) => {
            picked = await route(ctx, model, routes, input, fallback ? { fallback } : {});
            return picked;
        });
        return picked;
    };

    test("case and surrounding punctuation do not matter", async () => {
        const routes = [
            { name: "billing", description: "b" },
            { name: "general", description: "g" },
        ];
        assert.equal(await pick("  Billing.\n", routes), "billing");
    });

    test("an exact answer wins over a route whose name it merely contains", async () => {
        const routes = [
            { name: "report", description: "one report" },
            { name: "reporting", description: "the reporting suite" },
        ];
        assert.equal(await pick("reporting", routes), "reporting");
        assert.equal(await pick("report", routes), "report");
    });

    test("without a fallback, an off-list answer goes to the last route", async () => {
        const routes = [
            { name: "billing", description: "b" },
            { name: "general", description: "g" },
        ];
        assert.equal(await pick("banana", routes), "general");
    });

    test("no routes is a programming error", async () => {
        const { c } = await runNode((ctx, input) => route(ctx, scripted([]).model, [], input));
        assert.match(botTexts(c)[0]!, /route needs at least one route/);
    });
});
