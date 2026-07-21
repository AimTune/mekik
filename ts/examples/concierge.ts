// The one that puts it all together: a shop concierge with every tool the other
// examples demonstrate in isolation, in a single agent, behind a single graph.
// The model is given no routing rules — it picks tools per question, and mixes
// them when a question needs more than one.
//
//   shop      a LangChain-shaped SqlToolkit (query-sql, …)   → `data-table`
//   refunds   issue_refund                               → `approval-form`, then a write
//   weather   geocode_city / get_forecast                → `weather-card`
//
// Four scenarios:
//   1. analytics  — a SQL question the model answers by discovering the schema
//   2. weather    — an unrelated question routed to a different tool group
//   3. approval   — a refund pauses the graph, a human answers, and the write
//                   happens exactly once even though the node re-runs on resume
//   4. mixed      — one question that needs the database AND the weather API,
//                   answered in a single turn
//
//   ANTHROPIC_API_KEY=sk-ant-… node examples/concierge.ts          # live model
//   ANTHROPIC_API_KEY=sk-ant-… node examples/concierge.ts --serve  # server on :8804
//   node examples/concierge.ts --probe                             # no key, no network
//
// The sandbox in the chativa repo registers all four components, so `--serve`
// renders end to end.
//
// This is the single-node shape: one node, every tool, the model routes by
// choosing among them. `routed-desk.ts` is the same desk as a real graph —
// a router node, one node per domain, and the pause as its own node.

import { channel, graph, END, START } from "@ilmek/core";
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

// ── the shop database ─────────────────────────────────────────────────────────

// The shop tools are not written here: `lib/sql-toolkit.ts` reproduces
// LangChain's `SqlToolkit` (dropped in v1), and the concierge wraps its tools
// alongside its own. One `withMekikTools` call, mixed provenance — the policy
// map does not care who authored which tool.
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
        ('CUS-2', 'Grace Hopper', 'grace@example.com', 'gold'),
        ('CUS-3', 'Alan Turing',  'alan@example.com',  'silver');

    INSERT INTO orders VALUES
        ('ORD-1', 'CUS-1', '2026-07-19', 'delivered', 'Istanbul', 24990),
        ('ORD-2', 'CUS-1', '2026-07-20', 'shipped',   'Berlin',   18900),
        ('ORD-3', 'CUS-2', '2026-07-21', 'delayed',   'Berlin',   62430),
        ('ORD-4', 'CUS-3', '2026-07-22', 'shipped',   'Istanbul',  1250);
`);

// Counted so the probe can separate two things that look alike on the wire: how
// many times a tool's *effect* ran, versus how many times its *frames* were sent.
// (Query executions are counted by the toolkit itself, in `db.audit`.)
const sideEffects = { issue_refund: 0 };

// ── the weather API (swappable, so the probe never touches the network) ───────

type Fetcher = (url: string) => Promise<unknown>;

let fetchJson: Fetcher = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${new URL(url).host} replied ${res.status}`);
    return res.json();
};

const WMO: Record<number, string> = {
    0: "clear", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog",
    61: "light rain", 63: "rain", 65: "heavy rain", 80: "rain showers", 95: "thunderstorm",
};

// ── the tools, all of them, in one wrap ───────────────────────────────────────

const PRIVATE_COLUMNS = ["email"] as const;

function maskRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return rows.map((row) => {
        const out: Record<string, unknown> = { ...row };
        for (const col of PRIVATE_COLUMNS) if (col in out) out[col] = "«redacted»";
        return out;
    });
}

