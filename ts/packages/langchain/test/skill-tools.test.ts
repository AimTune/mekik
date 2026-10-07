// runAgent `skillTools` — tools held under a skill: hidden from the model until it loads
// the skill, then offered for the rest of the run; a premature call is refused as an
// observation; the active set survives an interrupt/resume. Driven through the real
// engine. Mirror of the .NET SkillToolsTests.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { tool as lcTool, type StructuredToolInterface } from "@langchain/core/tools";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { z } from "zod";

import { channel, END, graph, InMemoryCheckpointer, START } from "@ilmek/core";
import { mekik } from "@mekik/core";
import type { Connection, OutgoingFrame, SkillEntry } from "@mekik/core";

import { runAgent, type ToolPolicyMap } from "../src/index.ts";

class FakeConn implements Connection {
    readonly id = "c-1";
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

/** A scripted model that records which tools each call offered and the observations it saw. */
function scriptedModel(turns: Turn[]) {
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
                    return Promise.resolve(
                        new AIMessage({
                            content: turn.text ?? "",
                            tool_calls: (turn.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, args: c.args })),
                        }),
                    );
                },
            };
        },
    } as unknown as BaseChatModel;
    return { model, offered, observations: () => observations };
}

const REPORTING: SkillEntry = { name: "reporting", description: "Sprint numbers.", instructions: "Use the sprint tools." };
const DOCS: SkillEntry = { name: "docs", description: "Docs.", instructions: "Read docs.", tags: ["docs"] };

function mkTool(name: string, description: string, fn: () => Promise<string>): StructuredToolInterface {
    return lcTool(fn as never, { name, description, schema: z.object({}) as never }) as unknown as StructuredToolInterface;
}

function makeTools(c: { sprint: number; refund: number }) {
    const today = mkTool("today", "Today's date.", async () => "2026-10-07");
    const sprint = mkTool("get_sprint", "Sprint metrics.", async () => (c.sprint++, "velocity 42"));
    const refund = mkTool("refund", "Refund a payment.", async () => (c.refund++, "refunded"));
    return { today, sprint, refund };
}

function makeApp(
    model: BaseChatModel,
    tools: StructuredToolInterface[],
    skillTools: Record<string, StructuredToolInterface[]>,
    opts: { tags?: string[]; policy?: ToolPolicyMap } = {},
) {
    const g = graph("agent")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("agent", async (state, ctx) => ({
            reply: await runAgent(ctx, model, {
                system: "You are a test agent.",
                input: (state.input as string) ?? "",
                tools,
                stream: false,
                skills: opts.tags ? { tags: opts.tags } : true,
                skillTools,
                ...(opts.policy ? { policy: opts.policy } : {}),
            }),
        }))
        .edge(START, "agent")
        .edge("agent", END)
        .compile();
    return mekik({ graph: g, checkpointer: new InMemoryCheckpointer(), reply: (s) => s.reply as string, skills: [REPORTING, DOCS] });
}

const run = async (app: ReturnType<typeof makeApp>) => {
    const c = new FakeConn();
    await app.connect(c);
    await app.receive(c, { type: "text", data: { text: "go" } });
    return c;
};

const dataOf = (f: OutgoingFrame) => (f as { data: Record<string, unknown> }).data;

describe("runAgent skillTools", () => {
    test("skill tools are offered only after load_skill, and the load names them", async () => {
        const c = { sprint: 0, refund: 0 };
        const { today, sprint } = makeTools(c);
        const m = scriptedModel([
            { toolCalls: [{ id: "1", name: "load_skill", args: { name: "reporting" } }] },
            { toolCalls: [{ id: "2", name: "get_sprint", args: {} }] },
            { text: "Velocity is 42." },
        ]);

        const conn = await run(makeApp(m.model, [today], { reporting: [sprint] }));

        assert.deepEqual(m.offered[0], ["today", "load_skill"]);
        assert.deepEqual(m.offered[1], ["today", "load_skill", "get_sprint"]);
        assert.deepEqual(m.offered[2], ["today", "load_skill", "get_sprint"]);
        assert.ok(m.observations().join("\n").includes("Tools now available from skill reporting: get_sprint."));
        assert.equal(c.sprint, 1);
        assert.ok(conn.sent.some((f) => f.type === "skill" && dataOf(f).name === "reporting"));
        assert.ok(conn.sent.some((f) => f.type === "tool_call" && dataOf(f).name === "get_sprint"));
    });

    test("a skill tool called before its skill is loaded is refused without running", async () => {
        const c = { sprint: 0, refund: 0 };
        const { today, sprint } = makeTools(c);
        const m = scriptedModel([{ toolCalls: [{ id: "1", name: "get_sprint", args: {} }] }, { text: "ok" }]);

        await run(makeApp(m.model, [today], { reporting: [sprint] }));

        assert.equal(c.sprint, 0);
        assert.ok(m.observations().some((o) => o.includes('belongs to skill "reporting"') && o.includes("load_skill")));
        assert.ok(!m.offered[1]!.includes("get_sprint"));
    });

    test("a skill hidden by the node filter never unlocks its tools", async () => {
        const c = { sprint: 0, refund: 0 };
        const { today, sprint } = makeTools(c);
        const m = scriptedModel([{ toolCalls: [{ id: "1", name: "load_skill", args: { name: "reporting" } }] }, { text: "ok" }]);

        // The tagged "docs" skill — the one holding get_sprint — is hidden by a tag it lacks.
        await run(makeApp(m.model, [today], { docs: [sprint] }, { tags: ["nothing"] }));

        for (const names of m.offered) assert.ok(!names.includes("get_sprint"));
    });

    test("a tool both always-on and skill-held fails the run", async () => {
        const c = { sprint: 0, refund: 0 };
        const { today, sprint } = makeTools(c);
        const m = scriptedModel([{ text: "unused" }]);

        const conn = await run(makeApp(m.model, [today, sprint], { reporting: [sprint] }));

        assert.ok(conn.sent.some((f) => f.type === "run" && dataOf(f).status === "error"));
        assert.equal(m.offered.length, 0);
    });

    test("the active skill set survives an approval interrupt and resume", async () => {
        const c = { sprint: 0, refund: 0 };
        const { today, refund } = makeTools(c);
        const m = scriptedModel([
            { toolCalls: [{ id: "1", name: "load_skill", args: { name: "reporting" } }] },
            { toolCalls: [{ id: "2", name: "refund", args: {} }] },
            { text: "Refunded." },
        ]);
        const app = makeApp(m.model, [today], { reporting: [refund] }, { policy: { refund: { approve: {} } } });

        const conn = await run(app);
        const interrupt = conn.sent.find((f) => f.type === "interrupt") as { id: string } | undefined;
        assert.ok(interrupt);
        assert.equal(c.refund, 0);

        await app.receive(conn, { type: "resume", answers: { [interrupt.id]: { approved: true } } });

        // The recorded load_skill re-activated the skill on the replay pass, so the refund
        // was dispatched (not refused as locked) and ran exactly once.
        assert.equal(c.refund, 1);
        assert.equal(m.offered.length, 3); // two recorded decisions replayed, one new model call
        assert.ok(m.offered[2]!.includes("refund"));
        assert.ok(conn.sent.some((f) => f.type === "run" && dataOf(f).status === "finished"));
    });
});
