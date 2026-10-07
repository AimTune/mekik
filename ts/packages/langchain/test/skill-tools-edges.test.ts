// runAgent `skillTools` at the edges skill-tools.test.ts leaves open, plus the agent
// loop's handling of a tool call that fails: a skill the catalog does not know, a
// skill the node's filter hides (and an explicit attempt to load it), a skill that
// is listed but cannot be loaded, loading the same skill twice, unlocking two
// skills in one round, the offered set across two interrupt/resume cycles, and tool
// calls whose arguments fail the schema or whose tool throws. Mirror of the .NET
// SkillToolsEdgeTests.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { tool as lcTool, type StructuredToolInterface } from "@langchain/core/tools";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";

import { channel, END, graph, InMemoryCheckpointer, START } from "@ilmek/core";
import { mekik } from "@mekik/core";
import type { Connection, OutgoingFrame, SkillEntry, SkillSource } from "@mekik/core";

import { runAgent, type ToolPolicyMap } from "../src/index.ts";

class FakeConn implements Connection {
    readonly id = "ste-1";
    readonly sent: OutgoingFrame[] = [];
    send(f: OutgoingFrame): void {
        this.sent.push(f);
    }
    close(): void {}
}

type Call = { id: string; name: string; args: Record<string, unknown> };

/** A scripted model recording the tools offered on each call and every observation it was shown. */
function scriptedModel(turns: Array<{ text?: string; toolCalls?: Call[] }>) {
    let i = 0;
    const offered: string[][] = [];
    let observations: string[] = [];
    const model = {
        bindTools(tools: StructuredToolInterface[]) {
            const names = tools.map((t) => t.name);
            return {
                invoke(messages: unknown[]) {
                    offered.push(names);
                    observations = messages.filter((m) => m instanceof ToolMessage).map((m) => String((m as ToolMessage).content));
                    const turn = turns[i++] ?? {};
                    return Promise.resolve(new AIMessage({ content: turn.text ?? "", tool_calls: turn.toolCalls ?? [] }));
                },
            };
        },
    } as unknown as BaseChatModel;
    return { model, offered, observations: () => observations };
}

const REPORTING: SkillEntry = { name: "reporting", description: "Sprint numbers.", instructions: "Use the sprint tools." };
const BILLING: SkillEntry = { name: "billing", description: "Refunds.", instructions: "Refund carefully." };
const DOCS: SkillEntry = { name: "docs", description: "Docs.", instructions: "Read docs.", tags: ["docs"] };

const counts = { sprint: 0, refund: 0, lookup: 0 };
const reset = () => Object.assign(counts, { sprint: 0, refund: 0, lookup: 0 });
const mk = (name: string, fn: (a: any) => Promise<string>, schema: z.ZodTypeAny = z.object({})) =>
    lcTool(fn as never, { name, description: name, schema: schema as never }) as unknown as StructuredToolInterface;
const sprint = mk("get_sprint", async () => (counts.sprint++, "velocity 42"));
const refund = mk("refund", async () => (counts.refund++, "refunded"));
const lookup = mk("lookup_order", async ({ id }: { id: string }) => (counts.lookup++, `order ${id}`), z.object({ id: z.string() }));
const explode = mk("explode", async () => {
    throw new Error("upstream down");
});

function makeApp(
    model: BaseChatModel,
    opts: {
        tools?: StructuredToolInterface[];
        skillTools?: Record<string, StructuredToolInterface[]>;
        tags?: string[];
        policy?: ToolPolicyMap;
        catalog?: SkillEntry[] | SkillSource;
    } = {},
) {
    const g = graph("agent")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("agent", async (state, ctx) => ({
            reply: await runAgent(ctx, model, {
                system: "test",
                input: state.input as string,
                tools: opts.tools ?? [],
                stream: false,
                skills: opts.tags ? { tags: opts.tags } : true,
                ...(opts.skillTools ? { skillTools: opts.skillTools } : {}),
                ...(opts.policy ? { policy: opts.policy } : {}),
            }),
        }))
        .edge(START, "agent")
        .edge("agent", END)
        .compile();
    return mekik({
        graph: g,
        checkpointer: new InMemoryCheckpointer(),
        reply: (s) => s.reply as string,
        skills: opts.catalog ?? [REPORTING, BILLING, DOCS],
    });
}