function makeTools(ctx: Context<any>): StructuredToolInterface[] {
    // ── shop: the toolkit's tools, untouched ──────────────────────────────────
    const toolkit = new SqlToolkit(db, {
        onRows: ({ columns, rows, sql }) => {
            // Masked here as well as by the policy: `redact` covers the
            // `tool_call` frame mekik emits, never a `genui` chunk emitted beside it.
            mekik.ui(ctx, "data-table", { columns, rows: maskRows(rows), sql });
        },
    });

    // ── refunds ───────────────────────────────────────────────────────────────
    const issueRefund = tool(
        ({ orderId, amountCents }) => {
            sideEffects.issue_refund++;
            db.db.prepare("INSERT OR REPLACE INTO refunds VALUES (?, ?, ?)").run(orderId, amountCents, "2026-07-21");
            db.db.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").run(orderId);
            return { orderId, refundedDollars: amountCents / 100 };
        },
        {
            name: "issue_refund",
            description:
                "Refund an order and mark it refunded. Irreversible — look the order up first so the amount is right.",
            schema: z.object({
                orderId: z.string(),
                amountCents: z.number().describe("The refund amount in cents, from the order's total_cents"),
            }),
        },
    );

    // ── weather ───────────────────────────────────────────────────────────────
    const geocodeCity = tool(
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

    const getForecast = tool(
        async ({ label, latitude, longitude, days }) => {
            const span = Math.min(Math.max(days ?? 3, 1), 7);
            const body = (await fetchJson(
                `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
                    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum` +
                    `&forecast_days=${span}&timezone=auto`,
            )) as { daily?: Record<string, unknown[]> };
            const daily = body.daily;
            const time = daily?.time as string[] | undefined;
            if (!time?.length) throw new Error("The forecast service returned no daily data.");

            const forecast = time.map((date, i) => ({
                date,
                summary: WMO[(daily?.weather_code as number[])?.[i] ?? -1] ?? "unknown",
                high: (daily?.temperature_2m_max as number[])?.[i] ?? null,
                low: (daily?.temperature_2m_min as number[])?.[i] ?? null,
                precipitationMm: (daily?.precipitation_sum as number[])?.[i] ?? null,
            }));
            mekik.ui(ctx, "weather-card", { place: label, days: forecast });
            return { place: label, days: forecast };
        },
        {
            name: "get_forecast",
            description: "Daily forecast for one set of coordinates. Celsius.",
            schema: z.object({
                label: z.string().describe("How to name this place in the UI"),
                latitude: z.number(),
                longitude: z.number(),
                days: z.number().optional(),
            }),
        },
    );

    // One policy map for every tool the concierge owns. The interesting part is
    // that the three groups get *different* treatment, and the model never has to
    // know: it just calls tools.
    return withMekikTools(ctx, [...toolkit.getTools(), issueRefund, geocodeCity, getForecast], {
        "list-tables-sql": { show: false },
        "info-sql": { show: true },
        "query-sql": { show: true, redact: ["email"] },
        // The only tool that moves money: park the graph and ask a human.
        issue_refund: {
            show: true,
            approve: {
                title: "Approve this refund?",
                ui: { component: "approval-form", props: {} },
                denyMessage: "A human reviewer declined the refund. Tell the customer politely and offer to escalate.",
            },
        },
        geocode_city: { show: false },
        get_forecast: { show: true },
    });
}

const SYSTEM = [
    "You are the concierge for an online shop. You can query the shop database, check the weather, and issue refunds.",
    "You do not know the database schema: discover it with list-tables-sql and info-sql before querying.",
    "Money is stored in cents — convert to dollars when you report it.",
    "get_forecast needs coordinates, so resolve places with geocode_city first.",
    "query-sql is read-only; to refund, call issue_refund, which asks the customer for approval first.",
    "Some questions need more than one of these — use as many tools as the question actually requires.",
    "Answer in one or two short sentences; tables and forecasts are already shown to the user as cards.",
].join(" ");

// ── the graph ─────────────────────────────────────────────────────────────────

const MAX_TURNS = 12;

interface Decision {
    text: string;
    toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

type Decide = (tools: StructuredToolInterface[], messages: BaseMessage[], turn: number) => Promise<Decision>;

let llmSingleton: ChatAnthropic | undefined;
function model(): ChatAnthropic {
    llmSingleton ??= new ChatAnthropic({ model: "claude-opus-4-8", maxTokens: 2048 });
    return llmSingleton;
}

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

let decide: Decide = askClaude;

const concierge = graph("concierge")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("concierge", async (s, ctx) => {
        const tools = makeTools(ctx);
        const byName = new Map(tools.map((t) => [t.name, t]));
        const messages: BaseMessage[] = [new SystemMessage(SYSTEM), new HumanMessage(s.input)];

        for (let turn = 0; turn < MAX_TURNS; turn++) {
            // Journaled, so the resume pass after the approval replays the same
            // decisions instead of re-asking (and re-paying for) the model.
            const decision = await ctx.step(`llm:${turn}`, () => decide(tools, messages, turn));

            messages.push(
                new AIMessage({
                    content: decision.text,
                    tool_calls: decision.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
                }),
            );

            if (decision.toolCalls.length === 0) {
                return { reply: decision.text || "(no reply)" };
            }

            for (const call of decision.toolCalls) {
                const t = byName.get(call.name);
                let observation: string;
                try {
                    const result = t ? await t.invoke(call.args as never) : `Unknown tool ${call.name}.`;
                    observation = typeof result === "string" ? result : JSON.stringify(result);
                } catch (err) {
                    if (isInterruptLike(err)) throw err; // the approval pause
                    observation = `Error: ${err instanceof Error ? err.message : String(err)}`;
                }
                messages.push(new ToolMessage({ tool_call_id: call.id, content: observation }));
            }
        }

        return { reply: "I ran out of steps before I could answer that." };
    })
    .edge(START, "concierge")
    .edge("concierge", END)
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
        graph: concierge,
        input: (frame) => ({ input: frame.data.text }),
        reply: (state) => state.reply as string,
        greeting: () =>
            "Shop concierge. Ask about orders and revenue, check the weather for a delivery, or ask for a refund.",
    });
}

