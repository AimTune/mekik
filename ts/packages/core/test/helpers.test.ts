// Unit tests for the authoring helpers that own logic beyond a single emit.
// `streamText` is the token-by-token convenience: it drives an async delta source
// through `text()` (so a client renders one growing bubble) and returns the joined
// text for the node to hand back as its durable reply.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import type { Context } from "@ilmek/core";

import { action, authClaims, choose, claimStrings, event, mount, streamText, text, ui } from "../src/helpers.ts";

/** A ctx stand-in that records what the helper emits — all `streamText` touches. */
function recordingCtx() {
    const emitted: Array<Record<string, unknown>> = [];
    const ctx = { emit: (p: unknown) => emitted.push(p as Record<string, unknown>) } as unknown as Context<any>;
    return { ctx, emitted };
}

/** A ctx stand-in that also captures `ctx.interrupt` calls — what `choose` touches. */
function interruptingCtx(answer: unknown = undefined) {
    const interrupts: Array<{ payload: unknown; key: string | undefined }> = [];
    const ctx = {
        emit: () => {},
        interrupt: (payload: unknown, key?: string) => {
            interrupts.push({ payload, key });
            return Promise.resolve(answer);
        },
    } as unknown as Context<any>;
    return { ctx, interrupts };
}

async function* stream<T>(items: T[]): AsyncIterable<T> {
    for (const item of items) yield item;
}

describe("mekik.streamText", () => {
    test("emits one text chunk per non-empty delta and returns the joined text", async () => {
        const { ctx, emitted } = recordingCtx();

        const full = await streamText(ctx, stream(["Hel", "", "lo"]));

        assert.equal(full, "Hello");
        // The empty delta is skipped; the rest ride the same genui text stream.
        assert.deepEqual(emitted, [
            { $mekik: "genui", chunk: { type: "text", content: "Hel" } },
            { $mekik: "genui", chunk: { type: "text", content: "lo" } },
        ]);
    });

    test("uses the selector to pull the text out of structured deltas", async () => {
        const { ctx, emitted } = recordingCtx();

        const full = await streamText(ctx, stream([{ text: "A" }, { text: "B" }]), (d) => d.text);

        assert.equal(full, "AB");
        assert.equal(emitted.length, 2);
    });

    test("a source that yields nothing emits nothing and returns an empty string", async () => {
        const { ctx, emitted } = recordingCtx();

        const full = await streamText(ctx, stream<string>([]));

        assert.equal(full, "");
        assert.equal(emitted.length, 0);
    });
});

describe("mekik.action / choose", () => {
    test("action builds a chip with and without a value", () => {
        assert.deepEqual(action("Cancel"), { label: "Cancel" });
        assert.deepEqual(action("Approve", { approved: true }), { label: "Approve", value: { approved: true } });
    });

    test("choose interrupts with the options as $mekik actions and resolves the answer", async () => {
        const { ctx, interrupts } = interruptingCtx({ approved: true });

        const answer = await choose(ctx, { title: "Refund?" }, [
            action("Approve", { approved: true }),
            action("Reject", { approved: false }),
        ]);

        assert.deepEqual(answer, { approved: true });
        assert.deepEqual(interrupts, [
            {
                payload: {
                    title: "Refund?",
                    $mekik: {
                        actions: [
                            { label: "Approve", value: { approved: true } },
                            { label: "Reject", value: { approved: false } },
                        ],
                    },
                },
                key: undefined,
            },
        ]);
    });

    test("a string payload becomes {title}; bare string options become label-only chips", async () => {
        const { ctx, interrupts } = interruptingCtx("M");

        const size = await choose(ctx, "Pick a size", ["S", "M", "L"]);

        assert.equal(size, "M");
        assert.deepEqual(interrupts[0]?.payload, {
            title: "Pick a size",
            $mekik: { actions: [{ label: "S" }, { label: "M" }, { label: "L" }] },
        });
    });

    test("choose infers the answer type from the options — no manual generic", async () => {
        const { ctx } = interruptingCtx("M");
        const size = await choose(ctx, "Pick a size", ["S", "M", "L"]);
        // Compile-time contract: the annotation below only typechecks if the
        // inferred type is the option union, not `unknown`.
        const sized: "S" | "M" | "L" = size;
        assert.equal(sized, "M");

        const { ctx: ctx2 } = interruptingCtx({ ok: true });
        const verdict = await choose(ctx2, "Deploy?", [action("Go", { ok: true }), "skip"]);
        const typed: { ok: boolean } | "skip" = verdict;
        assert.deepEqual(typed, { ok: true });
    });

    test("choose forwards ui and the journal key", async () => {
        const { ctx, interrupts } = interruptingCtx();

        await choose(ctx, { title: "Deploy?" }, ["Yes", "No"], {
            ui: { component: "deploy-form", props: { env: "prod" } },
            key: "second-gate",
        });

        assert.equal(interrupts[0]?.key, "second-gate");
        const payload = interrupts[0]?.payload as Record<string, unknown>;
        assert.deepEqual(payload.$mekik, {
            ui: { component: "deploy-form", props: { env: "prod" } },
            actions: [{ label: "Yes" }, { label: "No" }],
        });
    });
});