async function run(app: ReturnType<typeof makeApp>) {
    const c = new FakeConn();
    await app.connect(c);
    await app.receive(c, { type: "text", data: { text: "go" } });
    return c;
}
const runs = (c: FakeConn) => c.sent.filter((f) => f.type === "run").map((f) => (f as { data: { status: string } }).data.status);
const traces = (c: FakeConn, name: string) =>
    c.sent.filter((f) => f.type === "tool_call" && (f as { data: { name: string } }).data.name === name).map((f) => (f as { data: { status: string; error?: string } }).data);
const load = (id: string, name: string): Call => ({ id, name: "load_skill", args: { name } });
const call = (id: string, name: string, args: Record<string, unknown> = {}): Call => ({ id, name, args });

describe("skillTools edges", () => {
    test("tools held under a skill the catalog does not know are never offered nor run", async () => {
        reset();
        const m = scriptedModel([{ toolCalls: [load("1", "ghost")] }, { toolCalls: [call("2", "get_sprint")] }, { text: "done" }]);
        const c = await run(makeApp(m.model, { skillTools: { ghost: [sprint] } }));
        for (const names of m.offered) assert.ok(!names.includes("get_sprint"), names.join(","));
        assert.equal(counts.sprint, 0);
        assert.ok(m.observations().some((o) => o.startsWith('Unknown skill "ghost"')));
        assert.ok(m.observations().includes("Unknown tool get_sprint."));
        assert.deepEqual(runs(c), ["started", "finished"]);
    });

    test("a skill the filter hides: an explicit load is refused and its tool stays unknown", async () => {
        reset();
        const m = scriptedModel([{ toolCalls: [load("1", "docs"), call("2", "get_sprint")] }, { text: "done" }]);
        const c = await run(makeApp(m.model, { skillTools: { docs: [sprint] }, tags: ["ops"] }));
        assert.equal(counts.sprint, 0);
        const [loadObs, callObs] = m.observations();
        assert.match(loadObs!, /^Unknown skill "docs"/);
        assert.equal(callObs, "Unknown tool get_sprint.");
        for (const names of m.offered) assert.ok(!names.includes("get_sprint"));
        assert.equal(c.sent.filter((f) => f.type === "skill").length, 0, "nothing was loaded");
    });

    test("a skill that is listed but cannot be loaded does not unlock its tools", async () => {
        reset();
        const broken: SkillSource = {
            list: () => [{ name: "reporting", description: "Sprint numbers." }],
            get: () => undefined,
        };
        const m = scriptedModel([{ toolCalls: [load("1", "reporting")] }, { toolCalls: [call("2", "get_sprint")] }, { text: "done" }]);
        await run(makeApp(m.model, { skillTools: { reporting: [sprint] }, catalog: broken }));
        assert.ok(!m.offered[1]!.includes("get_sprint"), "a failed load offers nothing new");
        assert.equal(counts.sprint, 0, "and a call is still refused as locked");
        assert.ok(m.observations().some((o) => o.includes('belongs to skill "reporting"')));
    });

    test("loading the same skill twice offers each tool once and does not rebind", async () => {
        reset();
        const m = scriptedModel([
            { toolCalls: [load("1", "reporting")] },
            { toolCalls: [load("2", "reporting")] },
            { toolCalls: [call("3", "get_sprint")] },
            { text: "done" },
        ]);
        await run(makeApp(m.model, { skillTools: { reporting: [sprint] } }));
        for (const names of m.offered.slice(1)) assert.equal(names.filter((n) => n === "get_sprint").length, 1, names.join(","));
        assert.deepEqual(m.offered[1], m.offered[2]);
        assert.equal(counts.sprint, 1);
    });

    test("two skills unlocked in one round are both offered next round, a shared tool once", async () => {
        reset();
        const m = scriptedModel([
            { toolCalls: [load("1", "reporting"), load("2", "billing")] },
            { toolCalls: [call("3", "get_sprint"), call("4", "refund")] },
            { text: "done" },
        ]);
        await run(makeApp(m.model, { skillTools: { reporting: [sprint, refund], billing: [refund] } }));
        assert.ok(!m.offered[0]!.includes("get_sprint") && !m.offered[0]!.includes("refund"));
        assert.deepEqual(m.offered[1]!.filter((n) => n === "get_sprint" || n === "refund").sort(), ["get_sprint", "refund"]);
        assert.deepEqual(counts, { sprint: 1, refund: 1, lookup: 0 });
    });

    test("the offered set is rebuilt identically across two interrupt/resume cycles", async () => {
        reset();
        const m = scriptedModel([
            { toolCalls: [load("1", "reporting")] },
            { toolCalls: [call("2", "get_sprint")] },
            { toolCalls: [load("3", "billing")] },
            { toolCalls: [call("4", "refund")] },
            { text: "done" },
        ]);
        const app = makeApp(m.model, {
            skillTools: { reporting: [sprint], billing: [refund] },
            policy: { get_sprint: { approve: {} }, refund: { approve: {} } },
        });
        const c = await run(app);
        const first = c.sent.find((f) => f.type === "interrupt") as { id: string };
        await app.receive(c, { type: "resume", answers: { [first.id]: { approved: true } } });
        const second = c.sent.filter((f) => f.type === "interrupt")[1] as { id: string };
        assert.ok(second && second.id !== first.id, "a second pause");
        await app.receive(c, { type: "resume", answers: { [second.id]: { approved: true } } });

        assert.deepEqual(counts, { sprint: 1, refund: 1, lookup: 0 }, "each held tool ran exactly once");
        assert.deepEqual(runs(c), ["started", "interrupted", "started", "interrupted", "started", "finished"]);
        assert.equal(m.offered.length, 5, "every recorded decision replayed, one live model call per round");
        assert.ok(m.offered[4]!.includes("get_sprint") && m.offered[4]!.includes("refund"));
        assert.ok(!m.observations().some((o) => o.includes("belongs to skill")), "nothing was refused as locked on a replay");
    });
});

