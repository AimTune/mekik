// Support desk — a domain probe. A routed ilmek graph served over mekik that
// talks to two OTHER agents, driven offline by a scripted model:
//
//     START → route ─┬→ billing ─────────────────────────────────────→ END
//                    ├→ tech ─┬──────────────────────────────────────→ END
//                    │        └→ handoff (A2A, §14) — may pause ─────→ END
//                    └→ chat ────────────────────────────────────────→ END
//
//   knowledge base   another mekik app, served as MCP tools (MekikMcpServer,
//                    §13.2) and consumed by the tech node through
//                    `withMcpTools` (§13.1) — a kb__search tool_call trace
//   specialist       another mekik app, served as an A2A agent
//                    (MekikA2aServer, §14); the desk hands a case over with
//                    message/send, and when the specialist pauses for consent
//                    the desk asks ITS human and forwards the answer on the
//                    same task
//
//   1. billing — invoice + credit tools; the node sees only billing tools
//   2. tech    — an MCP knowledge-base lookup, diagnostics, then an A2A hand-off
//                whose consent question becomes the desk's own pause
//   3. chat    — no tools at all
//
// Skills (§12), tag-scoped per route: `refund-policy` (billing) holds
// issue_credit via runAgent `skillTools`; `incident-runbook` (tech) holds
// escalate_to_specialist via the hand-wired form — withSkills(ctx, filter,
// { toolNames }) plus the probe kit's runTools gating — because the tech
// loop's MCP tools come pre-wrapped by withMcpTools. Each node's prompt,
// load_skill and skill frames only ever involve its own tag.
//
// Both peers are reached through a JSON-RPC seam that serializes every message
// (`rpc`), so the probe exercises the real request/response shapes without a
// socket; in production that seam is an HTTP POST to serveMcp / serveA2a.
//
//   node examples/support-desk/support.ts     # offline self-test, exit 0/1

import { channel, command, END, graph, START } from "@ilmek/core";
import type { Context } from "@ilmek/core";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { mekik, MekikA2aServer, MekikMcpServer } from "@mekik/core";
import type { A2aTask, McpCallToolResult, McpPendingView, MessageAction, SkillEntry } from "@mekik/core";
import { runAgent, withMcpTools, withMekikTools, withSkills } from "@mekik/langchain";
import type { McpToolboxLike } from "@mekik/langchain";

import {
    botText,
    call,
    check,
    Collector,
    describe,
    interrupts,
    main,
    runStatus,
    runTools,
    say,
    ScriptedModel,
    section,
    skillsCatalog,
    skillUses,
    toolNames,
    traces,
    user,
} from "../lib/probe-kit.ts";

// ── a JSON-RPC seam: every message is serialized, as it would be over HTTP ────

/** Send one JSON-RPC message; a `notify` message carries no id and gets no response. */
type Rpc = (message: { method: string; params?: unknown }, notify?: boolean) => Promise<any>;

const wireLog: Array<{ peer: string; method: string }> = [];

function rpcTo(peer: string, handle: (m: unknown) => Promise<unknown>): Rpc {
    let id = 0;
    return async (message, notify = false) => {
        const request = { jsonrpc: "2.0", ...(notify ? {} : { id: ++id }), ...message };
        wireLog.push({ peer, method: message.method });
        const response = await handle(JSON.parse(JSON.stringify(request)));
        return response === null ? null : JSON.parse(JSON.stringify(response));
    };
}

// ── peer 1: the knowledge base, a mekik app served as MCP tools ───────────────

const ARTICLES = [
    { id: "KB-112", title: "VPN drops every few minutes", body: "Disable 'Wi-Fi power saving' and update the client to 6.2+. If it persists, the line may be unstable." },
    { id: "KB-140", title: "Resetting your password", body: "Use 'Forgot password' on the sign-in page." },
];
const kbEffects = { search_articles: 0 };

