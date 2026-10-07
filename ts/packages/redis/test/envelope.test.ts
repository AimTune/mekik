// Replays conformance/redis/envelope.json — the backplane envelope both
// RedisBackplane implementations share (PROTOCOL.md §5.1). The .NET suite replays
// the same file (Mekik.Redis.Tests/EnvelopeConformanceTests.cs), so a TypeScript
// node and a .NET node can share one Redis channel: each decodes what the other
// encodes, and both still read the legacy shapes for one release.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BackplaneMessage } from "@mekik/core";

import {
    decodeBackplaneMessage,
    encodeBackplaneMessage,
    RedisBackplane,
    type RedisClient,
} from "../src/index.ts";

interface Fixture {
    encode: { name: string; message: BackplaneMessage; wire: string }[];
    decode: { name: string; payload: string; expect: BackplaneMessage | null }[];
}

const fixture = JSON.parse(
    readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../../../../conformance/redis/envelope.json"),
        "utf8",
    ),
) as Fixture;

describe("backplane envelope (conformance/redis/envelope.json)", () => {
    test("the fixture is populated", () => {
        assert.ok(fixture.encode.length > 0 && fixture.decode.length > 0);
    });

    for (const c of fixture.encode) {
        test(`encode: ${c.name} → the canonical camelCase wire`, () => {
            assert.equal(encodeBackplaneMessage(c.message), c.wire);
        });
        test(`decode: ${c.name}'s wire round-trips`, () => {
            assert.deepEqual(decodeBackplaneMessage(c.wire), c.message);
        });
    }

    for (const c of fixture.decode) {
        test(`decode: ${c.name}`, () => {
            assert.deepEqual(decodeBackplaneMessage(c.payload), c.expect);
        });
    }

    test("a .NET-encoded envelope (canonical and legacy) fans out the frame, never undefined", async () => {
        const handlers = new Set<(channel: string, message: string) => void>();
        const sub = {
            subscribe: async () => 1,
            unsubscribe: async () => 1,
            on: (_e: "message", l: (c: string, m: string) => void) => handlers.add(l),
            off: (_e: "message", l: (c: string, m: string) => void) => handlers.delete(l),
            quit: async () => "OK",
        } as unknown as RedisClient;
        const bp = new RedisBackplane({} as RedisClient, { subscriber: sub });
        const got: BackplaneMessage[] = [];
        await bp.subscribe("c", (m) => got.push(m));

        const net = fixture.encode.find((c) => c.name === ".NET node")!;
        const legacy = fixture.decode.find((c) => c.name.startsWith("PascalCase"))!;
        for (const payload of [net.wire, legacy.payload, ...fixture.decode.filter((c) => c.expect === null).map((c) => c.payload)]) {
            for (const h of handlers) h("mekik:bp:c", payload);
        }

        assert.deepEqual(got, [net.message, legacy.expect]);
        assert.ok(got.every((m) => typeof m.frame === "object" && m.frame !== null));
    });
});
