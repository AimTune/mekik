// Regenerate the `expectedFrames` of every golden fixture from the TS reference
// mapper (conformance/README.md: "generated once by the TS reference,
// hand-reviewed, committed"). Run after an intentional mapping change:
//
//   node scripts/gen-fixtures.ts          # dry run — prints which fixtures would change
//   node scripts/gen-fixtures.ts --write  # rewrite expectedFrames in place
//
// The .NET suite then reruns the committed fixtures unchanged; if this script
// changes a fixture, that IS the wire-breaking change under review.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { IlmekEvent } from "@ilmek/core";

import { canonicalize } from "../src/protocol.ts";
import { eventToFrames, type IdMinter, type TurnMapperDeps } from "../src/mapper.ts";

const FIXED_CLOCK = 1750000000000;
const WRITE = process.argv.includes("--write");

interface Fixture {
    name: string;
    description?: string;
    startSeq: number;
    replyChannel?: string;
    events: unknown[];
    expectedFrames: unknown[];
}

function deterministicDeps(startSeq: number, replyChannel?: string): TurnMapperDeps {
    let seq = startSeq;
    let msg = 0;
    let stream = 0;
    const mint: IdMinter = { message: () => `msg-${++msg}`, stream: () => `stream-${++stream}` };
    const base: TurnMapperDeps = { allocSeq: () => ++seq, mint, now: () => FIXED_CLOCK };
    return replyChannel !== undefined
        ? { ...base, reply: (state) => state[replyChannel] as string | undefined }
        : base;
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../../conformance/fixtures");
let changed = 0;

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const path = join(dir, file);
    const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
    const deps = deterministicDeps(fixture.startSeq, fixture.replyChannel);
    const regenerated = eventToFrames(fixture.events as IlmekEvent[], deps);

    if (canonicalize(regenerated) === canonicalize(fixture.expectedFrames)) continue;

    changed++;
    console.log(`${WRITE ? "updated" : "would change"}: ${file}`);
    if (WRITE) {
        fixture.expectedFrames = regenerated;
        writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n");
    }
}

console.log(changed === 0 ? "all fixtures up to date" : `${changed} fixture(s) ${WRITE ? "rewritten" : "differ — rerun with --write"}`);
if (!WRITE && changed > 0) process.exit(1);