// ── console plumbing ──────────────────────────────────────────────────────────

class Collector implements Connection {
    readonly id = "conn-concierge";
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
            console.log(`  ⏸ interrupt ${f.id} ${truncate(JSON.stringify(f.data.payload))}`);
        } else if (f.type === "interrupt_resolved") {
            console.log(`  ▶ resolved ${f.id}`);
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
    "What's the weather in Berlin for the next three days?",
    "ORD-3 arrived damaged — please refund it.",
    "ORD-3 ships to Berlin. Is the weather there likely to delay it further?",
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

        // A refund parks the graph; answer it so the conversation can continue.
        const interrupt = frames.find((f) => f.type === "interrupt");
        if (interrupt) {
            console.log(`   (approving ${interrupt.id})`);
            await app.receive(c, { type: "resume", answers: { [interrupt.id]: { approved: true } } });
            describe(c.drain());
        }
    }

    console.log(`\nrefund side effect ran ${sideEffects.issue_refund}× (expected 1)`);
    return sideEffects.issue_refund === 1 ? 0 : 1;
}

// ── probe: the same graph, offline ────────────────────────────────────────────

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
function callTool(...pairs: Array<[string, Record<string, unknown>]>): Decision {
    return { text: "", toolCalls: pairs.map(([name, args], i) => ({ id: `call-${name}-${i}`, name, args })) };
}

const BERLIN = { label: "Berlin", latitude: 52.5244, longitude: 13.4105, days: 3 };

const PROBE: Array<{ title: string; ask: string; script: Decision[]; approve?: boolean }> = [
    {
        title: "1. analytics — routed to the database",
        ask: "Which customer has spent the most with us?",
        script: [
            callTool(["list-tables-sql", {}]),
            callTool(["info-sql", { tables: "orders,customers" }]),
            callTool([
                "query-sql",
                {
                    sql: "SELECT c.name, SUM(o.total_cents)/100.0 AS dollars FROM customers c " +
                        "JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY dollars DESC LIMIT 3",
                },
            ]),
            say("Grace Hopper, at $624.30."),
        ],
    },
    {
        title: "2. weather — the same agent, a different tool group",
        ask: "What's the weather in Berlin for the next three days?",
        script: [
            callTool(["geocode_city", { city: "Berlin" }]),
            callTool(["get_forecast", BERLIN]),
            say("Wet in Berlin: rain Wednesday and a thunderstorm Thursday."),
        ],
    },
    {
        title: "3. approval — the refund parks the graph, then writes once",
        ask: "ORD-3 arrived damaged — please refund it.",
        approve: true,
        script: [
            callTool(["query-sql", { sql: "SELECT id, total_cents FROM orders WHERE id = 'ORD-3'" }]),
            callTool(["issue_refund", { orderId: "ORD-3", amountCents: 62430 }]),
            say("Refunded $624.30 for ORD-3."),
        ],
    },
    {
        title: "4. mixed — one question, two tool groups",
        ask: "ORD-3 ships to Berlin. Is the weather there likely to delay it further?",
        script: [
            // The database and the weather API, in a single assistant turn.
            callTool(
                ["query-sql", { sql: "SELECT id, status, ships_to FROM orders WHERE id = 'ORD-3'" }],
                ["geocode_city", { city: "Berlin" }],
            ),
            callTool(["get_forecast", BERLIN]),
            say("ORD-3 is refunded now, but Berlin has a thunderstorm Thursday, so deliveries there may slip."),
        ],
    },
];

