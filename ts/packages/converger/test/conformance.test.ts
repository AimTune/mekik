// The compatibility guard (conformance/converger/refund.json): the refund example
// behind a fake Converger must put on the wire, inside the `{conversationId, frame}`
// envelope, exactly the frames a direct @mekik/ws client receives.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

import { WebSocket } from "ws";

import { canonicalize, externalTranscript, InMemoryConversationStore } from "@mekik/core";
import { serveWs } from "@mekik/ws";

import { connectConverger } from "../src/index.ts";
import { FakeHub } from "./fake-hub.ts";
import { makeRefundApp } from "./refund-app.ts";

interface Step {
    send: Record<string, unknown>;
    until: { type: string; status?: string };
}

interface Scenario {
    conversationId: string;
    userId: string;
    clock: number;
    greeting: string;
    steps: Step[];
    normalize: { pattern: string };
}

const scenario = JSON.parse(
    readFileSync(new URL("../../../../conformance/converger/refund.json", import.meta.url), "utf8"),
) as Scenario;

type Frame = Record<string, unknown>;

const matches = (until: Step["until"]) => (f: Frame) =>
    f.type === until.type && (until.status === undefined || (f.data as { status?: unknown } | undefined)?.status === until.status);

/** Replace `$interrupt` keys with the id of the last interrupt seen. */
function resolve(frame: Frame, seen: Frame[]): Frame {
    const last = [...seen].reverse().find((f) => f.type === "interrupt");
    const json = JSON.stringify(frame).replaceAll("$interrupt", String(last?.id ?? ""));
    return JSON.parse(json) as Frame;
}

/** Canonical JSON with ilmek's checkpoint ids renamed by first appearance (the scenario's `normalize` rule). */
function normalized(frames: Frame[]): string[] {
    const names = new Map<string, string>();
    const pattern = new RegExp(scenario.normalize.pattern, "g");
    return frames.map((f) =>
        canonicalize(f).replace(pattern, (id) => {
            if (!names.has(id)) names.set(id, `ckpt-${names.size + 1}`);
            return names.get(id)!;
        }),
    );
}

async function waitFor(cond: () => boolean, label: string): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

/** Every step over a direct mekik/1 socket; the frames after `welcome`. */
async function directRun(): Promise<Frame[]> {
    const conversations = new InMemoryConversationStore();
    await conversations.create({ conversationId: scenario.conversationId, userId: scenario.userId, createdAt: 0, meta: {} });
    const handle = serveWs(makeRefundApp(scenario.greeting, scenario.clock, { conversations }), { port: 0 });
    await new Promise<void>((r) => (handle.server.listening ? r() : handle.server.once("listening", () => r())));
    const ws = new WebSocket(`ws://127.0.0.1:${(handle.server.address() as AddressInfo).port}/ws`);
    const frames: Frame[] = [];
    ws.on("message", (raw: Buffer) => frames.push(JSON.parse(raw.toString()) as Frame));
    await new Promise((r) => ws.once("open", r));
    try {
        ws.send(JSON.stringify({ type: "hello", userId: scenario.userId, conversationId: scenario.conversationId }));
        await waitFor(() => frames.some((f) => f.type === "welcome"), "welcome");
        const welcome = frames.find((f) => f.type === "welcome")!;
        assert.equal((welcome.data as { conversationId: string }).conversationId, scenario.conversationId);
        for (const step of scenario.steps) {
            const before = frames.length;
            ws.send(JSON.stringify(resolve(step.send, frames)));
            await waitFor(() => frames.slice(before).some(matches(step.until)), `direct ${JSON.stringify(step.until)}`);
        }
        await new Promise((r) => setTimeout(r, 50));
        return frames.filter((f) => f.type !== "welcome");
    } finally {
        ws.close();
        await handle.close();
    }
}

/** Every step through a fake hub; the inner frames of the conversation's envelopes. */
async function hubRun(): Promise<Frame[]> {
    const hub = await FakeHub.start();
    const app = makeRefundApp(scenario.greeting, scenario.clock, externalTranscript());
    const transport = connectConverger(app, { url: hub.url, token: "channel-token" });
    try {
        await transport.ready;
        const frames = () => hub.framesOf(scenario.conversationId);
        for (const step of scenario.steps) {
            const before = frames().length;
            const send = resolve(step.send, frames());
            if (send.type === "text") hub.userTurn(scenario.conversationId, (send.data as { text: string }).text);
            else hub.forward(scenario.conversationId, send);
            await hub.waitFor(() => frames().slice(before).some(matches(step.until)), `hub ${JSON.stringify(step.until)}`);
        }
        await new Promise((r) => setTimeout(r, 50));
        return frames();
    } finally {
        await transport.close();
        await hub.close();
    }
}

test("conformance: the refund example behind a hub puts the direct run's frames in the envelope", async () => {
    const direct = await directRun();
    const behindHub = await hubRun();

    // Sanity: the scenario really exercised the example.
    const types = direct.map((f) => f.type);
    for (const t of ["text", "tool_call", "genui", "interrupt", "error", "interrupt_resolved", "run"]) assert.ok(types.includes(t), `direct run has ${t}`);
    assert.ok(!direct.some((f) => f.type === "text" && f.from === "user"), "the sender never sees its own turn");

    assert.deepEqual(normalized(behindHub), normalized(direct));
});