const kbGraph = graph("kb")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("lookup", async (s, ctx) => {
        const hits = await mekik.tool(ctx, "search_articles", { q: s.input }, () => {
            kbEffects.search_articles++;
            const words = s.input.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
            return ARTICLES.filter((a) => words.some((w) => a.title.toLowerCase().includes(w)));
        });
        return { reply: hits.map((a) => `${a.id} ${a.title}: ${a.body}`).join("\n") || "No article matches." };
    })
    .edge(START, "lookup")
    .edge("lookup", END)
    .compile();

const kbServer = new MekikMcpServer(mekik({ graph: kbGraph, reply: (s) => s.reply as string }), {
    name: "search",
    description: "Search the support knowledge base.",
    serverInfo: { name: "kb", version: "1.0.0" },
});

/**
 * An MCP client in the shape `withMcpTools` takes (`@ilmek/mcp`'s McpToolbox,
 * structurally): list once, expose under `<server>__<tool>`, keep only the
 * allowed tools, invoke raw — journaling is the wrapper's job.
 */
async function connectMcp(name: string, rpc: Rpc, allow: readonly string[]): Promise<McpToolboxLike> {
    await rpc({ method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "support-desk", version: "1" } } });
    await rpc({ method: "notifications/initialized" }, true);
    const listed = (await rpc({ method: "tools/list" })).result.tools as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    const tools = listed
        .filter((t) => allow.includes(t.name))
        .map((t) => ({ name: `${name}__${t.name}`, description: t.description, inputSchema: t.inputSchema }));
    return {
        name,
        tools: () => tools,
        invoke: async (exposed, args) => {
            const res = await rpc({ method: "tools/call", params: { name: exposed.slice(name.length + 2), arguments: args } });
            const r = res.result as McpCallToolResult;
            return { text: r.content.map((c) => c.text).join("\n"), structured: r.structuredContent as unknown as Record<string, unknown>, isError: r.isError === true };
        },
    };
}

// ── peer 2: the network specialist, a mekik app served as an A2A agent ────────

const specialistEffects = { line_test: 0, reboot_router: 0 };

const specialistGraph = graph("network-specialist")
    .channel("input", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))
    .node("diagnose", async (s, ctx) => {
        const test = await mekik.tool(ctx, "line_test", { case: s.input.slice(0, 40) }, () => {
            specialistEffects.line_test++;
            return { router: "RT-88", packetLoss: 0.12, firmware: "4.1.0" };
        });
        const ok = await mekik.choose(
            ctx,
            { title: `Router ${test.router} shows ${test.packetLoss * 100}% packet loss. May I reboot it remotely? (2 minutes offline)` },
            [mekik.action("Approve", { approved: true }), mekik.action("Decline", { approved: false })],
        );
        if (!ok.approved) return { reply: "Understood — no changes made. Try again after updating the VPN client." };
        await mekik.tool(ctx, "reboot_router", { router: test.router }, () => {
            specialistEffects.reboot_router++;
            return { router: test.router, rebooted: true };
        });
        return { reply: `Router ${test.router} rebooted and updated; the line test is clean (0% loss).` };
    })
    .edge(START, "diagnose")
    .edge("diagnose", END)
    .compile();

const specialist = new MekikA2aServer(mekik({ graph: specialistGraph, reply: (s) => s.reply as string }), {
    name: "network-specialist",
    description: "Diagnoses and fixes home-network faults: line tests, router reboots, firmware.",
    url: "http://specialist.internal/a2a",
    version: "2.3.0",
});

// ── the desk ──────────────────────────────────────────────────────────────────

const model = new ScriptedModel();
const deskEffects = { get_invoice: 0, issue_credit: 0, run_diagnostics: 0 };

const kbRpc = rpcTo("kb", (m) => kbServer.handle(m));
const a2aRpc = rpcTo("specialist", (m) => specialist.handle(m));
const kb = await connectMcp("kb", kbRpc, ["search"]); // `search__resume` is deliberately not exposed
const card = specialist.agentCard(); // in production: GET /.well-known/agent-card.json

