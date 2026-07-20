// A travel-weather desk that talks to a real public API (Open-Meteo — no key, no
// account). Where sql-agent.ts shows a model exploring a local database, this one
// shows the shape most agents actually have: two chained network tools, several
// calls in a single turn, and a remote service that sometimes has no answer.
//
//   1. chaining   — geocode_city → get_forecast, and the forecast renders as a
//                   `weather-card`; the model has to carry coordinates between
//                   two tools it chose itself
//   2. fan-out    — "compare Istanbul and Berlin" produces several tool calls in
//                   ONE assistant turn, each traced separately on the wire
//   3. silent     — an unknown place name fails inside the HIDDEN tool. The model
//                   recovers and asks for a better name, but the client sees no
//                   error frame at all: `show: false` hides a tool's failures as
//                   well as its successes, which is easy to forget when choosing it
//   4. visible    — the shown tool fails instead, so the same recovery this time
//                   surfaces as a `tool_call` error frame the UI can render
//
//   ANTHROPIC_API_KEY=sk-ant-… node examples/weather-agent.ts          # live model + live API
//   ANTHROPIC_API_KEY=sk-ant-… node examples/weather-agent.ts --serve  # server on :8803
//   node examples/weather-agent.ts --probe                             # no key, no network
//
// `--probe` swaps out exactly two things — the model's decisions and the HTTP
// layer — and runs the identical graph, tools and wire path. Everything the
// example claims is asserted there, so CI protects it without a key or a network.

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

// ── the HTTP layer (swappable, so the probe never touches the network) ────────

type Fetcher = (url: string) => Promise<unknown>;

const liveFetch: Fetcher = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${new URL(url).host} replied ${res.status} ${res.statusText}`);
    return res.json();
};

let fetchJson: Fetcher = liveFetch;

/** Every request the run made, so the summary reports what happened rather than what we hoped. */
const calls: string[] = [];

// ── the tools ─────────────────────────────────────────────────────────────────

const WMO: Record<number, string> = {
    0: "clear", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "rime fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 71: "light snow", 73: "snow", 75: "heavy snow",
    80: "rain showers", 81: "rain showers", 82: "violent rain showers", 95: "thunderstorm",
};

interface Place {
    name: string;
    country: string;
    latitude: number;
    longitude: number;
}

function makeWeatherTools(ctx: Context<any>): StructuredToolInterface[] {
    const geocodeCity = tool(
        async ({ city }) => {
            const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
            calls.push(`geocode ${city}`);
            const body = (await fetchJson(url)) as { results?: Array<Record<string, unknown>> };
            const hit = body.results?.[0];
            if (!hit) {
                // Thrown, not returned, so the agent loop hands the message back
                // to the model and it can ask for a better name. Note this tool
                // is `show: false`, so the failure never reaches the client —
                // see scenario 3.
                throw new Error(`No place called "${city}". Try a city name, optionally with its country.`);
            }
            return {
                name: hit.name as string,
                country: hit.country as string,
                latitude: hit.latitude as number,
                longitude: hit.longitude as number,
            } satisfies Place;
        },
        {
            name: "geocode_city",
            description: "Resolve a place name to coordinates. Call this before get_forecast — it needs lat/lon.",
            schema: z.object({ city: z.string().describe('A place name, e.g. "Istanbul" or "Berlin, Germany"') }),
        },
    );

    const getForecast = tool(
        async ({ label, latitude, longitude, days }) => {
            const span = Math.min(Math.max(days ?? 3, 1), 7);
            const url =
                `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
                `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum` +
                `&forecast_days=${span}&timezone=auto`;
            calls.push(`forecast ${label} (${span}d)`);
            const body = (await fetchJson(url)) as {
                daily?: {
                    time?: string[];
                    weather_code?: number[];
                    temperature_2m_max?: number[];
                    temperature_2m_min?: number[];
                    precipitation_sum?: number[];
                };
            };
            const daily = body.daily;
            if (!daily?.time?.length) throw new Error("The forecast service returned no daily data.");

            const forecast = daily.time.map((date, i) => ({
                date,
                summary: WMO[daily.weather_code?.[i] ?? -1] ?? "unknown",
                high: daily.temperature_2m_max?.[i] ?? null,
                low: daily.temperature_2m_min?.[i] ?? null,
                precipitationMm: daily.precipitation_sum?.[i] ?? null,
            }));

            // One card per place, emitted the moment the data lands rather than
            // after the model has finished writing its comparison.
            mekik.ui(ctx, "weather-card", { place: label, days: forecast });
            return { place: label, days: forecast };
        },
        {
            name: "get_forecast",
            description: "Get a daily forecast for one set of coordinates. Temperatures are Celsius.",
            schema: z.object({
                label: z.string().describe("How to name this place in the UI, e.g. Istanbul"),
                latitude: z.number(),
                longitude: z.number(),
                days: z.number().optional().describe("How many days ahead, 1-7. Defaults to 3."),
            }),
        },
    );

    return withMekikTools(ctx, [geocodeCity, getForecast], {
        // Coordinate lookup is plumbing the traveller has no reason to watch.
        geocode_city: { show: false },
        get_forecast: { show: true },
    });
}

