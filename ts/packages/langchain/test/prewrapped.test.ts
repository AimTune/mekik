// runAgent with tools mekik already wrapped — withMekikTools, withMcpTools,
// withClientTools — handed in directly. Each must pass through untouched: one
// tool_call trace per call (not two with different ids), one `lc:` journal entry
// for a server/MCP tool (none for a client tool, whose answer is the interrupt),
// and no second execution across a resume. Raw tools are still wrapped with the
// run's policy. Mirror of the .NET PrewrappedToolsTests.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { tool as lcTool, type StructuredToolInterface } from "@langchain/core/tools";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";

import { channel, END, graph, InMemoryCheckpointer, START } from "@ilmek/core";
import type { Context } from "@ilmek/core";

import { mekik } from "@mekik/core";
import type { ClientToolDefinition, Connection, OutgoingFrame } from "@mekik/core";

import {
    isMekikTool,
    runAgent,
    withClientTools,
    withMcpTools,
    withMekikTools,
    type McpToolboxLike,
} from "../src/index.ts";

class FakeConn implements Connection {
    readonly id = "c1";
    readonly sent: OutgoingFrame[] = [];
    send(f: OutgoingFrame): void {
        this.sent.push(f);
    }
    close(): void {}
}

interface Turn {
    text?: string;
    toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

function scriptedModel(turns: Turn[]): BaseChatModel {
    let i = 0;
    const bound = {
        invoke(_messages: unknown) {
            const turn = turns[i++] ?? {};
            return Promise.resolve(
                new AIMessage({
                    content: turn.text ?? "",
                    tool_calls: (turn.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args })),
                }),
            );
        },
    };
    return { bindTools: () => bound } as unknown as BaseChatModel;
}

/** One agent node; `journal` receives the node's journal keys each time it finishes. */
function makeApp(body: (ctx: Context<any>) => Promise<string>, journal: string[][], clientTools = false) {
    const g = graph("agent")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("agent", async (_s, ctx) => {
            const reply = await body(ctx);
            journal.push(ctx.journal.map(([k]) => k));
            return { reply };
        })
        .edge(START, "agent")
        .edge("agent", END)
        .compile();
    return mekik({ graph: g, checkpointer: new InMemoryCheckpointer(), reply: (s) => s.reply as string, ...(clientTools ? { clientTools: true as const } : {}) });
}

type ToolFrame = Extract<OutgoingFrame, { type: "tool_call" }>;
const traces = (c: FakeConn, name: string): ToolFrame[] =>
    c.sent.filter((f): f is ToolFrame => f.type === "tool_call" && f.data.name === name);
const lcKeys = (keys: readonly string[] | undefined, name: string): string[] =>
    (keys ?? []).filter((k) => k === `lc:${name}` || k.startsWith(`lc:${name}#`));
const botReply = (c: FakeConn): string =>
    (c.sent.filter((f) => f.type === "text" && (f as { from?: string }).from === "bot").at(-1) as { data: { text: string } }).data.text;

function mkTool(name: string, fn: (args: never) => unknown): StructuredToolInterface {
    return lcTool(fn as never, { name, description: name, schema: z.object({ id: z.string() }) as never }) as unknown as StructuredToolInterface;
}