async function a2aSend(message: Record<string, unknown>): Promise<A2aTask> {
    const res = await a2aRpc({ method: "message/send", params: { message: { kind: "message", role: "user", messageId: `desk-${wireLog.length}`, ...message } } });
    if (res.error) throw new Error(`A2A ${res.error.code}: ${res.error.message}`);
    return res.result as A2aTask;
}

/**
 * The desk's skill catalog (§12), tag-scoped per route: each routed node asks
 * only for its own tag, so its prompt, its load_skill tool and its skill frames
 * only ever involve its own skills. Each skill holds the tool it governs.
 */
const SKILLS: SkillEntry[] = [
    {
        name: "refund-policy",
        description: "When and how much to credit back: duplicates, outages, goodwill limits.",
        instructions: "Credit duplicate charges in full with issue_credit and quote the credit note. Goodwill credits are capped at $30.",
        tags: ["billing"],
    },
    {
        name: "incident-runbook",
        description: "Tier-1 runbook for connectivity faults: KB first, diagnostics, then when to escalate.",
        instructions:
            "Search the knowledge base, run diagnostics. If the line flaps more than 10 times in 24h, the KB fix is not enough: " +
            "escalate_to_specialist with a one-line summary.",
        tags: ["tech"],
    },
];

/** The billing node's tools, unwrapped — runAgent wraps them. issue_credit is held under refund-policy. */
function billingTools() {
    const invoice = tool(
        ({ invoiceId }) => {
            deskEffects.get_invoice++;
            return { invoiceId, amount: 59.9, lines: [{ item: "Fibre 500", amount: 39.9 }, { item: "Router rental (duplicate)", amount: 20 }] };
        },
        { name: "get_invoice", description: "Fetch an invoice.", schema: z.object({ invoiceId: z.string() }) },
    );
    const credit = tool(
        ({ invoiceId, amount, reason }) => {
            deskEffects.issue_credit++;
            return { invoiceId, credited: amount, reason, creditNote: "CN-2209" };
        },
        {
            name: "issue_credit",
            description: "Credit part of an invoice back to the customer.",
            schema: z.object({ invoiceId: z.string(), amount: z.number(), reason: z.string() }),
        },
    );
    return { invoice, credit };
}

/**
 * The tech node's tools. This loop is hand-wired rather than runAgent because
 * its MCP tools come pre-wrapped by `withMcpTools`, so skills are wired the
 * documented way for such loops: `withSkills(ctx, filter, { toolNames })`
 * supplies load_skill (naming what a load unlocks), and the loop holds
 * escalate_to_specialist back until incident-runbook is loaded.
 */
function techTools(ctx: Context<any>): { tools: StructuredToolInterface[]; held: Record<string, StructuredToolInterface[]> } {
    const diag = tool(
        ({ customerId }) => {
            deskEffects.run_diagnostics++;
            return { customerId, vpnClient: "6.0.3", wifiPowerSaving: false, lineFlaps24h: 31 };
        },
        { name: "run_diagnostics", description: "Remote diagnostics for a customer's line.", schema: z.object({ customerId: z.string() }) },
    );
    const escalate = tool(({ summary }) => ({ escalated: true, summary }), {
        name: "escalate_to_specialist",
        description: "Hand the case to the network specialist agent.",
        schema: z.object({ summary: z.string() }),
    });
    // Per-node scoping: the KB comes in over MCP, the rest are local — and none
    // of the billing tools (or skills) are in here.
    return {
        tools: [
            ...withMcpTools(ctx, kb),
            ...withMekikTools(ctx, [diag]),
            ...withSkills(ctx, { tags: ["tech"] }, { toolNames: { "incident-runbook": ["escalate_to_specialist"] } }),
        ],
        held: { "incident-runbook": withMekikTools(ctx, [escalate]) },
    };
}

