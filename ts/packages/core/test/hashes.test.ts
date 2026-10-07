// Catalog hashes against the shared goldens in conformance/hashes/catalogs.json
// (PROTOCOL.md §9, §10.2, §12.2). The hash is the cross-language contract a
// client caches against: a client that moves between a TypeScript and a .NET
// server must see the same hash for the same catalog, or it re-downloads (or,
// worse, trusts a stale cache). The .NET suite replays the same file.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { channel, END, graph, START } from "@ilmek/core";

import { mekik } from "../src/index.ts";
import { ComponentCatalog } from "../src/components.ts";
import { canonicalize } from "../src/protocol.ts";
import { hashSkills } from "../src/skills.ts";
import type { Connection } from "../src/engine.ts";
import type { GenUiComponentDefinition, OutgoingFrame, SkillSummary } from "../src/protocol.ts";

interface Golden {
    components: Array<{ name: string; definitions: GenUiComponentDefinition[]; canonical: string; hash: string }>;
    skills: Array<{ name: string; summaries: SkillSummary[]; canonical: string; hash: string }>;
}

const golden = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../conformance/hashes/catalogs.json"), "utf8"),
) as Golden;

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

describe("component catalog hashes (conformance/hashes/catalogs.json)", () => {
    test("the golden file has cases", () => {
        assert.ok(golden.components.length >= 5);
    });

    for (const c of golden.components) {
        test(c.name, () => {
            const catalog = new ComponentCatalog(c.definitions);
            assert.equal(canonicalize(catalog.definitions), c.canonical, "canonical JSON");
            assert.equal(catalog.hash, c.hash);
            assert.equal(sha256(c.canonical), c.hash, "the hash is sha256 of exactly that string");
        });
    }

    test("reversing declaration order does not change any golden hash", () => {
        for (const c of golden.components) {
            assert.equal(new ComponentCatalog([...c.definitions].reverse()).hash, c.hash, c.name);
        }
    });
});

describe("skill catalog hashes (conformance/hashes/catalogs.json)", () => {
    for (const s of golden.skills) {
        test(s.name, () => {
            assert.equal(hashSkills(s.summaries), s.hash);
            assert.equal(sha256(s.canonical), s.hash);
        });
    }

    test("tools a skill owns (SkillEntry.tools, §12.6) never enter the hash: every golden holds with tools attached", async () => {
        for (const s of golden.skills) {
            const entries = s.summaries.map((x, i) => ({ ...x, instructions: "…", tools: [{ name: `tool_${i}` }, () => "fn"] }));
            const listed = mekik({ graph: graph("t").channel("input", channel.lastWrite<string>("")).node("n", () => ({})).edge(START, "n").edge("n", END).compile(), skills: entries });
            assert.equal(hashSkills(entries), s.hash, s.name);
            const conn = { id: `tools-${s.name}`, sent: [] as OutgoingFrame[], send(f: OutgoingFrame) { this.sent.push(f); }, close() {} };
            await listed.connect(conn);
            const frame = conn.sent.find((f) => f.type === "skills") as Extract<OutgoingFrame, { type: "skills" }> | undefined;
            if (s.summaries.length > 0) assert.equal(frame?.hash, s.hash, `${s.name} on the wire`);
            assert.ok(!JSON.stringify(conn.sent).includes("tool_0"), "no frame carries a tool");
        }
    });

    test("an empty catalog has the empty hash", () => {
        assert.equal(hashSkills([]), "");
    });

    test("a changed description, an added tag, or a renamed skill each move the hash", () => {
        const base: SkillSummary[] = [{ name: "pdf", description: "Fill, merge and read PDF forms." }];
        const h = hashSkills(base);
        assert.notEqual(hashSkills([{ ...base[0]!, description: "Fill PDF forms." }]), h);
        assert.notEqual(hashSkills([{ ...base[0]!, tags: ["docs"] }]), h);
        assert.notEqual(hashSkills([{ ...base[0]!, name: "pdfs" }]), h);
    });
});

describe("the hash on the wire (§12.2)", () => {
    class Conn implements Connection {
        readonly sent: OutgoingFrame[] = [];
        readonly id: string;
        constructor(id: string) {
            this.id = id;
        }
        send(f: OutgoingFrame): void {
            this.sent.push(f);
        }
        close(): void {}
    }
    const g = graph("noop").channel("input", channel.lastWrite<string>("")).node("n", () => ({})).edge(START, "n").edge("n", END).compile();
    const skillsFrame = (c: Conn) => c.sent.find((f) => f.type === "skills") as Extract<OutgoingFrame, { type: "skills" }>;

    test("two independently built apps with the same catalog announce the golden hash", async () => {
        const entries = golden.skills[1]!.summaries.map((s) => ({ ...s, instructions: "…" }));
        const a = new Conn("h-a");
        const b = new Conn("h-b");
        await mekik({ graph: g, skills: entries }).connect(a);
        await mekik({ graph: g, skills: [...entries].reverse() }).connect(b);
        assert.equal(skillsFrame(a).hash, golden.skills[1]!.hash);
        assert.equal(skillsFrame(b).hash, golden.skills[1]!.hash);
    });

    test("a cached golden hash is answered `unchanged` with no list; a stale one gets the list", async () => {
        const entries = golden.skills[0]!.summaries.map((s) => ({ ...s, instructions: "…" }));
        const app = mekik({ graph: g, skills: entries });
        const fresh = new Conn("h-c");
        await app.connect(fresh, { hello: { skillsHash: golden.skills[0]!.hash } });
        assert.deepEqual(skillsFrame(fresh), { type: "skills", hash: golden.skills[0]!.hash, unchanged: true });

        const stale = new Conn("h-d");
        await app.connect(stale, { hello: { skillsHash: golden.skills[1]!.hash } });
        assert.equal(skillsFrame(stale).unchanged, undefined);
        assert.deepEqual(skillsFrame(stale).skills, [{ name: "pdf", description: "Fill, merge and read PDF forms.", source: "server" }]);
    });

    test("an empty-string skillsHash never matches — a client with no cache always gets the list", async () => {
        const app = mekik({ graph: g, skills: golden.skills[0]!.summaries.map((s) => ({ ...s, instructions: "…" })) });
        const c = new Conn("h-e");
        await app.connect(c, { hello: { skillsHash: "" } });
        assert.equal(skillsFrame(c).skills?.length, 1);
    });
});
