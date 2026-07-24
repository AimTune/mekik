// Drives `runAgent` with a scripted model through a real ilmek graph and the real
// mekik engine, then asserts on the frames a client would receive: the tool the
// model calls runs and is traced, live text streams as one coalesced bubble, and
// the consolidated answer is the returned reply. Mirror of the .NET AgentTests.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { tool as lcTool, type StructuredToolInterface } from "@langchain/core/tools";
import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";

import { channel, END, graph, InMemoryCheckpointer, START } from "@ilmek/core";
import type { Context } from "@ilmek/core";

import { mekik } from "@mekik/core";
import type { Connection, GenUIFrame, OutgoingFrame } from "@mekik/core";

import { route, runAgent } from "../src/index.ts";

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

/** A model scripted turn by turn — one AIMessage per `invoke`, split text chunks per `stream`. */
function scriptedModel(turns: Turn[]): BaseChatModel {
    let i = 0;
    const bound = {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        invoke(_messages: unknown) {
            const turn = turns[i++] ?? {};
            return Promise.resolve(
                new AIMessage({
                    content: turn.text ?? "",
                    tool_calls: (turn.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args })),
                }),
            );
        },
        stream(_messages: unknown) {
            const turn = turns[i++] ?? {};
            const full = turn.text ?? "";
            const mid = Math.ceil(full.length / 2);
            async function* gen(): AsyncGenerator<AIMessageChunk> {
                if (full) {
                    yield new AIMessageChunk({ content: full.slice(0, mid) });
                    yield new AIMessageChunk({ content: full.slice(mid) });
                }
            }
            return Promise.resolve(gen());
        },
    };
    // `bindTools` for runAgent; a top-level `invoke` for route (which doesn't bind tools).
    return { bindTools: () => bound, invoke: bound.invoke } as unknown as BaseChatModel;
}

function makeApp(run: (input: string, ctx: Context<any>) => Promise<string>) {
    const g = graph("agent")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("agent", async (s, ctx) => ({ reply: await run(s.input, ctx) }))
        .edge(START, "agent")
        .edge("agent", END)
        .compile();
    return mekik({ graph: g, checkpointer: new InMemoryCheckpointer(), reply: (s) => s.reply as string });
}

const data = (f: OutgoingFrame): Record<string, unknown> => (f as { data?: Record<string, unknown> }).data ?? {};

/** Build a LangChain tool as a plain `StructuredToolInterface` (casts past strict zod↔schema friction). */
function mkTool(
    name: string,
    description: string,
    schema: z.ZodTypeAny,
    fn: (args: never) => unknown,
): StructuredToolInterface {
    return lcTool(fn as never, { name, description, schema: schema as never }) as unknown as StructuredToolInterface;
}

describe("runAgent", () => {
    test("runs the tool the model calls, then returns the final text", async () => {
        let ran = 0;
        const getOrder = mkTool("get_order", "Look up an order", z.object({ id: z.string() }), ({ id }: { id: string }) => {
            ran++;
            return { id, total: 249.9 };
        });

        const model = scriptedModel([
            { toolCalls: [{ id: "c1", name: "get_order", args: { id: "ORD-42" } }] },
            { text: "Your order total is 249.9." },
        ]);

        const app = makeApp((input, ctx) =>
            runAgent(ctx, model, { system: "sys", input, tools: [getOrder], stream: false }),
        );

        const c = new FakeConn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "total?" } });

        assert.equal(ran, 1);
        const statuses = c.sent
            .filter((f) => f.type === "tool_call" && data(f).name === "get_order")
            .map((f) => data(f).status);
        assert.deepEqual(statuses, ["running", "completed"]);

        const reply = c.sent.filter((f) => f.type === "text").map((f) => data(f).text).at(-1);
        assert.equal(reply, "Your order total is 249.9.");
    });

    test("streams text deltas as one growing bubble and returns the joined text", async () => {
        const model = scriptedModel([{ text: "Hello, world." }]);

        const app = makeApp((input, ctx) => runAgent(ctx, model, { system: "sys", input, tools: [] }));

        const c = new FakeConn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "hi" } });

        const textChunkIds = c.sent
            .filter((f): f is GenUIFrame => f.type === "genui")
            .map((f) => f.chunk)
            .filter((ch) => ch.type === "text")
            .map((ch) => ch.id);
        assert.ok(textChunkIds.length >= 2, "streamed in more than one delta");
        assert.equal(new Set(textChunkIds).size, 1, "all deltas share one text-run id → one bubble");

        const reply = c.sent.filter((f) => f.type === "text").map((f) => data(f).text).at(-1);
        assert.equal(reply, "Hello, world.");
    });
});

describe("route", () => {
    const ROUTES = [
        { name: "reporting", description: "sprint reports and metrics" },
        { name: "general", description: "everything else" },
    ];

    test("classifies the input into one of the routes", async () => {
        const model = scriptedModel([{ text: "reporting" }]);
        let picked = "";
        const app = makeApp(async (input, ctx) => {
            picked = await route(ctx, model, ROUTES, input);
            return picked;
        });
        const c = new FakeConn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "show me the sprint report" } });
        assert.equal(picked, "reporting");
    });

    test("falls back when the model answers off-list", async () => {
        const model = scriptedModel([{ text: "banana" }]);
        let picked = "";
        const app = makeApp(async (input, ctx) => {
            picked = await route(ctx, model, ROUTES, input, { fallback: "general" });
            return picked;
        });
        const c = new FakeConn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "??" } });
        assert.equal(picked, "general");
    });
});
