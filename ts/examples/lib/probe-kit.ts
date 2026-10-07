// The shared plumbing behind the domain probes (banking/, insurance/,
// healthcare-triage/, travel-booking/, support-desk/).
//
// Each probe drives a real mekik app over an in-memory connection and asserts
// its frame stream, the same way refund.ts and routed-desk.ts --probe do. What
// is shared here is only the boring part:
//
//   ScriptedModel  the model seam — per-node queues of scripted decisions, plus
//                  a record of what each node's model was shown (its toolbox,
//                  its system prompt, every tool observation it read), so a
//                  probe can assert what the model saw as well as what the
//                  wire carried.
//   runTools       the model↔tool loop routed-desk.ts uses, over any
//                  StructuredToolInterface[] — each decision journaled with
//                  ctx.step, tool errors turned into observations, pauses
//                  rethrown untouched.
//   Collector, check, describe, …  frame capture and the ✓-line output style.
//
// Nothing in here talks to a network or a real model.

import type { Context } from "@ilmek/core";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";

import type { Connection, ErrorFrame, OutgoingFrame, RunFrame, SkillFrame, SkillsFrame, TextOutFrame, WelcomeFrame } from "@mekik/core";

// ── the model seam ────────────────────────────────────────────────────────────

export interface PlannedCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
}

/** One model turn: either prose (no tool calls) or a set of tool calls. */
export interface Decision {
    text: string;
    toolCalls: PlannedCall[];
}

let callSeq = 0;

/** A scripted model turn that answers in prose. */
export function say(text: string): Decision {
    return { text, toolCalls: [] };
}

/** A scripted model turn that calls one tool. */
export function call(name: string, args: Record<string, unknown> = {}): Decision {
    return { text: "", toolCalls: [{ id: `call-${name}-${++callSeq}`, name, args }] };
}

/**
 * A stand-in for a tool-calling chat model. Scripts are keyed by node name, so a
 * probe mirrors the graph rather than one flat list; each node consumes its own
 * queue in order. It also records what it was shown, per node.
 */
export class ScriptedModel {
    private scripts: Record<string, Decision[]> = {};
    private readonly cursors: Record<string, number> = {};
    /** The tool names each node bound, the last time it asked the model. */
    readonly toolboxes: Record<string, string[]> = {};
    /** The system prompt each node sent, the last time it asked. */
    readonly systems: Record<string, string> = {};
    /** Every tool observation the model has read, per node, across the probe. */
    readonly observations: Record<string, string[]> = {};
    /** How many times the model was actually asked (journaled replays do not count). */
    asked = 0;

    /** Replace every node's script and rewind the cursors. */
    load(scripts: Record<string, Decision[]>): void {
        this.scripts = scripts;
        for (const k of Object.keys(this.cursors)) delete this.cursors[k];
    }

    async decide(node: string, tools: StructuredToolInterface[], messages: BaseMessage[]): Promise<Decision> {
        this.asked++;
        this.toolboxes[node] = tools.map((t) => t.name);
        const sys = messages[0];
        if (sys instanceof SystemMessage) this.systems[node] = String(sys.content);
        const seen = (this.observations[node] ??= []);
        // The observations since the model's previous turn are the trailing ToolMessages.
        for (let i = messages.length - 1; i >= 0 && messages[i] instanceof ToolMessage; i--) {
            seen.push(String(messages[i]!.content));
        }
        const i = this.cursors[node] ?? 0;
        this.cursors[node] = i + 1;
        return this.scripts[node]?.[i] ?? say("(script exhausted)");
    }

    /** A one-word classification, journaled by the caller — the router-node seam. */
    async classify(node: string): Promise<string> {
        const d = await this.decide(node, [], [new SystemMessage("classify"), new HumanMessage("")]);
        return d.text.trim().toLowerCase();
    }
}