const SYSTEM = [
    "You are a travel-weather assistant.",
    "get_forecast needs coordinates, so resolve every place with geocode_city first.",
    "When the user names several places, look them all up — you may call tools more than once in a turn.",
    "If a place cannot be resolved, say so and ask for a clearer name; do not guess coordinates.",
    "Temperatures are Celsius. Answer in one or two short sentences; the daily rows are already shown as cards.",
].join(" ");

// ── the graph ─────────────────────────────────────────────────────────────────

const MAX_TURNS = 8;

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

const desk = graph("weather-desk")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("desk", async (s, ctx) => {
        const tools = makeWeatherTools(ctx);
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

            // Several calls can arrive in one turn (scenario 2). They are run in
            // order so each gets its own journal key and its own pair of frames.
            for (const call of decision.toolCalls) {
                const t = byName.get(call.name);
                let observation: string;
                try {
                    const result = t ? await t.invoke(call.args as never) : `Unknown tool ${call.name}.`;
                    observation = typeof result === "string" ? result : JSON.stringify(result);
                } catch (err) {
                    if (isInterruptLike(err)) throw err; // a pause is not a failure
                    observation = `Error: ${err instanceof Error ? err.message : String(err)}`;
                }
                messages.push(new ToolMessage({ tool_call_id: call.id, content: observation }));
            }
        }

        return { reply: "I ran out of steps before I could answer that." };
    })
    .edge(START, "desk")
    .edge("desk", END)
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
        graph: desk,
        input: (frame) => ({ input: frame.data.text }),
        reply: (state) => state.reply as string,
        greeting: () => "Travel weather. Name any city — or a few — and I'll pull the forecast.",
    });
}

// ── console plumbing ──────────────────────────────────────────────────────────

