// Unit tests for the authoring helpers that own logic beyond a single emit.
// `streamText` is the token-by-token convenience: it drives an async delta source
// through `text()` (so a client renders one growing bubble) and returns the joined
// text for the node to hand back as its durable reply.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import type { Context } from "@ilmek/core";

import { authClaims, claimStrings, streamText } from "../src/helpers.ts";

/** A ctx stand-in that records what the helper emits — all `streamText` touches. */
function recordingCtx() {
    const emitted: Array<Record<string, unknown>> = [];
    const ctx = { emit: (p: unknown) => emitted.push(p as Record<string, unknown>) } as unknown as Context<any>;
    return { ctx, emitted };
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
