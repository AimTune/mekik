// The same desk as concierge.ts, but as a **graph** instead of one big node.
//
// concierge.ts puts every tool in a single node and lets the model route by
// picking tools. That works, and it is the shape most agent frameworks give you.
// This example shows what ilmek is actually for: a router node classifies the
// turn, each domain gets its own node with only its own tools, and the
// human-in-the-loop pause is a node of its own rather than a tool policy.
//
//     START → route ─┬→ analytics ────────────────────────────────→ END
//                    ├→ weather ──────────────────────────────────→ END
//                    ├→ refund_lookup → refund_approve ─┬→ refund_execute → END
//                    │                    (interrupt)   └→ END  (declined)
//                    └→ chat ─────────────────────────────────────→ END
//
// Three things fall out of the split that the single-node version cannot get:
//
//   1. Each node binds ~3 tools instead of ~7. Smaller tool sets measurably
//      improve tool choice, and the policy map becomes per-node and readable.
//   2. The pause is an explicit node. `refund_approve` is where the graph parks,
//      so approval is visible in the graph's shape, not buried in a tool's policy.
//   3. **Resume replays one node, not the whole turn.** In concierge.ts the
//      approval sits inside the node that already ran the lookup, so resuming
//      re-emits the lookup's `tool_call` frames for a query that never re-ran.
//      Here the lookup lives in a node that already completed, so it is neither
//      re-run NOR re-emitted. The probe asserts exactly this difference.
//
//   ANTHROPIC_API_KEY=sk-ant-… node examples/routed-desk.ts          # live model
//   ANTHROPIC_API_KEY=sk-ant-… node examples/routed-desk.ts --serve  # server on :8805
//   node examples/routed-desk.ts --probe                             # no key, no network

import { channel, command, graph, END, START } from "@ilmek/core";
import type { Context } from "@ilmek/core";
import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { mekik } from "@mekik/core";
import type { Connection, OutgoingFrame } from "@mekik/core";
import { withMekikTools } from "@mekik/langchain";
import { serveWs } from "@mekik/ws";

import { SqlDatabase, SqlToolkit } from "./lib/sql-toolkit.ts";
import type { Row } from "./lib/sql-toolkit.ts";

// ── the shop ──────────────────────────────────────────────────────────────────

const db = SqlDatabase.fromSchema(`
    CREATE TABLE customers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, tier TEXT NOT NULL
    );
    CREATE TABLE orders (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, placed_on TEXT NOT NULL,
        status TEXT NOT NULL, ships_to TEXT NOT NULL, total_cents INTEGER NOT NULL
    );
    CREATE TABLE refunds (
        order_id TEXT PRIMARY KEY, amount_cents INTEGER NOT NULL, refunded_on TEXT NOT NULL
    );

    INSERT INTO customers VALUES
        ('CUS-1', 'Ada Lovelace', 'ada@example.com',   'gold'),
        ('CUS-2', 'Grace Hopper', 'grace@example.com', 'gold');

    INSERT INTO orders VALUES
        ('ORD-1', 'CUS-1', '2026-07-19', 'delivered', 'Istanbul', 24990),
        ('ORD-3', 'CUS-2', '2026-07-21', 'delayed',   'Berlin',   62430);
`);

const sideEffects = { issue_refund: 0 };

const PRIVATE_COLUMNS = ["email"] as const;

function maskRows(rows: Row[]): Row[] {
    return rows.map((row) => {
        const out: Row = { ...row };
        for (const col of PRIVATE_COLUMNS) if (col in out) out[col] = "«redacted»";
        return out;
    });
}

// ── the weather API (swappable, so the probe never touches the network) ───────

type Fetcher = (url: string) => Promise<unknown>;

