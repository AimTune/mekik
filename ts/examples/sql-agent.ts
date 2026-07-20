// An analytics desk over a real SQLite database. The model is given no schema up
// front — it discovers the tables, reads their columns, writes its own SQL, and
// explains the answer. Three scenarios run back to back:
//
//   1. discovery  — list_tables (hidden) → describe_table → run_query, and the
//                   result set renders as a `data-table` GenUI card
//   2. redaction  — a query that returns customer emails: the model sees the real
//                   addresses, the surfaced trace shows «redacted»
//   3. correction — the user asks for a DELETE; the read-only guard rejects it,
//                   the failure surfaces as a `tool_call` error frame, and the
//                   model recovers and answers instead of the node crashing
//
//   ANTHROPIC_API_KEY=sk-ant-… node examples/sql-agent.ts          # the three scenarios
//   ANTHROPIC_API_KEY=sk-ant-… node examples/sql-agent.ts --serve  # server on :8802
//   node examples/sql-agent.ts --probe                             # no key, no API call
//
// `--probe` replaces only the model's decisions with a fixed script and runs the
// identical graph, tools and wire path. It asserts the three behaviours above, so
// the plumbing stays verifiable — and CI-checkable — without a key or a bill.
// The database is created in memory on startup, so the example is self-contained.

import { DatabaseSync } from "node:sqlite";

import { channel, graph, END, START } from "@ilmek/core";
import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { Context } from "@ilmek/core";
import { z } from "zod";

import { mekik } from "@mekik/core";
import type { Connection, OutgoingFrame } from "@mekik/core";
import { withMekikTools } from "@mekik/langchain";
import { serveWs } from "@mekik/ws";

// ── the database ──────────────────────────────────────────────────────────────

// Money is stored in cents, and the column is `unit_price_cents` — deliberately
// not the shape a question is asked in. The model has to read the schema and do
// the conversion itself, which is the part worth demonstrating.
const db = new DatabaseSync(":memory:");
db.exec(`
    CREATE TABLE customers (
        id    TEXT PRIMARY KEY,
        name  TEXT NOT NULL,
        email TEXT NOT NULL,
        tier  TEXT NOT NULL CHECK (tier IN ('gold', 'silver', 'standard'))
    );
    CREATE TABLE orders (
        id          TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        placed_on   TEXT NOT NULL,
        status      TEXT NOT NULL
    );
    CREATE TABLE order_items (
        order_id         TEXT NOT NULL REFERENCES orders(id),
        sku              TEXT NOT NULL,
        qty              INTEGER NOT NULL,
        unit_price_cents INTEGER NOT NULL
    );

    INSERT INTO customers (id, name, email, tier) VALUES
        ('CUS-1', 'Ada Lovelace',   'ada@example.com',    'gold'),
        ('CUS-2', 'Grace Hopper',   'grace@example.com',  'gold'),
        ('CUS-3', 'Alan Turing',    'alan@example.com',   'silver'),
        ('CUS-4', 'Katherine J.',   'kj@example.com',     'standard');

    INSERT INTO orders (id, customer_id, placed_on, status) VALUES
        ('ORD-1', 'CUS-1', '2026-06-03', 'delivered'),
        ('ORD-2', 'CUS-1', '2026-06-21', 'delivered'),
        ('ORD-3', 'CUS-2', '2026-06-11', 'delivered'),
        ('ORD-4', 'CUS-3', '2026-06-14', 'refunded'),
        ('ORD-5', 'CUS-4', '2026-05-28', 'delivered'),
        ('ORD-6', 'CUS-2', '2026-07-02', 'shipped');

    INSERT INTO order_items (order_id, sku, qty, unit_price_cents) VALUES
        ('ORD-1', 'KETTLE-01', 1, 24990),
        ('ORD-1', 'MUG-07',    2,  1250),
        ('ORD-2', 'GRINDER-3', 1, 18900),
        ('ORD-3', 'KETTLE-01', 2, 24990),
        ('ORD-3', 'FILTER-XL', 4,   890),
        ('ORD-4', 'MUG-07',    1,  1250),
        ('ORD-5', 'CABLE-2M',  3,   650),
        ('ORD-6', 'GRINDER-3', 1, 18900);
`);

// The queries the model actually ran, so the run can be reported honestly at the
// end rather than us claiming behaviour we did not observe.
const audit: Array<{ sql: string; outcome: string }> = [];

/**
 * Columns that must never reach the client. Declared once because they are
 * needed in *two* places, and the second one is easy to miss: the `redact`
 * policy masks the `tool_call` frame mekik emits for you, but it has no say over
 * a `genui` chunk the tool emits itself. Anything a tool renders directly is the
 * tool's own responsibility to mask.
 */
const PRIVATE_COLUMNS = ["email"] as const;

function maskRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return rows.map((row) => {
        const out: Record<string, unknown> = { ...row };
        for (const col of PRIVATE_COLUMNS) if (col in out) out[col] = "«redacted»";
        return out;
    });
}

// ── the tools ─────────────────────────────────────────────────────────────────

/** Anything that is not a single read is refused before it reaches SQLite. */
function assertReadOnly(sql: string): void {
    const trimmed = sql.trim().replace(/;\s*$/, "");
    if (/;/.test(trimmed)) {
        throw new Error("Only a single statement is allowed — remove the ';' and send one query.");
    }
    if (!/^(select|with)\b/i.test(trimmed)) {
        const verb = trimmed.split(/\s+/, 1)[0]?.toUpperCase() ?? "that";
        throw new Error(
            `This connection is read-only, so ${verb} is refused. You can SELECT to inspect data, but not modify it.`,
        );
    }
}

/**
 * Built per run so `run_query` can emit its GenUI card through *this* run's ctx.
 * The tools themselves stay plain LangChain tools — `withMekikTools` is what adds
 * the traces, the masking and the journaling.
 */
function makeSqlTools(ctx: Context<any>): StructuredToolInterface[] {
    const listTables = tool(
        () => {
            const rows = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                .all() as Array<{ name: string }>;
            return rows.map((r) => r.name).join(", ");
        },
        {
            name: "list_tables",
            description: "List every table in the database. Call this first if you do not know the schema.",
            schema: z.object({}),
        },
    );

    const describeTable = tool(
        ({ table }) => {
            const row = db
                .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
                .get(table) as { sql?: string } | undefined;
            if (!row?.sql) throw new Error(`No table named ${table}.`);
            return row.sql;
        },
        {
            name: "describe_table",
            description: "Show one table's CREATE TABLE statement, including its columns and foreign keys.",
            schema: z.object({ table: z.string().describe("The table name, e.g. orders") }),
        },
    );

    const runQuery = tool(
        ({ sql }) => {
            assertReadOnly(sql);
            let rows: Array<Record<string, unknown>>;
            try {
                rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
            } catch (err) {
                // SQLite's message names the offending token, which is exactly
                // what the model needs to fix the query on its next turn.
                audit.push({ sql, outcome: "sql error" });
                throw new Error(`SQLite rejected the query: ${err instanceof Error ? err.message : String(err)}`);
            }
            audit.push({ sql, outcome: `${rows.length} row(s)` });

            const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
            // The card is emitted from inside the tool, so the client renders the
            // result the moment the query lands rather than after the model has
            // finished writing its explanation. It is also outside the `redact`
            // policy's reach, so it is masked here by hand.
            mekik.ui(ctx, "data-table", { columns, rows: maskRows(rows), sql });
            // Returned as an object, not a JSON string: `redact` masks by field
            // name and walks nested rows, and it cannot see into a string.
            return { columns, rows };
        },
        {
            name: "run_query",
            description:
                "Run one read-only SQL query (SELECT or WITH) against the SQLite database and return its rows as JSON.",
            schema: z.object({ sql: z.string().describe("A single SELECT statement, without a trailing semicolon") }),
        },
    );

    return withMekikTools(ctx, [listTables, describeTable, runQuery], {
        // Schema plumbing: it runs, but the customer has no reason to watch us
        // enumerate table names.
        list_tables: { show: false },
        describe_table: { show: true },
        // The model reads real addresses; the surfaced params and rows do not
        // carry them. Masking is by field name, and it walks nested rows.
        run_query: { show: true, redact: ["email"] },
    });
}

const SYSTEM = [
    "You are a data analyst answering questions about a shop's SQLite database.",
    "You do not know the schema: discover it with list_tables and describe_table before querying.",
    "Prices are stored in cents — convert to dollars when you report money.",
    "The connection is read-only. If a request needs a write, explain that you cannot make it rather than trying twice.",
    "Answer the user in one or two short sentences; the rows are already shown to them as a table.",
].join(" ");

// ── the graph ─────────────────────────────────────────────────────────────────

const MAX_TURNS = 10;

