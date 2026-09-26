// withSkills (PROTOCOL.md §12): the turn's skills surfaced as LangChain tools —
// load_skill for instructions, read_skill_resource when the catalog has files.
// Driven through the real engine so the assertions are about the wire: the
// `skill` trace, the observation the model reads, and the filter agreement
// between prompt and tool.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { channel, END, graph, InMemoryCheckpointer, START } from "@ilmek/core";

import { mekik, skillsPrompt } from "@mekik/core";
import type { Connection, OutgoingFrame, SkillEntry, SkillSource } from "@mekik/core";

import { LOAD_SKILL_TOOL, READ_SKILL_RESOURCE_TOOL, withSkills } from "../src/index.ts";

class FakeConn implements Connection {
    readonly id = "c-1";
    readonly sent: OutgoingFrame[] = [];
    send(f: OutgoingFrame): void {
        this.sent.push(f);
    }
    close(): void {}
}

const skillFrames = (c: FakeConn) => c.sent.filter((f) => f.type === "skill").map((f) => (f as Extract<OutgoingFrame, { type: "skill" }>).data);

const PDF: SkillEntry = { name: "pdf", description: "Fill PDF forms.", instructions: "Use scripts/fill.py.", tags: ["docs"] };
const VOICE: SkillEntry = { name: "brand-voice", description: "House style.", instructions: "Short sentences." };

const withFiles: SkillSource = {
    list: () => [PDF, VOICE].map(({ instructions: _i, ...s }) => s),
    get: (n) => [PDF, VOICE].find((s) => s.name === n),
    readResource: async (name, path) => {
        if (path.startsWith("..")) throw new Error("outside skill");
        return `${name}/${path}: field names are snake_case`;
    },
};

function makeApp(skills: SkillSource | SkillEntry[], body: (ctx: any) => Promise<string>) {
    const g = graph("agent")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("agent", async (_s, ctx) => ({ reply: await body(ctx) }))
        .edge(START, "agent")
        .edge("agent", END)
        .compile();
    return mekik({ graph: g, checkpointer: new InMemoryCheckpointer(), reply: (s) => s.reply as string, skills });
}

const run = async (app: ReturnType<typeof makeApp>) => {
    const c = new FakeConn();
    await app.connect(c);
    await app.receive(c, { type: "text", data: { text: "go" } });
    return c;
};

describe("withSkills", () => {
    test("exposes load_skill, plus read_skill_resource only when the catalog has files", async () => {
        let names: string[] = [];
        await run(makeApp([PDF, VOICE], async (ctx) => {
            names = withSkills(ctx).map((t) => t.name);
            return "done";
        }));
        assert.deepEqual(names, [LOAD_SKILL_TOOL]);

        await run(makeApp(withFiles, async (ctx) => {
            names = withSkills(ctx).map((t) => t.name);
            return "done";
        }));
        assert.deepEqual(names, [LOAD_SKILL_TOOL, READ_SKILL_RESOURCE_TOOL]);
    });

    test("no skills in the turn ⇒ no tools, and an empty prompt block", async () => {
        let count = -1;
        let prompt = "x";
        const g = graph("bare")
            .channel("input", channel.lastWrite<string>(""))
            .channel("reply", channel.lastWrite<string>(""))
            .node("agent", (_s, ctx) => {
                count = withSkills(ctx).length;
                prompt = skillsPrompt(ctx);
                return { reply: "ok" };
            })
            .edge(START, "agent")
            .edge("agent", END)
            .compile();
        const app = mekik({ graph: g, reply: (s) => s.reply as string });
        await run(app as never);
        assert.equal(count, 0);
        assert.equal(prompt, "");
    });

    test("load_skill returns the instructions and emits the skill trace", async () => {
        const c = await run(makeApp([PDF, VOICE], async (ctx) => {
            const [load] = withSkills(ctx);
            return String(await load!.invoke({ name: "pdf" } as never));
        }));
        assert.equal(c.sent.filter((f) => f.type === "text" && (f as { from?: string }).from === "bot").map((f) => (f as { data: { text: string } }).data.text).at(-1), "Use scripts/fill.py.");
        assert.deepEqual(skillFrames(c).map((u) => [u.name, u.status, u.source]), [["pdf", "loaded", "server"]]);
    });

    test("an unknown name is an observation, not a crash — and the filter hides what the prompt hides", async () => {
        let out = "";
        const c = await run(makeApp([PDF, VOICE], async (ctx) => {
            const [load] = withSkills(ctx, { tags: ["docs"] });   // brand-voice is untagged → still visible; pdf tagged docs → visible
            out = String(await load!.invoke({ name: "nope" } as never));
            const [scoped] = withSkills(ctx, { source: "client" }); // nothing declared → no tools at all
            return scoped === undefined ? "scoped-empty" : "unexpected";
        }));
        assert.match(out, /^Unknown skill "nope"\. Available: brand-voice, pdf\.$/);
        assert.equal(skillFrames(c).length, 0, "a refused name never reaches loadSkill, so no trace");
    });

    test("read_skill_resource reads through the catalog and reports its refusals as observations", async () => {
        let ok = "";
        let refused = "";
        await run(makeApp(withFiles, async (ctx) => {
            const read = withSkills(ctx).find((t) => t.name === READ_SKILL_RESOURCE_TOOL)!;
            ok = String(await read.invoke({ name: "pdf", path: "references/forms.md" } as never));
            refused = String(await read.invoke({ name: "pdf", path: "../secret" } as never));
            return "done";
        }));
        assert.equal(ok, "pdf/references/forms.md: field names are snake_case");
        assert.match(refused, /^Error reading \.\.\/secret from skill pdf: outside skill$/);
    });
});