describe("tool calls that fail come back as observations", () => {
    test("arguments that fail the tool's schema: not run, an error trace, and the loop continues", async () => {
        reset();
        const m = scriptedModel([{ toolCalls: [call("1", "lookup_order", { id: 42 })] }, { toolCalls: [call("2", "lookup_order", { id: "A-1" })] }, { text: "done" }]);
        const c = await run(makeApp(m.model, { tools: [lookup] }));
        assert.deepEqual(runs(c), ["started", "finished"], "the run did not crash");
        assert.equal(counts.lookup, 1, "only the valid call ran");
        const [bad, good] = m.observations();
        assert.match(bad!, /^Error from lookup_order: /);
        assert.equal(good, "order A-1");
        assert.deepEqual(traces(c, "lookup_order").map((t) => t.status), ["running", "error", "running", "completed"]);
    });

    test("a tool that throws: an error trace and an observation, not a crashed run", async () => {
        reset();
        const m = scriptedModel([{ toolCalls: [call("1", "explode")] }, { text: "sorry" }]);
        const c = await run(makeApp(m.model, { tools: [explode] }));
        assert.deepEqual(runs(c), ["started", "finished"]);
        assert.deepEqual(m.observations(), ["Error from explode: upstream down"]);
        assert.deepEqual(traces(c, "explode").map((t) => t.status), ["running", "error"]);
    });

    test("an approval interrupt still parks the run — only real failures are swallowed", async () => {
        reset();
        const m = scriptedModel([{ toolCalls: [call("1", "refund")] }, { text: "done" }]);
        const c = await run(makeApp(m.model, { tools: [refund], policy: { refund: { approve: {} } } }));
        assert.deepEqual(runs(c), ["started", "interrupted"]);
    });
});