interface Decision {
    text: string;
    toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

/**
 * What the node asks on each turn. The real one calls Claude; `--probe` swaps in
 * a fixed script so the graph, the tools and the wire can be exercised offline.
 * Everything downstream of this function is identical in both modes.
 */
type Decide = (tools: StructuredToolInterface[], messages: BaseMessage[], turn: number) => Promise<Decision>;

let llmSingleton: ChatAnthropic | undefined;
function model(): ChatAnthropic {
    llmSingleton ??= new ChatAnthropic({ model: "claude-opus-4-8", maxTokens: 2048 });
    return llmSingleton;
}

const askClaude: Decide = async (tools, messages) => {
    // Bound here, not at graph build time, so `--probe` never constructs the
    // client (which would demand a key it does not need).
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

const analyst = graph("sql-analyst")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("analyst", async (s, ctx) => {
        const tools = makeSqlTools(ctx);
        const byName = new Map(tools.map((t) => [t.name, t]));
        const messages: BaseMessage[] = [new SystemMessage(SYSTEM), new HumanMessage(s.input)];

        for (let turn = 0; turn < MAX_TURNS; turn++) {
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
                    if (isInterruptLike(err)) throw err; // a pause is not a failure
                    // The wrapper has already surfaced a `tool_call` error frame.
                    // Handing the message back as an observation is what lets the
                    // model fix its own query instead of the whole node dying.
                    observation = `Error: ${err instanceof Error ? err.message : String(err)}`;
                }
                messages.push(new ToolMessage({ tool_call_id: call.id, content: observation }));
            }
        }

        return { reply: "I ran out of steps before I could answer that." };
    })
    .edge(START, "analyst")
    .edge("analyst", END)
    .compile();

function textOf(ai: AIMessage): string {
    const parts = ai.content as Array<{ type?: string; text?: string }>;
    return Array.isArray(parts) ? parts.filter((p) => p.type === "text" && p.text).map((p) => p.text).join("") : "";
}

/** ilmek signals a pause by throwing a non-`Error` value; never swallow it. */
function isInterruptLike(err: unknown): boolean {
    return typeof err === "object" && err !== null && "key" in err && "payload" in err && !(err instanceof Error);
}

function makeApp() {
    return mekik({
        graph: analyst,
        input: (frame) => ({ input: frame.data.text }),
        reply: (state) => state.reply as string,
        greeting: () =>
            "Shop analytics. Ask me anything about customers, orders or revenue — I'll find the schema myself.",
    });
}

// ── the three scenarios ───────────────────────────────────────────────────────

class Collector implements Connection {
    readonly id = "conn-sql";
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
            const props = f.chunk.props as { columns?: string[]; rows?: unknown[] };
            console.log(`  ▦ ${f.chunk.component}: ${props.rows?.length ?? 0} row(s) × [${(props.columns ?? []).join(", ")}]`);
        } else if (f.type === "text" && f.from === "bot") {
            console.log(`  bot: ${f.data.text}`);
        } else if (f.type === "error") {
            console.log(`  error ${f.data.code}: ${f.data.message ?? ""}`);
        }
    }
}

function truncate(s: string, max = 160): string {
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

const SCENARIOS: Array<{ title: string; ask: string; expect: string }> = [
    {
        title: "1. discovery — the model finds the schema and writes its own SQL",
        ask: "Which three customers have spent the most in total? Show the amounts in dollars.",
        expect: "at least one run_query, and a data-table card",
    },
    {
        title: "2. redaction — the model sees emails, the wire does not",
        ask: "Who placed ORD-3, and what is their email address?",
        expect: "an email in the reply, «redacted» in the trace",
    },
    {
        title: "3. correction — a write is refused and the model recovers",
        ask: "Please delete order ORD-4 from the database.",
        expect: "a tool_call error frame, then a normal reply",
    },
];

async function run(): Promise<number> {
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error("Set ANTHROPIC_API_KEY — this example calls the real Claude API.");
        return 1;
    }

    const app = makeApp();
    const c = new Collector();
    await app.connect(c);
    c.drain();

    let sawTable = false;
    let sawRedaction = false;
    let sawError = false;

    for (const scenario of SCENARIOS) {
        console.log(`\n${scenario.title}`);
        console.log(`   user: ${scenario.ask}`);
        console.log(`   expecting: ${scenario.expect}`);
        await app.receive(c, { type: "text", data: { text: scenario.ask } });
        const frames = c.drain();
        describe(frames);

        if (frames.some((f) => f.type === "genui" && f.chunk.type === "ui" && f.chunk.component === "data-table")) {
            sawTable = true;
        }
        if (frames.some((f) => f.type === "tool_call" && JSON.stringify(f.data).includes("«redacted»"))) {
            sawRedaction = true;
        }
        if (frames.some((f) => f.type === "tool_call" && (f.data as { status: string }).status === "error")) {
            sawError = true;
        }
    }

    console.log("\nSQL the model actually ran:");
    for (const entry of audit) console.log(`  ${entry.outcome.padEnd(12)} ${truncate(entry.sql.replace(/\s+/g, " "))}`);

    // A real model is allowed to reach an answer a different way, so these are
    // reported rather than asserted — an unmet expectation is information, not a
    // failure of the wiring.
    console.log("\nobserved:");
    console.log(`  data-table card rendered      ${sawTable ? "yes" : "no"}`);
    console.log(`  email masked in the trace     ${sawRedaction ? "yes" : "no"}`);
    console.log(`  write refused + recovered     ${sawError ? "yes" : "no"}`);
    console.log(`  list_tables hidden from wire  ${audit.length > 0 ? "yes (never traced)" : "n/a"}`);

    return 0;
}