let fetchJson: Fetcher = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${new URL(url).host} replied ${res.status}`);
    return res.json();
};

const WMO: Record<number, string> = {
    0: "clear", 2: "partly cloudy", 3: "overcast", 61: "light rain", 63: "rain", 95: "thunderstorm",
};

// ── per-node tool sets ────────────────────────────────────────────────────────

/** Shop analytics: the toolkit's tools, wrapped. Used by `analytics` and `refund_lookup`. */
function shopTools(ctx: Context<any>): StructuredToolInterface[] {
    const toolkit = new SqlToolkit(db, {
        onRows: ({ columns, rows, sql }) =>
            mekik.ui(ctx, "data-table", { columns, rows: maskRows(rows), sql }),
    });
    return withMekikTools(ctx, toolkit.getTools(), {
        "list-tables-sql": { show: false },
        "info-sql": { show: true },
        "query-sql": { show: true, redact: ["email"] },
    });
}

function weatherTools(ctx: Context<any>): StructuredToolInterface[] {
    const geocode = tool(
        async ({ city }) => {
            const body = (await fetchJson(
                `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&format=json`,
            )) as { results?: Array<Record<string, unknown>> };
            const hit = body.results?.[0];
            if (!hit) throw new Error(`No place called "${city}".`);
            return { name: hit.name, latitude: hit.latitude, longitude: hit.longitude };
        },
        {
            name: "geocode_city",
            description: "Resolve a place name to coordinates. get_forecast needs these.",
            schema: z.object({ city: z.string() }),
        },
    );

    const forecast = tool(
        async ({ label, latitude, longitude }) => {
            const body = (await fetchJson(
                `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
                    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum` +
                    `&forecast_days=3&timezone=auto`,
            )) as { daily?: Record<string, unknown[]> };
            const time = body.daily?.time as string[] | undefined;
            if (!time?.length) throw new Error("The forecast service returned no daily data.");
            const days = time.map((date, i) => ({
                date,
                summary: WMO[(body.daily?.weather_code as number[])?.[i] ?? -1] ?? "unknown",
                high: (body.daily?.temperature_2m_max as number[])?.[i] ?? null,
                low: (body.daily?.temperature_2m_min as number[])?.[i] ?? null,
                precipitationMm: (body.daily?.precipitation_sum as number[])?.[i] ?? null,
            }));
            mekik.ui(ctx, "weather-card", { place: label, days });
            return { place: label, days };
        },
        {
            name: "get_forecast",
            description: "Daily forecast for one set of coordinates. Celsius.",
            schema: z.object({ label: z.string(), latitude: z.number(), longitude: z.number() }),
        },
    );

    return withMekikTools(ctx, [geocode, forecast], {
        geocode_city: { show: false },
        get_forecast: { show: true },
    });
}

/** The only tool that moves money. No approval policy here — the graph owns the pause. */
function refundTools(ctx: Context<any>): StructuredToolInterface[] {
    const issue = tool(
        ({ orderId, amountCents }) => {
            sideEffects.issue_refund++;
            db.db.prepare("INSERT OR REPLACE INTO refunds VALUES (?, ?, ?)").run(orderId, amountCents, "2026-07-21");
            db.db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(orderId);
            return { orderId, refundedDollars: amountCents / 100 };
        },
        {
            name: "issue_refund",
            description: "Refund an order and mark it refunded.",
            schema: z.object({ orderId: z.string(), amountCents: z.number() }),
        },
    );
    return withMekikTools(ctx, [issue], { issue_refund: { show: true } });
}

// ── the model seam ────────────────────────────────────────────────────────────

interface Decision {
    text: string;
    toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

export type Route = "analytics" | "weather" | "refund" | "chat";

/** Both seams are swapped wholesale by `--probe`; nothing downstream changes. */
type Decide = (tools: StructuredToolInterface[], messages: BaseMessage[], node: string) => Promise<Decision>;
type Classify = (input: string) => Promise<Route>;

let llmSingleton: ChatAnthropic | undefined;
function model(): ChatAnthropic {
    llmSingleton ??= new ChatAnthropic({ model: "claude-opus-4-8", maxTokens: 2048 });
    return llmSingleton;
}

const ROUTER_PROMPT = [
    "Classify the user's message into exactly one of: analytics, weather, refund, chat.",
    "analytics = questions about orders, customers, revenue or the shop's data.",
    "weather = questions about the weather or forecasts.",
    "refund = the user wants money back for a specific order.",
    "chat = anything else, including greetings.",
    "Reply with the single word and nothing else.",
].join(" ");

const askClaude: Decide = async (tools, messages) => {
    const ai = await model().bindTools(tools).invoke(messages);
    return {
        text: typeof ai.content === "string" ? ai.content : textOf(ai),
        toolCalls: (ai.tool_calls ?? []).map((c) => ({
            id: c.id ?? "",
            name: c.name,
            args: c.args as Record<string, unknown>,
        })),
    };
};

const classifyWithClaude: Classify = async (input) => {
    const ai = await model().invoke([new SystemMessage(ROUTER_PROMPT), new HumanMessage(input)]);
    const word = (typeof ai.content === "string" ? ai.content : textOf(ai)).trim().toLowerCase();
    const match = (["analytics", "weather", "refund", "chat"] as const).find((r) => word.startsWith(r));
    return match ?? "chat"; // an unclassifiable turn is small talk, not an error
};

let decide: Decide = askClaude;
let classify: Classify = classifyWithClaude;

/** The tool loop each domain node runs, over its own tools only. */
async function runTools(
    ctx: Context<any>,
    node: string,
    tools: StructuredToolInterface[],
    system: string,
    input: string,
    maxTurns = 8,
): Promise<string> {
    const byName = new Map(tools.map((t) => [t.name, t]));
    const messages: BaseMessage[] = [new SystemMessage(system), new HumanMessage(input)];

    for (let turn = 0; turn < maxTurns; turn++) {
        // Journal keys are namespaced per node, so two nodes that both call the
        // model in the same run cannot collide.
        const decision = await ctx.step(`${node}:llm:${turn}`, () => decide(tools, messages, node));

        messages.push(
            new AIMessage({
                content: decision.text,
                tool_calls: decision.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
            }),
        );

        if (decision.toolCalls.length === 0) return decision.text || "(no reply)";

        for (const call of decision.toolCalls) {
            const t = byName.get(call.name);
            let observation: string;
            try {
                const result = t ? await t.invoke(call.args as never) : `Unknown tool ${call.name}.`;
                observation = typeof result === "string" ? result : JSON.stringify(result);
            } catch (err) {
                if (isInterruptLike(err)) throw err;
                observation = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
            messages.push(new ToolMessage({ tool_call_id: call.id, content: observation }));
        }
    }
    return "I ran out of steps before I could answer that.";
}

// ── the graph ─────────────────────────────────────────────────────────────────

const ANALYTICS_SYSTEM =
    "You are a shop data analyst. Discover the schema with list-tables-sql and info-sql, then query it. " +
    "Money is stored in cents — report dollars. Answer in one or two sentences; the rows are already shown as a table.";

const WEATHER_SYSTEM =
    "You are a weather assistant. Resolve places with geocode_city before calling get_forecast. " +
    "Answer in one or two sentences; the forecast is already shown as a card.";

const LOOKUP_SYSTEM =
    "Find the order the user is asking to refund. Use query-sql to read its id and total_cents from `orders`. " +
    "Then reply with ONLY the order id and the amount in cents, like: ORD-3 62430";

const EXECUTE_SYSTEM =
    "Call issue_refund with the order id and amount you are given, then confirm it in one short sentence.";

const desk = graph("routed-desk")
    .channel("input", channel.lastWrite<string>(""))
    .channel("route", channel.lastWrite<string>("chat"))
    .channel("orderId", channel.lastWrite<string>(""))
    .channel("amountCents", channel.lastWrite<number>(0))
    .channel("reply", channel.lastWrite<string>(""))

    // 1. Router — one cheap classification, then a dynamic goto. This is the
    //    node that makes the graph a graph.
    .node("route", async (s, ctx) => {
        const route = await ctx.step("route:classify", () => classify(s.input));
        return command({ update: { route }, goto: route === "refund" ? "refund_lookup" : route });
    })

    // 2. Leaf domains — each sees only its own tools.
    .node("analytics", async (s, ctx) => ({
        reply: await runTools(ctx, "analytics", shopTools(ctx), ANALYTICS_SYSTEM, s.input),
    }))
    .node("weather", async (s, ctx) => ({
        reply: await runTools(ctx, "weather", weatherTools(ctx), WEATHER_SYSTEM, s.input),
    }))
    .node("chat", async (s) => ({
        reply: `I can look up orders and revenue, check the weather, or refund an order. (You said: "${s.input}")`,
    }))

    // 3. Refund, as three nodes. The split is the point: by the time the graph
    //    parks, this node has already completed and been checkpointed.
    .node("refund_lookup", async (s, ctx) => {
        const found = await runTools(ctx, "refund_lookup", shopTools(ctx), LOOKUP_SYSTEM, s.input);
        const m = /(ORD-\d+)\D+(\d+)/.exec(found);
        if (!m) {
            return command({ update: { reply: `I could not find that order. ${found}` }, goto: END });
        }
        return command({ update: { orderId: m[1]!, amountCents: Number(m[2]) }, goto: "refund_approve" });
    })

    // 4. The pause, as a node of its own. Nothing else happens here, so a resume
    //    replays only this — no tool re-runs, no duplicated tool_call frames.
    .node("refund_approve", async (s, ctx) => {
        const answer = await mekik.approve<{ approved: boolean }>(
            ctx,
            { title: `Refund $${(s.amountCents / 100).toFixed(2)} for ${s.orderId}?`, tool: "issue_refund" },
            {
                ui: {
                    component: "approval-form",
                    props: { orderId: s.orderId, amount: s.amountCents / 100, tool: "issue_refund" },
                },
                actions: [
                    { label: "Approve", value: { approved: true } },
                    { label: "Reject", value: { approved: false } },
                ],
            },
        );
        return answer.approved
            ? command({ goto: "refund_execute" })
            : command({ update: { reply: `No refund was issued for ${s.orderId}.` }, goto: END });
    })

    .node("refund_execute", async (s, ctx) => ({
        reply: await runTools(
            ctx,
            "refund_execute",
            refundTools(ctx),
            EXECUTE_SYSTEM,
            `Refund order ${s.orderId} for ${s.amountCents} cents.`,
        ),
    }))

    .edge(START, "route")
    .edge("analytics", END)
    .edge("weather", END)
    .edge("chat", END)
    .edge("refund_execute", END)
    .compile();

function textOf(ai: AIMessage): string {
    const parts = ai.content as Array<{ type?: string; text?: string }>;
    return Array.isArray(parts) ? parts.filter((p) => p.type === "text" && p.text).map((p) => p.text).join("") : "";
}

function isInterruptLike(err: unknown): boolean {
    return typeof err === "object" && err !== null && "key" in err && "payload" in err && !(err instanceof Error);
}

function makeApp() {
    return mekik({
        graph: desk,
        input: (frame) => ({ input: frame.data.text }),
        reply: (state) => state.reply as string,
        greeting: () => "Routed desk. Ask about orders, ask about the weather, or ask for a refund.",
    });
}

// ── console plumbing ──────────────────────────────────────────────────────────

class Collector implements Connection {
    readonly id = "conn-routed";
    readonly frames: OutgoingFrame[] = [];
    send(frame: OutgoingFrame): void {
        this.frames.push(frame);
    }
    close(): void {}
    drain(): OutgoingFrame[] {
        return this.frames.splice(0, this.frames.length);
    }
}

function describe(frames: OutgoingFrame[]): void {
    for (const f of frames) {
        if (f.type === "tool_call") {
            const d = f.data as { name: string; status: string; params?: unknown; result?: unknown; error?: string };
            if (d.status === "running") console.log(`  → ${d.name} ${truncate(JSON.stringify(d.params))}`);
            else if (d.status === "error") console.log(`  ✗ ${d.name} error: ${d.error}`);
            else console.log(`  ← ${d.name} ${truncate(JSON.stringify(d.result))}`);
        } else if (f.type === "genui" && f.chunk.type === "ui") {
            console.log(`  ▦ ${f.chunk.component}`);
        } else if (f.type === "interrupt") {
            console.log(`  ⏸ interrupt ${truncate(JSON.stringify(f.data.payload))}`);
        } else if (f.type === "interrupt_resolved") {
            console.log(`  ▶ resolved`);
        } else if (f.type === "text" && f.from === "bot") {
            console.log(`  bot: ${f.data.text}`);
        } else if (f.type === "error") {
            console.log(`  error ${f.data.code}: ${f.data.message ?? ""}`);
        }
    }
}

function truncate(s: string, max = 150): string {
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

const ASKS = [
    "Which customer has spent the most with us?",
    "What's the weather in Berlin?",
    "hello there",
    "ORD-3 arrived damaged — please refund it.",
];

async function run(): Promise<number> {
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error("Set ANTHROPIC_API_KEY — this example calls the real Claude API (or pass --probe).");
        return 1;
    }
    const app = makeApp();
    const c = new Collector();
    await app.connect(c);
    c.drain();

    for (const ask of ASKS) {
        console.log(`\nuser: ${ask}`);
        await app.receive(c, { type: "text", data: { text: ask } });
        const frames = c.drain();
        describe(frames);
        const interrupt = frames.find((f) => f.type === "interrupt");
        if (interrupt) {
            console.log(`   (approving)`);
            await app.receive(c, { type: "resume", answers: { [interrupt.id]: { approved: true } } });
            describe(c.drain());
        }
    }
    console.log(`\nrefund side effect ran ${sideEffects.issue_refund}× (expected 1)`);
    return sideEffects.issue_refund === 1 ? 0 : 1;
}

// ── probe ─────────────────────────────────────────────────────────────────────

const FIXTURES: Array<{ match: string; body: unknown }> = [
    { match: "name=Berlin", body: { results: [{ name: "Berlin", latitude: 52.5244, longitude: 13.4105 }] } },
    {
        match: "latitude=52.5244",
        body: {
            daily: {
                time: ["2026-07-21", "2026-07-22", "2026-07-23"],
                weather_code: [3, 63, 95],
                temperature_2m_max: [19.2, 17.5, 18.1],
                temperature_2m_min: [12.4, 11.8, 12.0],
                precipitation_sum: [1.1, 8.6, 14.2],
            },
        },
    },
];

function say(text: string): Decision {
    return { text, toolCalls: [] };
}
function callTool(name: string, args: Record<string, unknown>): Decision {
    return { text: "", toolCalls: [{ id: `call-${name}`, name, args }] };
}

/** Scripts keyed by node, so the probe mirrors the graph rather than one flat list. */
let scripts: Record<string, Decision[]> = {};
const cursors: Record<string, number> = {};

const probeDecide: Decide = async (_tools, _messages, node) => {
    const i = cursors[node] ?? 0;
    cursors[node] = i + 1;
    return scripts[node]?.[i] ?? say("(script exhausted)");
};

function check(cond: unknown, msg: string): void {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
    console.log(`     ✓ ${msg}`);
}

function names(frames: OutgoingFrame[]): string[] {
    return frames.flatMap((f) => (f.type === "tool_call" ? [(f.data as { name: string }).name] : []));
}
function components(frames: OutgoingFrame[]): string[] {
    return frames.flatMap((f) => (f.type === "genui" && f.chunk.type === "ui" ? [f.chunk.component] : []));
}

async function probe(): Promise<number> {
    decide = probeDecide;
    fetchJson = async (url) => {
        const hit = FIXTURES.find((f) => url.includes(f.match));
        if (!hit) throw new Error(`probe has no fixture for ${url}`);
        return hit.body;
    };

    const app = makeApp();
    const c = new Collector();
    await app.connect(c);
    c.drain();

    const reset = (route: Route, s: Record<string, Decision[]>) => {
        classify = async () => route;
        scripts = s;
        for (const k of Object.keys(cursors)) delete cursors[k];
    };

    // ── 1. routed to analytics ────────────────────────────────────────────────
    console.log("\n1. route → analytics");
    reset("analytics", {
        analytics: [
            callTool("list-tables-sql", {}),
            callTool("query-sql", {
                sql: "SELECT c.name, SUM(o.total_cents)/100.0 AS dollars FROM customers c " +
                    "JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY dollars DESC",
            }),
            say("Grace Hopper, at $624.30."),
        ],
    });
    await app.receive(c, { type: "text", data: { text: "Which customer has spent the most?" } });
    let frames = c.drain();
    describe(frames);
    check(components(frames).includes("data-table"), "analytics renders a data-table");
    check(!components(frames).includes("weather-card"), "and no weather card");
    check(!names(frames).includes("get_forecast"), "the weather node's tools were never even bound");

    // ── 2. routed to weather ──────────────────────────────────────────────────
    console.log("\n2. route → weather");
    reset("weather", {
        weather: [
            callTool("geocode_city", { city: "Berlin" }),
            callTool("get_forecast", { label: "Berlin", latitude: 52.5244, longitude: 13.4105 }),
            say("Wet in Berlin, with a thunderstorm Thursday."),
        ],
    });
    await app.receive(c, { type: "text", data: { text: "What's the weather in Berlin?" } });
    frames = c.drain();
    describe(frames);
    check(components(frames).includes("weather-card"), "weather renders a weather-card");
    check(!names(frames).includes("query-sql"), "and the shop tools were never bound");

    // ── 3. routed to chat — no tools, no model turn at all ────────────────────
    console.log("\n3. route → chat");
    reset("chat", {});
    await app.receive(c, { type: "text", data: { text: "hello there" } });
    frames = c.drain();
    describe(frames);
    check(names(frames).length === 0, "small talk runs no tools");
    check(
        frames.some((f) => f.type === "text" && f.from === "bot"),
        "and still answers",
    );

    // ── 4. the refund path, across three nodes ────────────────────────────────
    console.log("\n4. route → refund_lookup → refund_approve (pause) → refund_execute");
    reset("refund", {
        refund_lookup: [
            callTool("query-sql", { sql: "SELECT id, total_cents FROM orders WHERE id = 'ORD-3'" }),
            say("ORD-3 62430"),
        ],
        refund_execute: [
            callTool("issue_refund", { orderId: "ORD-3", amountCents: 62430 }),
            say("Refunded $624.30 for ORD-3."),
        ],
    });
    await app.receive(c, { type: "text", data: { text: "ORD-3 arrived damaged — please refund it." } });
    const beforeResume = c.drain();
    describe(beforeResume);

    const interrupt = beforeResume.find((f) => f.type === "interrupt");
    check(interrupt, "the graph parks in refund_approve");
    check(names(beforeResume).includes("query-sql"), "refund_lookup ran and was traced");
    check(sideEffects.issue_refund === 0, "nothing was refunded before the human answered");
    const queriesBefore = db.audit.length;

    console.log("   (approving)");
    await app.receive(c, {
        type: "resume",
        answers: { [(interrupt as { id: string }).id]: { approved: true } },
    });
    const afterResume = c.drain();
    describe(afterResume);

    check(afterResume.some((f) => f.type === "interrupt_resolved"), "the pause resolves");
    check(sideEffects.issue_refund === 1, `the refund ran exactly once (got ${sideEffects.issue_refund})`);
    check(db.audit.length === queriesBefore, "the lookup query did not re-run");

    // The payoff of splitting the pause into its own node. concierge.ts, which
    // keeps everything in one node, DOES re-emit these frames on resume.
    check(
        !names(afterResume).includes("query-sql"),
        "…and unlike the single-node version, its frames are not re-emitted either",
    );
    check(names(afterResume).includes("issue_refund"), "only the nodes after the pause ran");

    const row = db.db.prepare("SELECT status FROM orders WHERE id = 'ORD-3'").get() as { status: string };
    check(row.status === "refunded", "and the row really changed");

    console.log("\n✅ probe passed — routing, per-node tool sets, and a pause that replays one node");
    return 0;
}

// ── entry point ───────────────────────────────────────────────────────────────

if (process.argv.includes("--probe")) {
    void probe().then(
        (code) => process.exit(code),
        (err) => {
            console.error("\n❌ probe failed:\n", err);
            process.exit(1);
        },
    );
} else if (process.argv.includes("--serve")) {
    const handle = serveWs(makeApp(), { port: 8805 });
    console.log("mekik routed desk on ws://localhost:8805 (any path)");
    process.on("SIGINT", () => void handle.close().then(() => process.exit(0)));
} else {
    void run().then(
        (code) => process.exit(code),
        (err) => {
            console.error("\n❌ crashed:\n", err);
            process.exit(1);
        },
    );
}