class Collector implements Connection {
    readonly id = "conn-weather";
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
            const props = f.chunk.props as { place?: string; days?: unknown[] };
            console.log(`  ▦ ${f.chunk.component}: ${props.place} — ${props.days?.length ?? 0} day(s)`);
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

const ASKS: Array<{ title: string; ask: string; expect: string }> = [
    {
        title: "1. chaining — coordinates from one tool feed the next",
        ask: "What's the weather in Istanbul for the next three days?",
        expect: "a hidden geocode, then a traced get_forecast and one weather-card",
    },
    {
        title: "2. fan-out — several tool calls in one assistant turn",
        ask: "Compare Istanbul and Berlin this week — which one should I pack a coat for?",
        expect: "two forecasts, two cards, one comparison",
    },
    {
        title: "3. silent — a hidden tool fails, so the client sees nothing",
        ask: "And what about the weather in Wakanda?",
        expect: "no error frame at all, just a reply asking for a real place",
    },
    {
        title: "4. visible — the shown tool fails, so the UI can render it",
        ask: "Try Bouvet Island then.",
        expect: "a tool_call error frame, then a reply",
    },
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

    for (const scenario of ASKS) {
        console.log(`\n${scenario.title}`);
        console.log(`   user: ${scenario.ask}`);
        console.log(`   expecting: ${scenario.expect}`);
        await app.receive(c, { type: "text", data: { text: scenario.ask } });
        describe(c.drain());
    }

    console.log("\nrequests made:");
    for (const call of calls) console.log(`  ${call}`);
    return 0;
}

// ── probe: the same graph, offline ────────────────────────────────────────────

const FIXTURES: Array<{ match: string; body: unknown }> = [
    {
        match: "name=Istanbul",
        body: { results: [{ name: "Istanbul", country: "Türkiye", latitude: 41.0138, longitude: 28.9497 }] },
    },
    {
        match: "name=Berlin",
        body: { results: [{ name: "Berlin", country: "Germany", latitude: 52.5244, longitude: 13.4105 }] },
    },
    { match: "name=Wakanda", body: {} }, // the service answers, with nothing in it
    {
        // Resolves fine, but the forecast service has nothing for it — so the
        // failure lands in the *shown* tool instead of the hidden one.
        match: "name=Bouvet",
        body: { results: [{ name: "Bouvet Island", country: "Norway", latitude: -54.42, longitude: 3.36 }] },
    },
    { match: "latitude=-54.42", body: {} },
    {
        match: "latitude=41.0138",
        body: {
            daily: {
                time: ["2026-07-21", "2026-07-22", "2026-07-23"],
                weather_code: [0, 2, 61],
                temperature_2m_max: [31.4, 30.1, 26.8],
                temperature_2m_min: [23.0, 22.4, 20.9],
                precipitation_sum: [0, 0, 4.2],
            },
        },
    },
    {
        match: "latitude=52.5244",
        body: {
            daily: {
                time: ["2026-07-21", "2026-07-22", "2026-07-23"],
                weather_code: [3, 63, 61],
                temperature_2m_max: [19.2, 17.5, 18.1],
                temperature_2m_min: [12.4, 11.8, 12.0],
                precipitation_sum: [1.1, 8.6, 3.3],
            },
        },
    },
];

const probeFetch: Fetcher = async (url) => {
    const hit = FIXTURES.find((f) => url.includes(f.match));
    if (!hit) throw new Error(`probe has no fixture for ${url}`);
    return hit.body;
};

function say(text: string): Decision {
    return { text, toolCalls: [] };
}
function callTool(...pairs: Array<[string, Record<string, unknown>]>): Decision {
    return {
        text: "",
        toolCalls: pairs.map(([name, args], i) => ({ id: `call-${name}-${i}`, name, args })),
    };
}

const ISTANBUL = { label: "Istanbul", latitude: 41.0138, longitude: 28.9497, days: 3 };
const BERLIN = { label: "Berlin", latitude: 52.5244, longitude: 13.4105, days: 3 };

const PROBE: Array<{ title: string; ask: string; script: Decision[] }> = [
    {
        title: "1. chaining — coordinates from one tool feed the next",
        ask: "What's the weather in Istanbul for the next three days?",
        script: [
            callTool(["geocode_city", { city: "Istanbul" }]),
            callTool(["get_forecast", ISTANBUL]),
            say("Warm and clear in Istanbul, with a little rain on Thursday."),
        ],
    },
    {
        title: "2. fan-out — several tool calls in one assistant turn",
        ask: "Compare Istanbul and Berlin this week.",
        script: [
            // Both places resolved in a single turn — this is the shape a model
            // produces when the question names more than one thing.
            callTool(["geocode_city", { city: "Istanbul" }], ["geocode_city", { city: "Berlin" }]),
            callTool(["get_forecast", ISTANBUL], ["get_forecast", BERLIN]),
            say("Istanbul is about 12°C warmer; pack the coat for Berlin."),
        ],
    },
    {
        title: "3. silent — a hidden tool fails, so the client sees nothing",
        ask: "And what about the weather in Wakanda?",
        script: [
            callTool(["geocode_city", { city: "Wakanda" }]),
            say("I couldn't find a place called Wakanda — could you give me a real city name?"),
        ],
    },
    {
        title: "4. visible — the shown tool fails, so the UI can render it",
        ask: "Try Bouvet Island then.",
        script: [
            callTool(["geocode_city", { city: "Bouvet Island" }]),
            callTool(["get_forecast", { label: "Bouvet Island", latitude: -54.42, longitude: 3.36, days: 3 }]),
            say("The forecast service has no data for Bouvet Island — it is a bit off the map."),
        ],
    },
];

let script: Decision[] = [];
const probeDecide: Decide = async (_tools, _messages, turn) => script[turn] ?? say("(script exhausted)");

function check(cond: unknown, msg: string): void {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
    console.log(`     ✓ ${msg}`);
}

async function probe(): Promise<number> {
    decide = probeDecide;
    fetchJson = probeFetch;

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
        const cards = frames.filter(
            (f) => f.type === "genui" && f.chunk.type === "ui" && f.chunk.component === "weather-card",
        );
        check(
            !traced.some((f) => (f.data as { name: string }).name === "geocode_city"),
            "geocode_city stays off the wire (show: false)",
        );

        if (scenario.title.startsWith("1.")) {
            check(cards.length === 1, `one weather-card (got ${cards.length})`);
            const completed = traced.filter((f) => (f.data as { status: string }).status === "completed");
            check(completed.length === 1, "the forecast is traced exactly once");
        }

        if (scenario.title.startsWith("2.")) {
            check(cards.length === 2, `one card per city (got ${cards.length})`);
            const places = cards.map((f) => {
                const chunk = (f as Extract<OutgoingFrame, { type: "genui" }>).chunk;
                return chunk.type === "ui" ? (chunk.props as { place?: string }).place : undefined;
            });
            check(
                places.includes("Istanbul") && places.includes("Berlin"),
                `both cities rendered (got ${places.join(", ")})`,
            );
            const running = traced.filter((f) => (f.data as { status: string }).status === "running");
            check(running.length === 2, `two traced forecasts in one turn (got ${running.length})`);
            const ids = new Set(running.map((f) => (f.data as { id: string }).id));
            check(ids.size === 2, "each call gets its own tool-call id");
        }

        if (scenario.title.startsWith("3.")) {
            check(cards.length === 0, "no card is rendered for a place that does not resolve");
            // The cost of `show: false`, stated as an assertion so it cannot
            // quietly stop being true: a hidden tool's failure is hidden too.
            check(traced.length === 0, "a hidden tool's failure produces NO frame — the UI cannot show it");
            const reply = frames.find((f) => f.type === "text" && f.from === "bot");
            check(reply, "the model still recovers and replies");
            check(
                frames.some((f) => f.type === "run" && f.data.status === "finished"),
                "the run finishes cleanly after the failed lookup",
            );
        }

        if (scenario.title.startsWith("4.")) {
            const failed = traced.find((f) => (f.data as { status: string }).status === "error");
            check(failed, "the shown tool's failure DOES surface as a tool_call error frame");
            check(cards.length === 0, "no card is rendered when the forecast has no data");
            check(
                frames.some((f) => f.type === "text" && f.from === "bot"),
                "the model explains the failure instead of the node crashing",
            );
        }
    }

    console.log("\nrequests the script made:");
    for (const call of calls) console.log(`  ${call}`);

    console.log("\n✅ probe passed — chaining, fan-out, hidden tool and recovery all verified offline");
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
    const handle = serveWs(makeApp(), { port: 8803 });
    console.log("mekik weather desk on ws://localhost:8803 (any path)");
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