const desk = graph("support-desk")
    .channel("input", channel.lastWrite<string>(""))
    .channel("summary", channel.lastWrite<string>(""))
    .channel("reply", channel.lastWrite<string>(""))

    .node("route", async (_s, ctx) => {
        const route = await ctx.step("route:classify", () => model.classify("route"));
        return command({ goto: route === "billing" || route === "tech" ? route : "chat" });
    })

    .node("billing", async (s, ctx) => {
        const { invoice, credit } = billingTools();
        const reply = await runAgent(ctx, model.asChatModel("billing"), {
            system: "You handle invoices and credits.",
            input: s.input,
            tools: [invoice],
            stream: false,
            skills: { tags: ["billing"] },
            skillTools: { "refund-policy": [credit] },
        });
        return { reply };
    })

    .node("tech", async (s, ctx) => {
        const { tools, held } = techTools(ctx);
        const out = await runTools(
            ctx,
            model,
            "tech",
            tools,
            "You are tier-1 tech support. Follow the incident runbook.\n\n" + mekik.skillsPrompt(ctx, { tags: ["tech"] }),
            s.input,
            { skillTools: held },
        );
        const esc = out.results.escalate_to_specialist as { summary: string } | undefined;
        if (esc) return command({ update: { summary: esc.summary, reply: out.text }, goto: "handoff" });
        return command({ update: { reply: out.text }, goto: END });
    })

    // The A2A hand-off, in a node of its own so a resume replays only this.
    .node("handoff", async (s, ctx) => {
        let task = await mekik.tool(ctx, "a2a_handoff", { agent: card.name, summary: s.summary }, () =>
            a2aSend({ parts: [{ kind: "text", text: s.summary }] }),
        );
        if (task.status.state === "input-required") {
            // The specialist needs consent it cannot get itself: ask the desk's
            // human, with the specialist's own question and chips, then forward
            // the answer on the same task.
            const asked = (task.metadata?.pending as McpPendingView[])[0]!;
            const answer = await mekik.approve<Record<string, unknown>>(
                ctx,
                { title: (asked.payload as { title: string }).title, from: card.name, taskId: task.id },
                { actions: asked.actions as MessageAction[], key: "a2a:consent" },
            );
            task = await mekik.tool(ctx, "a2a_answer", { agent: card.name, taskId: task.id }, () =>
                a2aSend({ taskId: task.id, contextId: task.contextId, parts: [{ kind: "data", data: answer }] }),
            );
        }
        const text = task.artifacts?.flatMap((a) => a.parts).map((p) => (p.kind === "text" ? p.text : "")).join(" ").trim();
        return { reply: `${card.name}: ${text || task.status.state}` };
    })

    .node("chat", async () => ({ reply: "I can help with bills, or with your connection." }))

    .edge(START, "route")
    .edge("billing", END)
    .edge("handoff", END)
    .edge("chat", END)
    .compile();

function makeApp() {
    return mekik({
        graph: desk,
        input: (frame) => ({ input: frame.data.text }),
        reply: (state) => state.reply as string,
        skills: SKILLS,
        greeting: () => "Support desk here — billing or a technical problem?",
    });
}

// ── the probe ─────────────────────────────────────────────────────────────────

const count = (peer: string, method: string) => wireLog.filter((w) => w.peer === peer && w.method === method).length;