describe("runAgent with pre-wrapped tools", () => {
    test("withMekikTools output is branded, and wrapping it again is the identity", async () => {
        const raw = mkTool("get_order", () => "x");
        let same = false;
        let branded = false;
        const app = makeApp(async (ctx) => {
            const [once] = withMekikTools(ctx, [raw]);
            const [twice] = withMekikTools(ctx, [once!]);
            same = once === twice;
            branded = isMekikTool(once) && !isMekikTool(raw);
            return "ok";
        }, []);
        const c = new FakeConn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "go" } });
        assert.ok(same, "an already-wrapped tool is passed through");
        assert.ok(branded);
        assert.deepEqual(Object.keys(raw).includes("__mekik"), false, "the brand is not an enumerable property");
    });

    test("a server tool wrapped with its own policy is traced and journaled once, and keeps that policy", async () => {
        let ran = 0;
        const getOrder = mkTool("get_order", ({ id }: { id: string }) => {
            ran++;
            return `order ${id}`;
        });
        const journal: string[][] = [];
        const model = scriptedModel([{ toolCalls: [{ id: "t1", name: "get_order", args: { id: "42" } }] }, { text: "done" }]);
        const app = makeApp(
            (ctx) =>
                runAgent(ctx, model, {
                    system: "s",
                    input: "go",
                    // Its own policy redacts `id`; the run's policy would hide it — the
                    // pre-wrapped tool keeps the policy it was wrapped with.
                    tools: withMekikTools(ctx, [getOrder], { get_order: { redact: ["id"] } }),
                    policy: { get_order: { show: false } },
                    stream: false,
                }),
            journal,
        );
        const c = new FakeConn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "go" } });

        assert.equal(ran, 1);
        assert.deepEqual(traces(c, "get_order").map((f) => f.data.status), ["running", "completed"]);
        assert.deepEqual(traces(c, "get_order")[0]!.data.params, { id: "«redacted»" });
        assert.equal(lcKeys(journal.at(-1), "get_order").length, 1, "journaled once, not twice");
    });

    test("MCP tools go to runAgent directly: one trace pair, one journal entry, no re-run on resume", async () => {
        const invocations: string[] = [];
        const toolbox: McpToolboxLike = {
            name: "github",
            tools: () => [{ name: "github__search", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
            invoke: async (name, args) => {
                invocations.push(`${name}:${String(args.q)}`);
                return { text: "3 hits", isError: false };
            },
        };
        const journal: string[][] = [];
        const model = scriptedModel([
            { toolCalls: [{ id: "t1", name: "github__search", args: { q: "ilmek" } }] },
            { toolCalls: [{ id: "t2", name: "pause", args: { id: "x" } }] },
            { text: "found 3" },
        ]);
        const pause = mkTool("pause", () => "unused");
        const app = makeApp(
            (ctx) =>
                runAgent(ctx, model, {
                    system: "s",
                    input: "go",
                    tools: [...withMcpTools(ctx, toolbox), pause],
                    policy: { pause: { approve: true } },
                    stream: false,
                }),
            journal,
        );
        const c = new FakeConn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "go" } });
        const interrupt = c.sent.find((f) => f.type === "interrupt") as Extract<OutgoingFrame, { type: "interrupt" }>;
        assert.ok(interrupt, "the raw tool is still wrapped with the run's approval policy");
        await app.receive(c, { type: "resume", answers: { [interrupt.id]: { approved: false } } });

        assert.deepEqual(invocations, ["github__search:ilmek"], "ran once across the resume");
        const search = traces(c, "github__search");
        assert.equal(new Set(search.map((f) => f.data.id)).size, 1, "one trace id, not one per wrapper");
        assert.deepEqual(search.map((f) => f.data.status), ["running", "completed", "running", "completed"], "one pair per pass");
        assert.equal(lcKeys(journal.at(-1), "github__search").length, 1);
        assert.equal(botReply(c), "found 3");
    });

    test("client tools go to runAgent directly: traced once, never journaled under lc:, answered by the resume", async () => {
        const TOOLS: ClientToolDefinition[] = [
            { name: "pick_date", parameters: { type: "object", properties: { min: { type: "string" } } } },
        ];
        const journal: string[][] = [];
        const model = scriptedModel([{ toolCalls: [{ id: "t1", name: "pick_date", args: { min: "2026-08-01" } }] }, { text: "booked" }]);
        const app = makeApp(
            (ctx) => runAgent(ctx, model, { system: "s", input: "go", tools: withClientTools(ctx), stream: false }),
            journal,
            true,
        );
        const c = new FakeConn();
        await app.connect(c, { hello: { tools: TOOLS } });
        await app.receive(c, { type: "text", data: { text: "go" } });
        const interrupts = c.sent.filter((f) => f.type === "interrupt") as Extract<OutgoingFrame, { type: "interrupt" }>[];
        assert.equal(interrupts.length, 1);
        assert.deepEqual(interrupts[0]!.data.tool, { name: "pick_date", params: { min: "2026-08-01" } });
        await app.receive(c, { type: "resume", answers: { [interrupts[0]!.id]: { ok: true, result: "2026-08-15" } } });

        assert.equal(new Set(traces(c, "pick_date").map((f) => f.data.id)).size, 1, "one trace id, not one per wrapper");
        assert.deepEqual(lcKeys(journal.at(-1), "pick_date"), [], "not wrapped in a second journaled step");
        assert.equal(botReply(c), "booked");
    });
});
