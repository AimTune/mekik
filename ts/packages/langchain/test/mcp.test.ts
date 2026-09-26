// withMcpTools (PROTOCOL.md §13): an MCP toolbox's tools as LangChain tools with
// the mekik treatment. The toolbox is a stub with @ilmek/mcp's shape; the
// assertions are about the wire — the tool_call trace, exactly-once across a
// pause, approval — and the observation the model reads.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { channel, END, graph, InMemoryCheckpointer, START } from "@ilmek/core";

import { mekik } from "@mekik/core";
import type { Connection, OutgoingFrame } from "@mekik/core";

import { withMcpTools, type McpToolboxLike } from "../src/index.ts";

class FakeConn implements Connection {
    readonly id = "c-1";
    readonly sent: OutgoingFrame[] = [];
    send(f: OutgoingFrame): void {
        this.sent.push(f);
    }
    close(): void {}
}

type ToolFrame = Extract<OutgoingFrame, { type: "tool_call" }>;
const toolCalls = (c: FakeConn, name: string): ToolFrame[] =>
    c.sent.filter((f): f is ToolFrame => f.type === "tool_call" && f.data.name === name);

function stubToolbox() {
    const invocations: Array<{ name: string; args: Record<string, unknown> }> = [];
    const toolbox: McpToolboxLike = {
        name: "github",
        tools: () => [
            { name: "github__search", description: "Search repositories.", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
            { name: "github__delete_repo", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
            { name: "github__broken", inputSchema: { type: "object" } },
            { name: "github__structured", inputSchema: { type: "object" } },
        ],
        invoke: async (name, args) => {
            invocations.push({ name, args });
            switch (name) {
                case "github__search":
                    return { text: `hits for ${String(args.q)}`, isError: false };
                case "github__delete_repo":
                    return { text: "deleted", isError: false };
                case "github__broken":
                    return { text: "permission denied", isError: true };
                default:
                    return { text: "", structured: { count: 3 }, isError: false };
            }
        },
    };
    return { toolbox, invocations };
}

function makeApp(body: (ctx: any) => Promise<string>) {
    const g = graph("agent")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("agent", async (_s, ctx) => ({ reply: await body(ctx) }))
        .edge(START, "agent")
        .edge("agent", END)
        .compile();
    return mekik({ graph: g, checkpointer: new InMemoryCheckpointer(), reply: (s) => s.reply as string });
}

describe("withMcpTools", () => {
    test("keeps names, descriptions and schemas; a missing description gets a default", async () => {
        const { toolbox } = stubToolbox();
        let seen: Array<[string, string]> = [];
        const app = makeApp(async (ctx) => {
            seen = withMcpTools(ctx, toolbox).map((t) => [t.name, t.description]);
            return "ok";
        });
        const c = new FakeConn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "go" } });
        assert.deepEqual(seen[0], ["github__search", "Search repositories."]);
        assert.deepEqual(seen[1], ["github__delete_repo", "The github__delete_repo tool of MCP server github."]);
    });

    test("a call is traced, journaled once across a pause, and reads as the result text", async () => {
        const { toolbox, invocations } = stubToolbox();
        const app = makeApp(async (ctx) => {
            const [search] = withMcpTools(ctx, toolbox);
            const out = await search!.invoke({ q: "ilmek" } as never);
            await mekik.approve(ctx, { title: "continue?" });
            return String(out);
        });
        const c = new FakeConn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "go" } });
        const interrupt = c.sent.find((f) => f.type === "interrupt") as Extract<OutgoingFrame, { type: "interrupt" }>;
        await app.receive(c, { type: "resume", answers: { [interrupt.id]: "yes" } });

        assert.equal(invocations.length, 1, "the remote tool ran once, not again on the resume pass");
        assert.deepEqual(toolCalls(c, "github__search").map((f) => f.data.status), ["running", "completed", "running", "completed"]);
        assert.equal(new Set(toolCalls(c, "github__search").map((f) => f.data.id)).size, 1, "the replay re-traces the same id");
        const reply = c.sent.filter((f) => f.type === "text" && (f as { from?: string }).from === "bot").at(-1) as { data: { text: string } };
        assert.equal(reply.data.text, "hits for ilmek");
    });

    test("isError results and structured-only results become readable observations", async () => {
        const { toolbox } = stubToolbox();
        let broken = "";
        let structured = "";
        const app = makeApp(async (ctx) => {
            const tools = withMcpTools(ctx, toolbox);
            broken = String(await tools.find((t) => t.name === "github__broken")!.invoke({} as never));
            structured = String(await tools.find((t) => t.name === "github__structured")!.invoke({} as never));
            return "ok";
        });
        const c = new FakeConn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "go" } });
        assert.equal(broken, "Error from github__broken: permission denied");
        assert.equal(structured, '{"count":3}');
    });

    test("the policy map applies by exposed name: approval gates a destructive tool", async () => {
        const { toolbox, invocations } = stubToolbox();
        const app = makeApp(async (ctx) => {
            const del = withMcpTools(ctx, toolbox, { github__delete_repo: { approve: true } }).find((t) => t.name === "github__delete_repo")!;
            return String(await del.invoke({ name: "old" } as never));
        });
        const c = new FakeConn();
        await app.connect(c);
        await app.receive(c, { type: "text", data: { text: "go" } });
        const interrupt = c.sent.find((f) => f.type === "interrupt") as Extract<OutgoingFrame, { type: "interrupt" }>;
        assert.deepEqual(interrupt.data.payload, { title: "Run github__delete_repo?", tool: "github__delete_repo", params: { name: "old" } });
        assert.equal(invocations.length, 0, "not run before approval");
        await app.receive(c, { type: "resume", answers: { [interrupt.id]: { approved: false } } });
        assert.equal(invocations.length, 0, "declined: never run");
        const reply = c.sent.filter((f) => f.type === "text" && (f as { from?: string }).from === "bot").at(-1) as { data: { text: string } };
        assert.equal(reply.data.text, "The user declined to run github__delete_repo.");
    });
});