let script: Decision[] = [];
const probeDecide: Decide = async (_tools, _messages, turn) => script[turn] ?? say("(script exhausted)");

function check(cond: unknown, msg: string): void {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
    console.log(`     ✓ ${msg}`);
}

function componentsOf(frames: OutgoingFrame[]): string[] {
    return frames.flatMap((f) =>
        f.type === "genui" && f.chunk.type === "ui" ? [f.chunk.component] : [],
    );
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

    for (const scenario of PROBE) {
        script = scenario.script;
        console.log(`\n${scenario.title}`);
        console.log(`   user: ${scenario.ask}`);
        await app.receive(c, { type: "text", data: { text: scenario.ask } });
        let frames = c.drain();
        describe(frames);

        // Hidden tools stay hidden no matter which group they belong to.
        const traced = frames.filter((f) => f.type === "tool_call");
        check(
            !traced.some((f) => ["list-tables-sql", "geocode_city"].includes((f.data as { name: string }).name)),
            "no hidden tool reaches the wire, in any group",
        );

        if (scenario.title.startsWith("1.")) {
            check(componentsOf(frames).includes("data-table"), "the analytics answer renders a data-table");
            check(!componentsOf(frames).includes("weather-card"), "and nothing weather-related is rendered");
        }

        if (scenario.title.startsWith("2.")) {
            check(componentsOf(frames).includes("weather-card"), "the weather answer renders a weather-card");
            check(!componentsOf(frames).includes("data-table"), "and no table is rendered");
        }

        if (scenario.approve) {
            const interrupt = frames.find((f) => f.type === "interrupt");
            check(interrupt, "the refund parks the graph with an interrupt");
            const queriesBefore = db.audit.length;
            const ui = (interrupt as Extract<OutgoingFrame, { type: "interrupt" }>).data.ui;
            check(ui?.component === "approval-form", "the interrupt mounts approval-form");
            check(sideEffects.issue_refund === 0, "nothing was written before the human answered");

            console.log(`   (approving ${(interrupt as { id: string }).id})`);
            await app.receive(c, {
                type: "resume",
                answers: { [(interrupt as { id: string }).id]: { approved: true } },
            });
            frames = c.drain();
            describe(frames);

            check(frames.some((f) => f.type === "interrupt_resolved"), "the pause resolves");
            check(sideEffects.issue_refund === 1, `the refund wrote exactly once (got ${sideEffects.issue_refund})`);

            // Worth being precise about, because the two halves diverge here.
            // Resuming replays the node from the top: the journal returns
            // (routed-desk.ts is the same desk with the pause split into its own
            // node, which avoids this entirely — see its scenario 4.)
            // query-sql's recorded rows without touching SQLite (the effect is
            // exactly-once), but the wrapper's trace emission is not journaled,
            // so the client is sent a SECOND pair of query-sql frames for a
            // query that never ran again. Effects are deduplicated; frames are
            // not. A UI that renders each tool_call as a row will show it twice.
            check(
                db.audit.length === queriesBefore,
                `the replayed query did not re-execute (still ${db.audit.length})`,
            );
            check(
                frames.filter((f) => f.type === "tool_call" && (f.data as { name: string }).name === "query-sql")
                    .length > 0,
                "…but its frames ARE re-emitted on the replay pass",
            );
            const refunded = db.db.prepare("SELECT status FROM orders WHERE id = 'ORD-3'").get() as { status: string };
            check(refunded.status === "refunded", "and the row really changed");
        }

        if (scenario.title.startsWith("4.")) {
            const components = componentsOf(frames);
            check(components.includes("data-table"), "the mixed answer renders the table");
            check(components.includes("weather-card"), "…and the forecast, from one question");
        }
    }

    console.log("\n✅ probe passed — three tool groups, one agent, approval honoured and written once");
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
    const handle = serveWs(makeApp(), { port: 8804 });
    console.log("mekik concierge on ws://localhost:8804 (any path)");
    console.log("components used: data-table, weather-card, approval-form, order-card");
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