async function probe(): Promise<void> {
    section("0. startup — the desk connects to its peers");
    check(count("kb", "initialize") === 1 && count("kb", "tools/list") === 1, "MCP: initialize, then tools/list on the knowledge base");
    check(kb.tools().map((t) => t.name).join("|") === "kb__search", "the KB's tools are exposed as kb__search (its resume tool is not allowed in)");
    check(card.name === "network-specialist" && card.preferredTransport === "JSONRPC", "A2A: the specialist's Agent Card names it and its transport");

    const app = makeApp();
    const c = new Collector("conn-support");
    await app.connect(c);
    const hello = c.drain();
    check(skillsCatalog(hello)?.skills?.map((s) => `${s.name}:${s.tags?.join(",")}`).join("|") === "incident-runbook:tech|refund-policy:billing", "the desk's `skills` frame: incident-runbook (tech), refund-policy (billing)");

    // ── 1. billing ────────────────────────────────────────────────────────────
    section("1. billing — invoice and credit; refund-policy holds the credit tool");
    model.load({
        route: [say("billing")],
        billing: [
            call("get_invoice", { invoiceId: "INV-5531" }),
            // A tech skill, asked for from the billing node: hidden by the tag filter.
            call("load_skill", { name: "incident-runbook" }),
            call("load_skill", { name: "refund-policy" }),
            call("issue_credit", { invoiceId: "INV-5531", amount: 20, reason: "duplicate router rental" }),
            say("I've credited the duplicate $20 router rental (credit note CN-2209)."),
        ],
    });
    user("I was charged twice for the router on INV-5531");
    await app.receive(c, { type: "text", data: { text: "I was charged twice for the router on INV-5531" } });
    let t = c.drain();
    describe(t);
    check(toolNames(t).join("|") === "get_invoice|issue_credit", "get_invoice then issue_credit are traced");
    const billingRounds = (model.rounds.billing ?? []).map((r) => r.join("|"));
    check(billingRounds.slice(0, 3).every((r) => r === "get_invoice|load_skill"), "issue_credit is not offered before refund-policy loads");
    check(billingRounds[3] === "get_invoice|load_skill|issue_credit", "then it is — and no tech tool ever is");
    const billingSys = model.systems.billing ?? "";
    check(billingSys.includes("<name>refund-policy</name>") && !billingSys.includes("incident-runbook"), "tag scoping: the billing prompt lists refund-policy, not the tech skill");
    check(model.observations.billing?.some((o) => o.startsWith('Unknown skill "incident-runbook"')) === true, "tag scoping: loading the tech skill from billing is refused");
    check(skillUses(t).map((f) => f.data.name).join("|") === "refund-policy", "the only `skill` frame on the billing turn is refund-policy");
    check(count("kb", "tools/call") === 0 && count("specialist", "message/send") === 0, "no peer was contacted");

    // ── 2. tech: MCP lookup, then an A2A hand-off ─────────────────────────────
    section("2. tech — an MCP knowledge-base lookup, the incident runbook, then a hand-off over A2A");
    model.load({
        route: [say("tech")],
        tech: [
            call("kb__search", { message: "VPN drops every few minutes" }),
            call("run_diagnostics", { customerId: "CUS-88" }),
            // A billing skill, asked for from the tech node: hidden by the tag filter.
            call("load_skill", { name: "refund-policy" }),
            call("load_skill", { name: "incident-runbook" }),
            call("escalate_to_specialist", { summary: "CUS-88: VPN drops every few minutes; client 6.0.3, power saving off, 31 line flaps in 24h. KB-112 applied." }),
            say("The knowledge base fix doesn't cover a flapping line, so I'm bringing in our network specialist."),
        ],
    });
    user("My VPN keeps dropping every few minutes");
    await app.receive(c, { type: "text", data: { text: "My VPN keeps dropping every few minutes" } });
    t = c.drain();
    describe(t);

    const techRounds = (model.rounds.tech ?? []).map((r) => r.join("|"));
    check(techRounds.slice(0, 4).every((r) => r === "kb__search|run_diagnostics|load_skill"), "the tech node offers the MCP tool and its own — escalation held back, no billing tools");
    check(techRounds[4] === "kb__search|run_diagnostics|load_skill|escalate_to_specialist", "escalate_to_specialist joins once incident-runbook is loaded (hand-wired withSkills + toolNames)");
    const techSys = model.systems.tech ?? "";
    check(techSys.includes("<name>incident-runbook</name>") && !techSys.includes("refund-policy"), "tag scoping: the tech prompt lists incident-runbook, not the billing skill");
    check(model.observations.tech?.some((o) => o.startsWith('Unknown skill "refund-policy"')) === true, "tag scoping: loading the billing skill from tech is refused");
    check(
        model.observations.tech?.some((o) => o.includes("Tools now available from skill incident-runbook: escalate_to_specialist.")) === true,
        "the load_skill observation names the unlocked tool",
    );
    check(skillUses(t).map((f) => f.data.name).join("|") === "incident-runbook", "the only `skill` frame on the tech turn is incident-runbook");
    const kbTrace = traces(t, "kb__search").find((f) => f.data.status === "completed");
    check(String(kbTrace?.data.result).includes("KB-112"), "kb__search is a tool_call trace whose result is the KB agent's reply");
    check(count("kb", "tools/call") === 1 && kbEffects.search_articles === 1, "one MCP tools/call, one search inside the KB app");
    check(!toolNames(t).includes("search_articles"), "the KB app's own trace stays in its own conversation");

    check(count("specialist", "message/send") === 1, "A2A: one message/send hands the case over");
    const handoff = traces(t, "a2a_handoff").find((f) => f.data.status === "completed")?.data.result as A2aTask;
    check(handoff.status.state === "input-required", "the specialist's task comes back input-required");
    check(specialistEffects.line_test === 1 && specialistEffects.reboot_router === 0, "it ran its line test and stopped before rebooting");
    const consent = interrupts(t)[0];
    check(consent !== undefined && runStatus(t) === "interrupted", "the desk parks on its own interrupt");
    const consentPayload = consent!.data.payload as { title: string; from: string; taskId: string };
    check(consentPayload.from === "network-specialist" && consentPayload.title.startsWith("Router RT-88 shows 12% packet loss"), "carrying the specialist's question");
    check(consent!.data.actions?.map((a) => a.label).join("|") === "Approve|Decline", "and the specialist's own chips");

    console.log("   (customer approves the reboot)");
    await app.receive(c, { type: "resume", answers: { [consent!.id]: { approved: true } } });
    t = c.drain();
    describe(t);
    check(count("specialist", "message/send") === 2, "A2A: exactly one more message/send — the answer; the hand-off was not resent (journaled)");
    const answered = traces(t, "a2a_answer").find((f) => f.data.status === "completed")?.data.result as A2aTask;
    check(answered.id === handoff.id && answered.contextId === handoff.contextId, "same task id, same context");
    check(answered.status.state === "completed", "the task completes");
    check(specialistEffects.reboot_router === 1 && specialistEffects.line_test === 1, "the specialist rebooted once; its line test did not re-run");
    check(botText(t) === "network-specialist: Router RT-88 rebooted and updated; the line test is clean (0% loss).", "the desk relays the specialist's answer");
    check(count("kb", "tools/call") === 1 && deskEffects.run_diagnostics === 1, "the resume replayed only the hand-off node: no second KB call or diagnostics");
    check(!toolNames(t).includes("kb__search"), "…and kb__search was not re-emitted");

    // ── 3. chat ───────────────────────────────────────────────────────────────
    section("3. chat — no tools");
    model.load({ route: [say("chat")] });
    const askedBefore = model.asked;
    user("thanks!");
    await app.receive(c, { type: "text", data: { text: "thanks!" } });
    t = c.drain();
    describe(t);
    check(toolNames(t).length === 0 && model.asked === askedBefore + 1, "only the router asked the model; no tools ran");

    console.log(`\npeer traffic: ${wireLog.map((w) => `${w.peer}:${w.method}`).join(", ")}`);
    console.log("\n✅ support-desk probe passed — routing, per-node tool scoping, tag-scoped skills per route, an MCP knowledge-base tool, and an A2A hand-off with a relayed consent pause all verified");
}

main(probe);
