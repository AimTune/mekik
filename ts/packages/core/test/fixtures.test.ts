// The golden-fixture runner (conformance/README.md). Every fixture in
// conformance/fixtures replays through `eventToFrames` with the deterministic
// injectors, and the output must match `expectedFrames` byte-for-byte after
// canonicalization. This is the contract the .NET port is held to as well.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { IlmekEvent } from "@ilmek/core";

import { canonicalize } from "../src/protocol.ts";
import { eventToFrames, type IdMinter, type TurnMapperDeps } from "../src/mapper.ts";

const FIXED_CLOCK = 1750000000000;

interface Fixture {
    name: string;
    description?: string;
    startSeq: number;
    replyChannel?: string;
    events: unknown[];
    expectedFrames: unknown[];
}

/** The deterministic environment from conformance/README.md, re-created per fixture. */
function deterministicDeps(startSeq: number, replyChannel?: string): TurnMapperDeps {
    let seq = startSeq;
    let msg = 0;
    let stream = 0;
    const mint: IdMinter = {
        message: () => `msg-${++msg}`,
        stream: () => `stream-${++stream}`,
    };
    const base: TurnMapperDeps = { allocSeq: () => ++seq, mint, now: () => FIXED_CLOCK };
    if (replyChannel !== undefined) {
        return { ...base, reply: (state) => state[replyChannel] as string | undefined };
    }
    return base;
}

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../conformance/fixtures");
const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));

describe("golden fixtures", () => {
    assert.ok(files.length > 0, "no fixtures found - check the conformance/fixtures path");

    for (const file of files) {
        const fixture = JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as Fixture;

        test(`${fixture.name} (${file})`, () => {
            const deps = deterministicDeps(fixture.startSeq, fixture.replyChannel);
            const actual = eventToFrames(fixture.events as IlmekEvent[], deps);

            assert.equal(
                actual.length,
                fixture.expectedFrames.length,
                `frame count: got ${actual.length}, expected ${fixture.expectedFrames.length}\n` +
                    `actual: ${JSON.stringify(actual, null, 2)}`,
            );

            for (let i = 0; i < actual.length; i++) {
                assert.equal(
                    canonicalize(actual[i]),
                    canonicalize(fixture.expectedFrames[i]),
                    `frame[${i}] mismatch in ${fixture.name}`,
                );
            }
        });
    }
});
