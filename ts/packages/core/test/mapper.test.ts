// Focused unit tests for TurnMapper's chunk-id assignment — the part the golden
// fixtures exercise only in passing. The contract (PROTOCOL.md §4.1): consecutive
// streamed text deltas share ONE chunk id so a client renders a single growing
// bubble, while a ui/event chunk closes that text run so the next text delta opens
// a fresh bubble. This is what stops token-by-token output rendering as one message
// per token in a client that keys bubbles by chunk id (e.g. chativa).

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import type { IlmekEvent } from "@ilmek/core";

import { eventToFrames, type IdMinter, type TurnMapperDeps } from "../src/mapper.ts";
import type { GenUIFrame, OutgoingFrame } from "../src/protocol.ts";

function deps(): TurnMapperDeps {
    let seq = 0;
    let stream = 0;
    let msg = 0;
    const mint: IdMinter = { message: () => `msg-${++msg}`, stream: () => `stream-${++stream}` };
    return { allocSeq: () => ++seq, mint, now: () => 0 };
}

const runStart = { type: "run_start" } as unknown as IlmekEvent;
const runDone = { type: "run_end", status: "done", state: {} } as unknown as IlmekEvent;
const token = (text: string) => ({ type: "custom", payload: { type: "token", text } }) as unknown as IlmekEvent;
const uiChunk = (component: string) =>
    ({ type: "custom", payload: { $mekik: "genui", chunk: { type: "ui", component } } }) as unknown as IlmekEvent;
const textChunk = (content: string) =>
    ({ type: "custom", payload: { $mekik: "genui", chunk: { type: "text", content } } }) as unknown as IlmekEvent;

/** The genui frames of a run, in order — the only ones that carry a chunk id. */
function genui(frames: OutgoingFrame[]): GenUIFrame[] {
    return frames.filter((f): f is GenUIFrame => f.type === "genui");
}

describe("TurnMapper — chunk id coalescing", () => {
    test("consecutive token deltas share one chunk id; stream_done takes its own", () => {
        const frames = genui(eventToFrames([runStart, token("Hel"), token("lo"), runDone], deps()));

        assert.deepEqual(
            frames.map((f) => ({ content: (f.chunk as { content?: string; name?: string }).content ?? f.chunk.type, id: f.chunk.id })),
            [
                { content: "Hel", id: 1 },
                { content: "lo", id: 1 }, // same id → one growing bubble, not two
                { content: "event", id: 2 }, // stream_done closes the run with a fresh id
            ],
        );
    });

    test("a ui chunk closes the text run, so the next delta opens a fresh bubble", () => {
        const frames = genui(
            eventToFrames([runStart, token("A"), token("B"), uiChunk("order-card"), token("C"), runDone], deps()),
        );

        assert.deepEqual(
            frames.map((f) => f.chunk.id),
            [1, 1, 2, 3, 4],
            // A,B share run id 1; the ui card takes 2; C starts a new run at 3; stream_done is 4.
        );
    });

    test("mekik.text deltas coalesce the same way as raw tokens", () => {
        const frames = genui(eventToFrames([runStart, textChunk("Pro"), textChunk("cessing"), runDone], deps()));

        assert.deepEqual(
            frames.slice(0, 2).map((f) => f.chunk.id),
            [1, 1],
        );
    });
});