describe("chunk ids (mekik.text / ui / event / mount)", () => {
    test("text, ui, and event carry a caller-supplied id; omit it and the chunk has none", () => {
        const { ctx, emitted } = recordingCtx();

        text(ctx, "hi", { id: "bubble-1" });
        ui(ctx, "order-card", { total: 1 }, { id: "card-1" });
        event(ctx, "highlight", { rowId: 3 }, { id: 7 });
        ui(ctx, "order-card");

        assert.deepEqual(emitted, [
            { $mekik: "genui", chunk: { type: "text", content: "hi", id: "bubble-1" } },
            { $mekik: "genui", chunk: { type: "ui", component: "order-card", props: { total: 1 }, id: "card-1" } },
            { $mekik: "genui", chunk: { type: "event", name: "highlight", payload: { rowId: 3 }, id: 7 } },
            { $mekik: "genui", chunk: { type: "ui", component: "order-card" } },
        ]);
    });

    test("mount mints replay-stable ids per ctx and update re-emits the same id", () => {
        const { ctx, emitted } = recordingCtx();
        (ctx as unknown as { taskId: string }).taskId = "node:approve#0";

        const first = mount(ctx, "order-card", { status: "loading" });
        const second = mount(ctx, "order-card");
        first.update({ status: "ready" });

        assert.equal(first.id, "node:approve#0:ui:0");
        assert.equal(second.id, "node:approve#0:ui:1");
        assert.deepEqual(emitted, [
            { $mekik: "genui", chunk: { type: "ui", component: "order-card", props: { status: "loading" }, id: "node:approve#0:ui:0" } },
            { $mekik: "genui", chunk: { type: "ui", component: "order-card", id: "node:approve#0:ui:1" } },
            { $mekik: "genui", chunk: { type: "ui", component: "order-card", props: { status: "ready" }, id: "node:approve#0:ui:0" } },
        ]);
    });

    test("mount honours an explicit id instead of minting one", () => {
        const { ctx, emitted } = recordingCtx();

        const card = mount(ctx, "order-card", { total: 9 }, { id: "ORD-42" });
        card.update({ total: 10 });

        assert.equal(card.id, "ORD-42");
        assert.deepEqual(
            emitted.map((e) => (e.chunk as { id?: unknown }).id),
            ["ORD-42", "ORD-42"],
        );
    });
});

describe("mekik.authClaims / claimStrings", () => {
    test("authClaims returns the auth claims record, or {} when absent", () => {
        const withAuth = { meta: { auth: { userName: "alice", roles: ["admin"] } } } as unknown as Context<any>;
        assert.deepEqual(authClaims(withAuth), { userName: "alice", roles: ["admin"] });
        assert.deepEqual(authClaims({ meta: {} } as unknown as Context<any>), {});
        assert.deepEqual(authClaims({} as unknown as Context<any>), {});
    });

    test("claimStrings coerces a string, a string list, and a boxed list; missing ⇒ []", () => {
        assert.deepEqual(claimStrings({ roles: ["a", "b"] }, "roles"), ["a", "b"]);
        assert.deepEqual(claimStrings({ roles: "solo" }, "roles"), ["solo"]);
        assert.deepEqual(claimStrings({ roles: [1, 2] }, "roles"), ["1", "2"]);
        assert.deepEqual(claimStrings({}, "roles"), []);
    });
});

describe("the mekik helper object mirrors Shuttle", () => {
    test("the skill and trace primitives Shuttle exposes are attached to `mekik` too", async () => {
        const index = await import("../src/index.ts");
        const helpers = await import("../src/helpers.ts");
        // Shuttle.SkillResourcesAvailable / SkillTrace / ToolTrace / NextToolCallId
        for (const name of ["skillResourcesAvailable", "skillTrace", "toolTrace", "nextToolCallId"] as const) {
            assert.equal((index.mekik as unknown as Record<string, unknown>)[name], helpers[name], `mekik.${name}`);
            assert.equal(index[name], helpers[name], `named export ${name}`);
        }
    });
});