/** What one {@link runTools} loop produced. */
export interface LoopResult {
    /** The model's final prose. */
    text: string;
    /** The last successful result of each tool the model called, by tool name (journaled values on replay). */
    results: Record<string, unknown>;
    /** Every tool the model called, in order, with whether it errored. */
    calls: Array<{ name: string; ok: boolean }>;
}

/**
 * The model↔tool loop each domain node runs over its own tools. Each decision
 * runs inside `ctx.step` (namespaced per node), so a resume replays the
 * recorded decision instead of asking again; a tool that throws becomes an
 * `Error: …` observation the model can read and route around; a pause
 * propagates untouched, because it is the mechanism, not a failure.
 */
export async function runTools(
    ctx: Context<any>,
    model: ScriptedModel,
    node: string,
    tools: StructuredToolInterface[],
    system: string,
    input: string,
    maxTurns = 8,
): Promise<LoopResult> {
    const byName = new Map(tools.map((t) => [t.name, t]));
    const messages: BaseMessage[] = [new SystemMessage(system), new HumanMessage(input)];
    const results: Record<string, unknown> = {};
    const calls: LoopResult["calls"] = [];

    for (let turn = 0; turn < maxTurns; turn++) {
        const decision = await ctx.step(`${node}:llm:${turn}`, () => model.decide(node, tools, messages));
        messages.push(
            new AIMessage({
                content: decision.text,
                tool_calls: decision.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
            }),
        );
        if (decision.toolCalls.length === 0) return { text: decision.text, results, calls };

        for (const c of decision.toolCalls) {
            const t = byName.get(c.name);
            let observation: string;
            try {
                if (!t) throw new Error(`Unknown tool ${c.name}.`);
                const result: unknown = await t.invoke(c.args as never);
                results[c.name] = result;
                calls.push({ name: c.name, ok: true });
                observation = typeof result === "string" ? result : JSON.stringify(result);
            } catch (err) {
                if (isInterruptLike(err)) throw err;
                calls.push({ name: c.name, ok: false });
                observation = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
            messages.push(new ToolMessage({ tool_call_id: c.id, content: observation }));
        }
    }
    return { text: "I ran out of steps before I could finish that.", results, calls };
}

/** ilmek signals a pause by throwing a non-`Error` value; never swallow it. */
export function isInterruptLike(err: unknown): boolean {
    return typeof err === "object" && err !== null && "key" in err && "payload" in err && !(err instanceof Error);
}

// ── frame capture ─────────────────────────────────────────────────────────────

/** An in-memory `Connection`: records every frame the engine sends it. */
export class Collector implements Connection {
    readonly id: string;
    readonly frames: OutgoingFrame[] = [];
    /** Everything this connection ever received, never drained — the whole wire. */
    readonly wire: OutgoingFrame[] = [];
    constructor(id = "conn-probe") {
        this.id = id;
    }
    send(frame: OutgoingFrame): void {
        this.frames.push(frame);
        this.wire.push(frame);
    }
    close(): void {}
    /** Frames captured since the last drain, then cleared — one turn's worth. */
    drain(): OutgoingFrame[] {
        return this.frames.splice(0, this.frames.length);
    }
}

export type ToolFrame = Extract<OutgoingFrame, { type: "tool_call" }>;
export type InterruptFrame = Extract<OutgoingFrame, { type: "interrupt" }>;
export type GenuiFrame = Extract<OutgoingFrame, { type: "genui" }>;
export type UiChunk = { type: "ui"; component: string; props?: Record<string, unknown>; id?: string | number };

export function traces(frames: OutgoingFrame[], name?: string): ToolFrame[] {
    return frames.filter((f): f is ToolFrame => f.type === "tool_call" && (name === undefined || f.data.name === name));
}

/** The tool names traced in these frames (each call once, however many status updates it had). */
export function toolNames(frames: OutgoingFrame[]): string[] {
    const seen = new Map<string, string>();
    for (const f of traces(frames)) seen.set(f.data.id, f.data.name);
    return [...seen.values()];
}

export function uiChunks(frames: OutgoingFrame[], component?: string): UiChunk[] {
    return frames.flatMap((f) =>
        f.type === "genui" && "chunk" in f && f.chunk.type === "ui" && (component === undefined || f.chunk.component === component)
            ? [f.chunk as UiChunk]
            : [],
    );
}

export function interrupts(frames: OutgoingFrame[]): InterruptFrame[] {
    return frames.filter((f): f is InterruptFrame => f.type === "interrupt");
}

// A rich message frame's `type` is an open string (PROTOCOL.md §4.5), so the
// discriminant alone does not narrow the union: these finders cast after matching.

export function botText(frames: OutgoingFrame[]): string | undefined {
    const f = frames.find((x) => x.type === "text" && x.from === "bot") as TextOutFrame | undefined;
    return f?.data.text;
}

export function runStatus(frames: OutgoingFrame[]): string | undefined {
    const f = [...frames].reverse().find((x) => x.type === "run") as RunFrame | undefined;
    return f?.data.status;
}

export function errorCode(frames: OutgoingFrame[]): string | undefined {
    const f = frames.find((x) => x.type === "error") as ErrorFrame | undefined;
    return f?.data.code;
}

export function welcomeOf(frames: OutgoingFrame[]): WelcomeFrame | undefined {
    return frames.find((x) => x.type === "welcome") as WelcomeFrame | undefined;
}

export function skillsCatalog(frames: OutgoingFrame[]): SkillsFrame | undefined {
    return frames.find((x) => x.type === "skills") as SkillsFrame | undefined;
}

export function skillUses(frames: OutgoingFrame[]): SkillFrame[] {
    return frames.filter((x) => x.type === "skill") as SkillFrame[];
}

/** The persistent `seq` of a frame, if it has one. */
export function seqOf(frame: OutgoingFrame): number | undefined {
    const s = (frame as { seq?: unknown }).seq;
    return typeof s === "number" ? s : undefined;
}

// ── output ────────────────────────────────────────────────────────────────────

export function check(cond: unknown, msg: string): void {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
    console.log(`     ✓ ${msg}`);
}

export function section(title: string): void {
    console.log(`\n${title}`);
}

export function user(text: string): void {
    console.log(`   user: ${text}`);
}

/** Print a turn's frames the way routed-desk.ts does. */
export function describe(frames: OutgoingFrame[]): void {
    for (const f of frames) {
        if (f.type === "tool_call") {
            const d = f.data;
            if (d.status === "running") console.log(`  → ${d.name} ${truncate(JSON.stringify(d.params ?? {}))}`);
            else if (d.status === "error") console.log(`  ✗ ${d.name} error: ${d.error}`);
            else console.log(`  ← ${d.name} ${truncate(JSON.stringify(d.result ?? null))}`);
        } else if (f.type === "skill") {
            const d = (f as SkillFrame).data;
            console.log(`  ✦ skill ${d.name} ${d.status}`);
        } else if (f.type === "genui" && "chunk" in f && f.chunk.type === "ui") {
            console.log(`  ▦ ${f.chunk.component}`);
        } else if (f.type === "interrupt") {
            const d = (f as InterruptFrame).data;
            const tool = d.tool ? ` (client tool ${d.tool.name})` : "";
            console.log(`  ⏸ interrupt${tool} ${truncate(JSON.stringify(d.payload))}`);
        } else if (f.type === "interrupt_resolved") {
            console.log(`  ▶ resolved`);
        } else if (f.type === "text" && f.from === "bot") {
            console.log(`  bot: ${f.data.text}`);
        } else if (f.type === "error") {
            console.log(`  error ${f.data.code}: ${f.data.message ?? ""}`);
        }
    }
}

export function truncate(s: string, max = 140): string {
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Run a probe as the process entry point: exit 0 on success, 1 with the failure. */
export function main(probe: () => Promise<void>): void {
    probe().then(
        () => process.exit(0),
        (err: unknown) => {
            console.error("\n❌ probe failed:\n", err);
            process.exit(1);
        },
    );
}
