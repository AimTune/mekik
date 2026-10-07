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
import { TurnSkills } from "@mekik/core";
import type { Connection, OutgoingFrame, SkillEntry, SkillSource } from "@mekik/core";

import { runAgent, toolContext, withSkills, type ToolPolicyMap } from "../src/index.ts";

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

// ── tools the skill entry owns (SkillEntry.tools) ─────────────────────────────

function makeCatalogApp(
    model: BaseChatModel,
    catalog: readonly SkillEntry[] | SkillSource,
    opts: { tools?: StructuredToolInterface[]; skillTools?: Record<string, StructuredToolInterface[]>; tags?: string[]; policy?: ToolPolicyMap } = {},
) {
    const g = graph("agent")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("agent", async (state, ctx) => ({
            reply: await runAgent(ctx, model, {
                system: "You are a test agent.",
                input: (state.input as string) ?? "",
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
    return mekik({ graph: g, checkpointer: new InMemoryCheckpointer(), reply: (s) => s.reply as string, skills: catalog });
}

describe("runAgent with tools owned by the skill entry", () => {
    test("an entry's own tools are offered only after load_skill, and the load names them", async () => {
        const c = { sprint: 0, refund: 0 };
        const { today, sprint } = makeTools(c);
        const m = scriptedModel([
            { toolCalls: [{ id: "1", name: "load_skill", args: { name: "reporting" } }] },
            { toolCalls: [{ id: "2", name: "get_sprint", args: {} }] },
            { text: "Velocity is 42." },
        ]);

        const conn = await run(makeCatalogApp(m.model, [{ ...REPORTING, tools: [sprint] }, DOCS], { tools: [today] }));

        assert.deepEqual(m.offered[0], ["today", "load_skill"]);
        assert.deepEqual(m.offered[1], ["today", "load_skill", "get_sprint"]);
        assert.ok(m.observations().join("\n").includes("Tools now available from skill reporting: get_sprint."));
        assert.equal(c.sprint, 1);
        assert.ok(conn.sent.some((f) => f.type === "tool_call" && dataOf(f).name === "get_sprint"));
        assert.ok(!JSON.stringify(conn.sent.filter((f) => f.type === "skills")).includes("get_sprint"), "the catalog frame never names a tool");
    });

    test("a premature call to an entry's tool is refused without running", async () => {
        const c = { sprint: 0, refund: 0 };
        const { sprint } = makeTools(c);
        const m = scriptedModel([{ toolCalls: [{ id: "1", name: "get_sprint", args: {} }] }, { text: "ok" }]);

        await run(makeCatalogApp(m.model, [{ ...REPORTING, tools: [sprint] }]));

        assert.equal(c.sprint, 0);
        assert.ok(m.observations().some((o) => o.includes('belongs to skill "reporting"')));
        for (const names of m.offered) assert.ok(!names.includes("get_sprint"));
    });

    test("explicit skillTools merge with the entry's own tools", async () => {
        const c = { sprint: 0, refund: 0 };
        const { sprint, refund } = makeTools(c);
        const m = scriptedModel([{ toolCalls: [{ id: "1", name: "load_skill", args: { name: "reporting" } }] }, { text: "ok" }]);

        await run(makeCatalogApp(m.model, [{ ...REPORTING, tools: [sprint] }], { skillTools: { reporting: [refund, sprint] } }));

        assert.deepEqual(m.offered[1], ["load_skill", "get_sprint", "refund"]);
        assert.ok(m.observations().join("\n").includes("Tools now available from skill reporting: get_sprint, refund."));
    });

    test("an entry tool sharing a name with an always-on tool fails the run", async () => {
        const c = { sprint: 0, refund: 0 };
        const { sprint } = makeTools(c);
        const m = scriptedModel([{ text: "unused" }]);

        const conn = await run(makeCatalogApp(m.model, [{ ...REPORTING, tools: [sprint] }], { tools: [sprint] }));

        assert.ok(conn.sent.some((f) => f.type === "run" && dataOf(f).status === "error"));
        assert.equal(m.offered.length, 0);
    });

    test("one name under two skills with different tools fails the run; the same tool under two is fine", async () => {
        const c = { sprint: 0, refund: 0 };
        const { sprint } = makeTools(c);
        const other = mkTool("get_sprint", "A different sprint tool.", async () => "x");
        const DOCS_UNTAGGED: SkillEntry = { name: "docs", description: "Docs.", instructions: "Read docs." };

        const bad = scriptedModel([{ text: "unused" }]);
        const failed = await run(makeCatalogApp(bad.model, [{ ...REPORTING, tools: [sprint] }, DOCS_UNTAGGED], { skillTools: { docs: [other] } }));
        assert.ok(failed.sent.some((f) => f.type === "run" && dataOf(f).status === "error"));
        assert.equal(bad.offered.length, 0);

        const ok = scriptedModel([
            { toolCalls: [{ id: "0", name: "get_sprint", args: {} }] },
            { toolCalls: [{ id: "1", name: "load_skill", args: { name: "docs" } }] },
            { text: "ok" },
        ]);
        await run(makeCatalogApp(ok.model, [{ ...REPORTING, tools: [sprint] }, { ...DOCS_UNTAGGED, tools: [sprint] }]));
        assert.deepEqual(ok.offered[2], ["load_skill", "get_sprint"]);
        // A premature call names every skill that holds the tool, in catalog order.
        assert.ok(ok.observations().some((o) => o.startsWith('Tool get_sprint belongs to skills "docs", "reporting".')));
    });

    test("an entry hidden by the node's tag filter never unlocks its tools", async () => {
        const c = { sprint: 0, refund: 0 };
        const { sprint } = makeTools(c);
        const m = scriptedModel([
            { toolCalls: [{ id: "1", name: "load_skill", args: { name: "docs" } }] },
            { toolCalls: [{ id: "2", name: "get_sprint", args: {} }] },
            { text: "ok" },
        ]);

        await run(makeCatalogApp(m.model, [REPORTING, { ...DOCS, tools: [sprint] }], { tags: ["nothing"] }));

        for (const names of m.offered) assert.ok(!names.includes("get_sprint"));
        assert.equal(c.sprint, 0);
        assert.ok(m.observations().some((o) => o.includes('Unknown skill "docs"')));
    });

    test("a failed load unlocks nothing", async () => {
        const c = { sprint: 0, refund: 0 };
        const { sprint } = makeTools(c);
        // Listed, but the source cannot produce it: load_skill fails (status:error trace).
        const broken: SkillSource = { list: () => [{ name: "reporting", description: "Sprint numbers." }], get: () => undefined };
        const m = scriptedModel([
            { toolCalls: [{ id: "1", name: "load_skill", args: { name: "reporting" } }] },
            { toolCalls: [{ id: "2", name: "get_sprint", args: {} }] },
            { text: "ok" },
        ]);

        const conn = await run(makeCatalogApp(m.model, broken, { skillTools: { reporting: [sprint] } }));

        for (const names of m.offered) assert.ok(!names.includes("get_sprint"));
        assert.equal(c.sprint, 0);
        assert.ok(conn.sent.some((f) => f.type === "skill" && dataOf(f).status === "error"));
        assert.ok(m.observations().some((o) => o.includes('belongs to skill "reporting"')));
    });

    test("an entry's tools stay unlocked across an approval interrupt and resume, and run once", async () => {
        const c = { sprint: 0, refund: 0 };
        const { refund } = makeTools(c);
        const m = scriptedModel([
            { toolCalls: [{ id: "1", name: "load_skill", args: { name: "reporting" } }] },
            { toolCalls: [{ id: "2", name: "refund", args: {} }] },
            { text: "Refunded." },
        ]);
        const app = makeCatalogApp(m.model, [{ ...REPORTING, tools: [refund] }], { policy: { refund: { approve: {} } } });

        const conn = await run(app);
        const interrupt = conn.sent.find((f) => f.type === "interrupt") as { id: string } | undefined;
        assert.ok(interrupt);
        assert.equal(c.refund, 0);

        await app.receive(conn, { type: "resume", answers: { [interrupt.id]: { approved: true } } });

        assert.equal(c.refund, 1);
        assert.ok(m.offered[2]!.includes("refund"));
        assert.ok(conn.sent.some((f) => f.type === "run" && dataOf(f).status === "finished"));
    });

    test("an unlocked skill tool that throws comes back as an observation, traced running → error", async () => {
        const boom = mkTool("get_sprint", "Sprint metrics.", async () => {
            throw new Error("sprint service down");
        });
        const m = scriptedModel([
            { toolCalls: [{ id: "1", name: "load_skill", args: { name: "reporting" } }] },
            { toolCalls: [{ id: "2", name: "get_sprint", args: {} }] },
            { text: "The sprint service is down." },
        ]);

        const conn = await run(makeCatalogApp(m.model, [{ ...REPORTING, tools: [boom] }]));

        assert.ok(m.observations().some((o) => o === "Error from get_sprint: sprint service down"));
        const statuses = conn.sent.filter((f) => f.type === "tool_call" && dataOf(f).name === "get_sprint").map((f) => dataOf(f).status);
        assert.deepEqual(statuses, ["running", "error"]);
        assert.ok(conn.sent.some((f) => f.type === "run" && dataOf(f).status === "finished"), "the run goes on");
    });

    test("an entry holding something that is not a LangChain tool fails the run", async () => {
        const m = scriptedModel([{ text: "unused" }]);
        const conn = await run(makeCatalogApp(m.model, [{ ...REPORTING, tools: [{ nope: true } as never] }]));
        assert.ok(conn.sent.some((f) => f.type === "run" && dataOf(f).status === "error"));
    });
});

describe("withSkills for a hand-wired loop", () => {
    test("the load names the entry's own tools plus any extra, and onLoaded fires only on success", async () => {
        const c = { sprint: 0, refund: 0 };
        const { sprint } = makeTools(c);
        const source: SkillSource = {
            list: () => [
                { name: "reporting", description: "Sprint numbers." },
                { name: "ghost", description: "Listed, never served." },
            ],
            get: (n) => (n === "reporting" ? { ...REPORTING, tools: [sprint] } : undefined),
        };
        const ctx = { taskId: "t", meta: { skills: new TurnSkills(source, []) }, emit: () => {} } as never;
        const loaded: string[] = [];
        const [load] = withSkills(ctx, {}, { toolNames: { reporting: ["refund"] }, onLoaded: (n) => loaded.push(n) });

        const obs = String(await load!.invoke({ name: "reporting" } as never));
        assert.ok(obs.endsWith("Tools now available from skill reporting: get_sprint, refund."));
        await load!.invoke({ name: "ghost" } as never);
        await load!.invoke({ name: "missing" } as never);
        assert.deepEqual(loaded, ["reporting"]);
    });
});

describe("toolContext — a tool built once reaches the run's ctx", () => {
    test("a catalog-owned tool reads the calling run's ctx from its config; outside a wrapped call it throws", async () => {
        const seen: string[] = [];
        // Built once, at module level — no ctx in scope.
        const whoAmI = lcTool(
            async (_input: unknown, config: unknown) => {
                const ctx = toolContext(config);
                seen.push(ctx.threadId);
                mekik.text(ctx, "said by the tool");
                return "ok";
            },
            { name: "who_am_i", description: "Report the conversation.", schema: z.object({}) as never },
        ) as unknown as StructuredToolInterface;
        const m = scriptedModel([
            { toolCalls: [{ id: "1", name: "load_skill", args: { name: "reporting" } }] },
            { toolCalls: [{ id: "2", name: "who_am_i", args: {} }] },
            { text: "done" },
        ]);

        const conn = await run(makeCatalogApp(m.model, [{ ...REPORTING, tools: [whoAmI] }]));

        assert.equal(seen.length, 1);
        assert.ok(seen[0]!.length > 0, "the ctx carries the conversation's thread id");
        assert.ok(JSON.stringify(conn.sent).includes("said by the tool"), "the tool emitted on the run's ctx");
        await assert.rejects(whoAmI.invoke({} as never), /not invoked through withMekikTools/);
    });
});