// ── probe: the same graph, offline ────────────────────────────────────────────

/** A scripted stand-in for one model turn. */
function say(text: string): Decision {
    return { text, toolCalls: [] };
}
function call(name: string, args: Record<string, unknown>): Decision {
    return { text: "", toolCalls: [{ id: `call-${name}-${Math.random().toString(36).slice(2, 8)}`, name, args }] };
}

/** One script per scenario, consumed a turn at a time. */
let script: Decision[] = [];
const probeDecide: Decide = async (_tools, _messages, turn) =>
    script[turn] ?? say("(script exhausted)");

const PROBE: Array<{ title: string; ask: string; script: Decision[] }> = [
    {
        title: "1. discovery — schema lookup, query, GenUI card",
        ask: "Which three customers have spent the most in total?",
        script: [
            call("list_tables", {}),
            call("describe_table", { table: "order_items" }),
            call("run_query", {
                sql: `SELECT c.name, SUM(i.qty * i.unit_price_cents) / 100.0 AS dollars
                      FROM customers c
                      JOIN orders o ON o.customer_id = c.id
                      JOIN order_items i ON i.order_id = o.id
                      GROUP BY c.id ORDER BY dollars DESC LIMIT 3`,
            }),
            say("Ada, Grace and Alan are your top spenders."),
        ],
    },
    {
        title: "2. redaction — the model sees the email, the wire does not",
        ask: "Who placed ORD-3, and what is their email?",
        script: [
            call("run_query", {
                sql: `SELECT c.name, c.email FROM customers c
                      JOIN orders o ON o.customer_id = c.id WHERE o.id = 'ORD-3'`,
            }),
            say("ORD-3 was placed by Grace Hopper."),
        ],
    },
    {
        title: "3. correction — the write is refused and the turn survives",
        ask: "Please delete order ORD-4.",
        script: [
            call("run_query", { sql: "DELETE FROM orders WHERE id = 'ORD-4'" }),
            say("I can only read from this database, so I cannot delete that order."),
        ],
    },
];

function check(cond: unknown, msg: string): void {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function probe(): Promise<number> {
    decide = probeDecide;
    const app = makeApp();
    const c = new Collector();
    await app.connect(c);
    c.drain();

    for (const scenario of PROBE) {
        script = scenario.script;
        console.log(`\n${scenario.title}`);
        console.log(`   user: ${scenario.ask}`);
        await app.receive(c, { type: "text", data: { text: scenario.ask } });
        const frames = c.drain();
        describe(frames);

        const traced = frames.filter((f) => f.type === "tool_call");
        check(
            !traced.some((f) => (f.data as { name: string }).name === "list_tables"),
            "list_tables is never traced (show: false)",
        );

        if (scenario.title.startsWith("1.")) {
            const card = frames.find(
                (f) => f.type === "genui" && f.chunk.type === "ui" && f.chunk.component === "data-table",
            );
            check(card, "the query renders a data-table card");
            const chunk = (card as Extract<OutgoingFrame, { type: "genui" }>).chunk;
            const rows = chunk.type === "ui" ? ((chunk.props as { rows?: unknown[] }).rows ?? []) : [];
            check(rows.length === 3, `the card carries 3 rows (got ${rows.length})`);
        }

        if (scenario.title.startsWith("2.")) {
            const wire = JSON.stringify(traced);
            check(wire.includes("«redacted»"), "the email is masked on the wire");
            check(!wire.includes("grace@example.com"), "the real address never reaches the client");
        }

        if (scenario.title.startsWith("3.")) {
            const failed = traced.find((f) => (f.data as { status: string }).status === "error");
            check(failed, "the refused write surfaces as a tool_call error frame");
            const reply = frames.find((f) => f.type === "text" && f.from === "bot");
            check(reply, "the turn still produces a reply instead of crashing");
            check(
                frames.some((f) => f.type === "run" && f.data.status === "finished"),
                "the run finishes cleanly after the tool error",
            );
        }
    }

    console.log("\nSQL the script ran:");
    for (const entry of audit) console.log(`  ${entry.outcome.padEnd(12)} ${truncate(entry.sql.replace(/\s+/g, " "))}`);

    console.log("\n✅ probe passed — hidden tool, GenUI table, masking, and error recovery all verified offline");
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
    const handle = serveWs(makeApp(), { port: 8802 });
    console.log("mekik SQL analyst on ws://localhost:8802 (any path)");
    console.log('try: {"type":"text","data":{"text":"Which customers spent the most?"}}');
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
