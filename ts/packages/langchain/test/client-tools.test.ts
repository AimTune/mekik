// withClientTools (PROTOCOL.md §11): the client's declared tools surfaced as
// LangChain tools. Driven through the real engine so the assertions are about
// the wire — the interrupt round-trip, the notify chunk, and the traces.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { channel, END, graph, InMemoryCheckpointer, START } from "@ilmek/core";

import { mekik } from "@mekik/core";
import type { ClientToolDefinition, Connection, OutgoingFrame } from "@mekik/core";

import { withClientTools } from "../src/index.ts";

class FakeConn implements Connection {
    readonly id = "c-1";
    readonly sent: OutgoingFrame[] = [];
    send(f: OutgoingFrame): void {
        this.sent.push(f);
    }
    close(): void {}
}

const first = <T extends OutgoingFrame["type"]>(c: FakeConn, t: T): Extract<OutgoingFrame, { type: T }> =>
    c.sent.find((f) => f.type === t) as Extract<OutgoingFrame, { type: T }>;

const TOOLS: ClientToolDefinition[] = [
    {
        name: "pick_date",
        description: "Open the client's date picker",
        parameters: { type: "object", properties: { min: { type: "string" } }, required: ["min"] },
    },
    { name: "show_confetti", mode: "notify", tags: ["fun"] },
];

function makeApp(body: (ctx: any) => Promise<string>) {
    const g = graph("agent")
        .channel("input", channel.lastWrite<string>(""))
        .channel("reply", channel.lastWrite<string>(""))
        .node("agent", async (_s, ctx) => ({ reply: await body(ctx) }))
        .edge(START, "agent")
        .edge("agent", END)
        .compile();
    return mekik({ graph: g, checkpointer: new InMemoryCheckpointer(), reply: (s) => s.reply as string, clientTools: true });
}

describe("withClientTools", () => {
    test("wraps the declared tools with name, description, and the declared JSON schema", async () => {
        let seen: Array<{ name: string; description: string }> = [];
        const app = makeApp(async (ctx) => {
            seen = withClientTools(ctx).map((t) => ({ name: t.name, description: t.description }));
            return "done";
        });
        const c = new FakeConn();
        await app.connect(c, { hello: { tools: TOOLS } });
        await app.receive(c, { type: "text", data: { text: "go" } });

        assert.deepEqual(
            seen,
            [
                { name: "pick_date", description: "Open the client's date picker" },
                { name: "show_confetti", description: 'Invoke the client\'s "show_confetti" tool.' },
            ],
        );
    });

    test("tag filtering narrows what the node hands the model", async () => {
        let names: string[] = [];
        const app = makeApp(async (ctx) => {
            names = withClientTools(ctx, { tags: ["fun"] }).map((t) => t.name);
            return "done";
        });
        const c = new FakeConn();
        await app.connect(c, { hello: { tools: [{ name: "tagged_other", tags: ["billing"] }, ...TOOLS] } });
        await app.receive(c, { type: "text", data: { text: "go" } });

        // Untagged tools are unrestricted; "tagged_other" is scoped away.
        assert.deepEqual(names, ["pick_date", "show_confetti"]);
    });

    test("invoking a call-mode tool parks the run; the resume result comes back as the observation", async () => {
        const app = makeApp(async (ctx) => {
            const [pickDate] = withClientTools(ctx, { mode: "call" });
            const observation = await pickDate!.invoke({ min: "2026-08-01" });
            return `observed ${observation}`;
        });
        const c = new FakeConn();
        await app.connect(c, { hello: { tools: TOOLS } });
        await app.receive(c, { type: "text", data: { text: "go" } });

        const intr = first(c, "interrupt");
        assert.deepEqual(intr.data.tool, { name: "pick_date", params: { min: "2026-08-01" } });

        await app.receive(c, { type: "resume", answers: { [intr.id]: { ok: true, result: { date: "2026-08-15" } } } });
        const reply = c.sent.filter((f) => f.type === "text" && (f as { from?: string }).from === "bot").at(-1)!;
        assert.equal((reply as { data: { text: string } }).data.text, 'observed {"date":"2026-08-15"}');
    });

    test("a handler error becomes an observation, not a crash — the loop stays alive", async () => {
        const app = makeApp(async (ctx) => {
            const [pickDate] = withClientTools(ctx, { mode: "call" });
            return String(await pickDate!.invoke({ min: "x" }));
        });
        const c = new FakeConn();
        await app.connect(c, { hello: { tools: TOOLS } });
        await app.receive(c, { type: "text", data: { text: "go" } });
        const intr = first(c, "interrupt");

        await app.receive(c, { type: "resume", answers: { [intr.id]: { ok: false, error: "picker dismissed" } } });
        const statuses = c.sent
            .filter((f): f is Extract<OutgoingFrame, { type: "run" }> => f.type === "run")
            .map((f) => f.data.status);
        assert.deepEqual(statuses, ["started", "interrupted", "started", "finished"]);
        const reply = c.sent.filter((f) => f.type === "text" && (f as { from?: string }).from === "bot").at(-1)!;
        assert.equal((reply as { data: { text: string } }).data.text, "Error from client tool pick_date: picker dismissed");
    });

    test("a notify tool resolves immediately with a delivery note", async () => {
        const app = makeApp(async (ctx) => {
            const confetti = withClientTools(ctx).find((t) => t.name === "show_confetti");
            return String(await confetti!.invoke({}));
        });
        const c = new FakeConn();
        await app.connect(c, { hello: { tools: TOOLS } });
        await app.receive(c, { type: "text", data: { text: "go" } });

        assert.equal(c.sent.some((f) => f.type === "interrupt"), false);
        const reply = c.sent.filter((f) => f.type === "text" && (f as { from?: string }).from === "bot").at(-1)!;
        assert.equal((reply as { data: { text: string } }).data.text, "Delivered show_confetti to the client.");
    });
});
