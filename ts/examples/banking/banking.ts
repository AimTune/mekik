// Banking desk — a domain probe. A routed ilmek graph served over mekik, driven
// offline by a scripted model, asserting its own frame stream:
//
//     START → route ─┬→ accounts ───────────────────────────────────────────→ END
//                    ├→ history ────────────────────────────────────────────→ END
//                    └→ payments ─┬→ transfer_approve ─┬→ transfer_execute → END
//                     (runAgent)  │   (1 or 2 pauses)  └→ END (declined)
//                                 └→ END (dispute opened, or held for review)
//
// The payments node is a runAgent loop over a §12 skill catalog in which EACH
// SKILL OWNS ITS TOOLS: the `wire-transfer-rules` entry lists
// check_transfer_limit + transfer_funds, the `dispute-handling` entry lists
// open_dispute (SkillEntry.tools). The model sees only lookup_payee, the
// hidden fraud screen, flag_for_review and load_skill until it loads the skill
// that governs a money tool. Every tool is built once, at module level.
//
//   1. balance    — get_accounts + get_balance traced, a reply, no pause
//   2. transfer   — under the limit: transfer_funds is not offered before
//                   wire-transfer-rules loads, a premature call is refused
//                   without staging anything, the `skill` frame lands before
//                   the transfer trace; ONE approval, executed exactly once
//   3. transfer   — over the limit: the customer approves, then the run parks
//                   AGAIN for a second approver; executed exactly once
//   4. history    — the ledger as a genui-table, including both transfers
//   5. fraud flag — the hidden `fraud_screen` tool (show: false) fails; nothing
//                   reaches the wire, the model reads the failure, routes the
//                   transfer to manual review, and no money moves
//   6. dispute    — dispute-handling unlocks open_dispute (and only that)
//
//   node examples/banking/banking.ts     # offline self-test, exit 0/1

import { channel, command, END, graph, START } from "@ilmek/core";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { mekik } from "@mekik/core";
import type { SkillEntry } from "@mekik/core";
import { runAgent, toolContext, withMekikTools } from "@mekik/langchain";

import {
    botText,
    call,
    check,
    Collector,
    describe,
    errorCode,
    interrupts,
    main,
    runStatus,
    runTools,
    say,
    ScriptedModel,
    section,
    seqOf,
    skillsCatalog,
    skillUses,
    toolNames,
    traces,
    uiChunks,
    user,
} from "../lib/probe-kit.ts";

// ── the bank ──────────────────────────────────────────────────────────────────

/** Transfers above this many dollars need a second approver. */
const SECOND_APPROVER_LIMIT = 5_000;

interface Account {
    id: string;
    kind: "checking" | "savings";
    balanceCents: number;
}

interface Txn {
    date: string;
    description: string;
    amountCents: number;
    accountId: string;
}

const ACCOUNTS: Record<string, Account> = {
    "CHK-001": { id: "CHK-001", kind: "checking", balanceCents: 1_248_055 },
    "SAV-002": { id: "SAV-002", kind: "savings", balanceCents: 4_000_000 },
};

const PAYEES: Record<string, { id: string; name: string; known: boolean }> = {
    grace: { id: "PAY-17", name: "Grace Hopper", known: true },
    "acme rentals": { id: "PAY-31", name: "Acme Rentals Ltd", known: true },
};

const LEDGER: Txn[] = [
    { date: "2026-10-01", description: "Salary", amountCents: 650_000, accountId: "CHK-001" },
    { date: "2026-10-03", description: "Groceries", amountCents: -8_420, accountId: "CHK-001" },
    { date: "2026-10-05", description: "Electricity", amountCents: -11_275, accountId: "CHK-001" },
];

/** Every side effect, counted — the probe asserts each ran exactly as often as it should. */
const effects = { transfer_funds: 0, check_transfer_limit: 0, execute_transfer: 0, fraud_screen: 0, flag_for_review: 0, open_dispute: 0 };
const reviewQueue: string[] = [];
const DISPUTES: Array<{ caseId: string; date: string; description: string; amount: number }> = [];

const dollars = (cents: number): string => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

/** A transfer staged by transfer_funds, waiting for its approvals. No money has moved. */
interface Quote {
    quoteId: string;
    from: string;
    payeeId: string;
    payee: string;
    amountCents: number;
}

/** The bank's staging area: transfers submitted for approval, by conversation. */
const STAGED = new Map<string, Quote>();

// ── tools ─────────────────────────────────────────────────────────────────────
//
// Built once, at module level. A tool that needs the run (to mount UI, or to
// key state by the conversation) reads it from its LangChain config with
// toolContext(config) — the mekik wrapper hands it over on every call — so no
// tool has to be rebuilt per request.

const getAccounts = tool(() => Object.values(ACCOUNTS).map(({ id, kind }) => ({ id, kind })), {
    name: "get_accounts",
    description: "List the customer's accounts.",
    schema: z.object({}),
});

const getBalance = tool(
    ({ accountId }) => {
        const a = ACCOUNTS[accountId];
        if (!a) throw new Error(`No account ${accountId}.`);
        return { accountId, balance: a.balanceCents / 100 };
    },
    { name: "get_balance", description: "Current balance of one account.", schema: z.object({ accountId: z.string() }) },
);

const listTransactions = tool(
    ({ accountId }, config) => {
        const rows = LEDGER.filter((t) => t.accountId === accountId);
        // The rows become a table on screen; the model only gets the count back.
        mekik.genui.table(toolContext(config), {
            title: `Recent activity — ${accountId}`,
            columns: ["Date", "Description", "Amount"],
            rows: rows.map((t) => [t.date, t.description, dollars(t.amountCents)]),
        });
        return { accountId, count: rows.length };
    },
    {
        name: "list_transactions",
        description: "Show an account's recent transactions to the customer as a table.",
        schema: z.object({ accountId: z.string() }),
    },
);

const lookupPayee = tool(
    ({ name }) => {
        const p = PAYEES[name.toLowerCase()];
        return p ?? { id: `PAY-NEW-${name.length}`, name, known: false };
    },
    { name: "lookup_payee", description: "Resolve a payee by name.", schema: z.object({ name: z.string() }) },
);

// Hidden from the client on purpose (policy show: false): a fraud score is not
// something to show a customer, and neither is its failure. An outage comes
// back as an observation the model can act on.
const fraudScreen = tool(
    ({ payeeId, amount }) => {
        effects.fraud_screen++;
        if (!fraudServiceUp) return "Error: fraud screening service timed out";
        return { payeeId, amount, risk: "low" };
    },
    {
        name: "fraud_screen",
        description: "Score a transfer for fraud risk before submitting it.",
        schema: z.object({ payeeId: z.string(), amount: z.number() }),
    },
);

const flagForReview = tool(
    ({ payeeId, amount, reason }) => {
        effects.flag_for_review++;
        const ticket = `REV-${100 + reviewQueue.length}`;
        reviewQueue.push(`${ticket} ${payeeId} ${amount} ${reason}`);
        return { ticket, status: "held" };
    },
    {
        name: "flag_for_review",
        description: "Hold a transfer for manual review by the fraud team.",
        schema: z.object({ payeeId: z.string(), amount: z.number(), reason: z.string() }),
    },
);

const checkTransferLimit = tool(
    ({ amount }) => {
        effects.check_transfer_limit++;
        return { amount, limit: SECOND_APPROVER_LIMIT, needsSecondApprover: amount > SECOND_APPROVER_LIMIT };
    },
    { name: "check_transfer_limit", description: "Does this amount need a second approver?", schema: z.object({ amount: z.number() }) },
);

const transferFunds = tool(
    ({ from, payeeId, payee: name, amount }, config): Quote => {
        effects.transfer_funds++;
        const quote = { quoteId: `Q-${effects.transfer_funds}`, from, payeeId, payee: name, amountCents: Math.round(amount * 100) };
        // Staged per conversation: the run that called the tool says which one.
        STAGED.set(toolContext(config).threadId, quote);
        return quote;
    },
    {
        name: "transfer_funds",
        description: "Submit a transfer for the customer's approval. Money moves only after the required approvals.",
        schema: z.object({ from: z.string(), payeeId: z.string(), payee: z.string(), amount: z.number() }),
    },
);

const openDispute = tool(
    ({ date, description, amount }) => {
        effects.open_dispute++;
        const caseId = `DSP-${500 + DISPUTES.length}`;
        DISPUTES.push({ caseId, date, description, amount });
        return { caseId, status: "open", provisionalCredit: amount };
    },
    {
        name: "open_dispute",
        description: "Open a dispute for a transaction the customer does not recognise.",
        schema: z.object({ date: z.string(), description: z.string(), amount: z.number() }),
    },
);

// ── the skill catalog (§12): each skill is its instructions + the tools it governs ──

/**
 * Level 1 (name, description) is announced to the client; the instructions are
 * read on load; the tools never leave the server, and the payments agent is not
 * offered them until the skill that owns them is loaded.
 */
const SKILLS: SkillEntry<StructuredToolInterface>[] = [
    {
        name: "wire-transfer-rules",
        description: "Rules for sending money: fraud screening, limits, second approvers. Load before any transfer.",
        instructions:
            "1. Screen every transfer with fraud_screen. If screening is unavailable, do NOT transfer: flag_for_review.\n" +
            `2. Call check_transfer_limit. Above $${SECOND_APPROVER_LIMIT.toLocaleString("en-US")} a second approver must co-sign.\n` +
            "3. transfer_funds only submits the transfer for approval; tell the customer money moves after approval.",
        tools: [checkTransferLimit, transferFunds],
    },
    {
        name: "dispute-handling",
        description: "How to open a card or account dispute for a transaction the customer does not recognise.",
        instructions: "Confirm the date, description and amount from the history, then open_dispute. Give the case id.",
        tools: [openDispute],
    },
];

// ── the graph ─────────────────────────────────────────────────────────────────

const model = new ScriptedModel();
let fraudServiceUp = true;

const PAYMENTS =
    "You handle transfers and disputes. Resolve the payee, then follow the skill that governs the request.";

const bank = graph("banking")
    .channel("input", channel.lastWrite<string>(""))
    .channel("quote", channel.lastWrite<Quote | null>(null))
    .channel("reply", channel.lastWrite<string>(""))

    .node("route", async (_s, ctx) => {
        const route = await ctx.step("route:classify", () => model.classify("route"));
        const goto = route === "transfer" || route === "dispute" ? "payments" : route === "history" ? "history" : "accounts";
        return command({ goto });
    })

    .node("accounts", async (s, ctx) => {
        const out = await runTools(ctx, model, "accounts", withMekikTools(ctx, [getAccounts, getBalance]), "Answer balance questions with the account tools.", s.input);
        return { reply: out.text };
    })

    .node("history", async (s, ctx) => {
        const out = await runTools(ctx, model, "history", withMekikTools(ctx, [listTransactions]), "Show transactions with list_transactions.", s.input);
        return { reply: out.text };
    })

    .node("payments", async (s, ctx) => {
        const reply = await runAgent(ctx, model.asChatModel("payments"), {
            system: PAYMENTS,
            input: s.input,
            tools: [lookupPayee, fraudScreen, flagForReview], // always offered
            stream: false,
            // The catalog's skills — and the money tools each one owns, offered only once it is loaded.
            skills: true,
            policy: { fraud_screen: { show: false } },
        });
        // What transfer_funds staged, read once through the journal.
        const quote = await ctx.step("payments:staged", () => {
            const q = STAGED.get(ctx.threadId) ?? null;
            STAGED.delete(ctx.threadId);
            return q;
        });
        if (!quote) return command({ update: { quote: null, reply }, goto: END });
        return command({ update: { quote }, goto: "transfer_approve" });
    })

    // The pauses, in a node of their own: resuming replays only this node, so
    // the agent loop above is neither re-run nor re-emitted.
    .node("transfer_approve", async (s, ctx) => {
        const q = s.quote!;
        const customer = await mekik.approve<{ approved: boolean }>(
            ctx,
            { title: `Send ${dollars(q.amountCents)} to ${q.payee} from ${q.from}?`, quoteId: q.quoteId },
            {
                ui: mekik.genui.card.ref({ title: "Confirm transfer", description: `${dollars(q.amountCents)} → ${q.payee}` }),
                actions: [mekik.action("Send", { approved: true }), mekik.action("Cancel", { approved: false })],
                key: "approve:customer",
            },
        );
        if (!customer.approved) return command({ update: { reply: "Transfer cancelled — nothing was sent." }, goto: END });

        // Over the limit: a second pause, answered by someone else. On the resume
        // that answers it, this node re-runs from the top and the customer's
        // answer above comes back from the journal — no second customer prompt.
        if (q.amountCents > SECOND_APPROVER_LIMIT * 100) {
            const second = await mekik.approve<{ approved: boolean; approverId?: string }>(
                ctx,
                {
                    title: `Second approval required: ${dollars(q.amountCents)} exceeds the ${dollars(SECOND_APPROVER_LIMIT * 100)} limit`,
                    quoteId: q.quoteId,
                    role: "second-approver",
                    limit: SECOND_APPROVER_LIMIT,
                },
                {
                    actions: [mekik.action("Co-sign", { approved: true }), mekik.action("Decline", { approved: false })],
                    key: "approve:second",
                },
            );
            if (!second.approved || !second.approverId) {
                return command({ update: { reply: "The second approver declined — nothing was sent." }, goto: END });
            }
        }
        return command({ goto: "transfer_execute" });
    })

    .node("transfer_execute", async (s, ctx) => {
        const q = s.quote!;
        const receipt = await mekik.tool(ctx, "execute_transfer", { quoteId: q.quoteId, from: q.from, to: q.payeeId, amount: q.amountCents / 100 }, () => {
            effects.execute_transfer++;
            ACCOUNTS[q.from]!.balanceCents -= q.amountCents;
            LEDGER.push({ date: "2026-10-07", description: `Transfer to ${q.payee}`, amountCents: -q.amountCents, accountId: q.from });
            return { reference: `TRF-${effects.execute_transfer}`, balance: ACCOUNTS[q.from]!.balanceCents / 100 };
        });
        return { reply: `Sent ${dollars(q.amountCents)} to ${q.payee}. Reference ${receipt.reference}.` };
    })

    .edge(START, "route")
    .edge("accounts", END)
    .edge("history", END)
    .edge("transfer_execute", END)
    .compile();

function makeApp() {
    return mekik({
        graph: bank,
        input: (frame) => ({ input: frame.data.text }),
        reply: (state) => state.reply as string,
        skills: SKILLS,
        greeting: () => "Hi! Ask for your balance, your recent transactions, a transfer, or a dispute.",
    });
}

// ── the probe ─────────────────────────────────────────────────────────────────

const ALWAYS = "lookup_payee|fraud_screen|flag_for_review|load_skill";
const WIRE = `${ALWAYS}|check_transfer_limit|transfer_funds`;
const roundsFrom = (n: number) => (model.rounds.payments ?? []).slice(n).map((r) => r.join("|"));
const roundCount = () => (model.rounds.payments ?? []).length;

async function probe(): Promise<void> {
    const app = makeApp();
    const c = new Collector("conn-banking");
    await app.connect(c);
    const hello = c.drain();

    section("0. connect — the bank's skill catalog");
    check(skillsCatalog(hello)?.skills?.map((s) => s.name).join("|") === "dispute-handling|wire-transfer-rules", "a `skills` frame lists dispute-handling and wire-transfer-rules");
    check(!JSON.stringify(hello).includes("transfer_funds") && !JSON.stringify(hello).includes("open_dispute"), "…summaries only: the tools each skill owns never leave the server");

    // ── 1. balance via tools ──────────────────────────────────────────────────
    section("1. balance — read-only tools, no pause");
    model.load({
        route: [say("accounts")],
        accounts: [call("get_accounts"), call("get_balance", { accountId: "CHK-001" }), say("Your checking balance is $12,480.55.")],
    });
    user("What's my checking balance?");
    await app.receive(c, { type: "text", data: { text: "What's my checking balance?" } });
    let t = c.drain();
    describe(t);
    check(toolNames(t).join("|") === "get_accounts|get_balance", "get_accounts then get_balance are traced");
    const bal = traces(t, "get_balance").find((f) => f.data.status === "completed");
    check((bal?.data.result as { balance: number }).balance === 12_480.55, "the balance trace carries the ledger value");
    check(interrupts(t).length === 0 && runStatus(t) === "finished", "no pause; the run finishes");
    check(model.toolboxes.accounts?.join("|") === "get_accounts|get_balance", "the accounts node bound only the read tools (always-on, no skill needed)");

    // ── 2. small transfer: skill-held, one pause ──────────────────────────────
    section("2. transfer under the limit — held under wire-transfer-rules, one approval");
    model.load({
        route: [say("transfer")],
        payments: [
            call("lookup_payee", { name: "Grace" }),
            // Premature: the transfer tool is held under a skill not yet loaded.
            call("transfer_funds", { from: "CHK-001", payeeId: "PAY-17", payee: "Grace Hopper", amount: 250 }),
            call("load_skill", { name: "wire-transfer-rules" }),
            call("fraud_screen", { payeeId: "PAY-17", amount: 250 }),
            call("check_transfer_limit", { amount: 250 }),
            call("transfer_funds", { from: "CHK-001", payeeId: "PAY-17", payee: "Grace Hopper", amount: 250 }),
            say("Submitted — approve it and the money goes."),
        ],
    });
    let start = roundCount();
    user("Send $250 to Grace");
    await app.receive(c, { type: "text", data: { text: "Send $250 to Grace" } });
    t = c.drain();
    describe(t);
    let rounds = roundsFrom(start);
    check(rounds.slice(0, 3).every((r) => r === ALWAYS), "transfer_funds is not offered before wire-transfer-rules loads");
    check(
        model.observations.payments?.some((o) => o.includes('Tool transfer_funds belongs to skill "wire-transfer-rules"')) === true,
        "the premature transfer_funds is refused as an observation",
    );
    check(effects.transfer_funds === 1 && new Set(traces(t, "transfer_funds").map((f) => f.data.id)).size === 1, "…and staged nothing: transfer_funds ran once (one trace), after the load");
    check(rounds[3] === WIRE, "from the round after the load: check_transfer_limit + transfer_funds, not open_dispute");
    const skill = skillUses(t)[0];
    check(skill?.data.name === "wire-transfer-rules" && skill.data.status === "loaded", "one `skill` frame: wire-transfer-rules");
    check(seqOf(skill!)! < seqOf(traces(t, "transfer_funds")[0]!)!, "the skill frame lands before the transfer trace");
    let pauses = interrupts(t);
    check(pauses.length === 1, "the run parks on one approval");
    check(pauses[0]!.data.ui?.component === "genui-card", "the approval mounts a confirmation card");
    check(pauses[0]!.data.actions?.map((a) => a.label).join("|") === "Send|Cancel", "with Send / Cancel chips");
    check(!toolNames(t).includes("fraud_screen"), "fraud_screen ran but is never traced (show: false)");
    check(effects.execute_transfer === 0, "no money moved before the customer answered");

    await app.receive(c, { type: "resume", answers: { [pauses[0]!.id]: { approved: true } } });
    t = c.drain();
    describe(t);
    check(interrupts(t).length === 0, "under the limit there is no second approver");
    check(toolNames(t).join("|") === "execute_transfer", "only the execute node ran after the pause");
    check(botText(t)?.startsWith("Sent $250.00 to Grace Hopper") === true, "the reply confirms the transfer");
    check(effects.execute_transfer === 1 && effects.transfer_funds === 1, "staged once, executed once");

    // ── 3. large transfer: two approvers ──────────────────────────────────────
    section(`3. transfer over the ${dollars(SECOND_APPROVER_LIMIT * 100)} limit — customer, then a second approver`);
    model.load({
        route: [say("transfer")],
        payments: [
            call("lookup_payee", { name: "Acme Rentals" }),
            call("load_skill", { name: "wire-transfer-rules" }),
            call("fraud_screen", { payeeId: "PAY-31", amount: 7500 }),
            call("check_transfer_limit", { amount: 7500 }),
            call("transfer_funds", { from: "CHK-001", payeeId: "PAY-31", payee: "Acme Rentals Ltd", amount: 7500 }),
            say("Submitted. This one needs a second approver."),
        ],
    });
    user("Pay Acme Rentals $7,500 for the deposit");
    await app.receive(c, { type: "text", data: { text: "Pay Acme Rentals $7,500 for the deposit" } });
    t = c.drain();
    describe(t);
    const limitTrace = traces(t, "check_transfer_limit").find((f) => f.data.status === "completed");
    check((limitTrace?.data.result as { needsSecondApprover: boolean }).needsSecondApprover === true, "check_transfer_limit (skill-held) flags the second approver");
    pauses = interrupts(t);
    check(pauses.length === 1 && (pauses[0]!.data.payload as { title: string }).title.startsWith("Send $7,500.00"), "first the customer confirms");
    const customerId = pauses[0]!.id;

    console.log("   (customer approves)");
    await app.receive(c, { type: "resume", answers: { [customerId]: { approved: true } } });
    t = c.drain();
    describe(t);
    pauses = interrupts(t);
    check(pauses.length === 1 && pauses[0]!.id !== customerId, "the run parks again, on a new interrupt");
    const secondPayload = pauses[0]!.data.payload as { role: string; limit: number; title: string };
    check(secondPayload.role === "second-approver" && secondPayload.limit === SECOND_APPROVER_LIMIT, "the second pause names the role and the limit");
    check(runStatus(t) === "interrupted", "the run ends interrupted, not finished");
    check(effects.execute_transfer === 1, "still nothing executed for this transfer");
    check(effects.transfer_funds === 2, "the agent loop did not re-run on the customer's resume");

    await app.receive(c, { type: "text", data: { text: "hello?" } });
    check(errorCode(c.drain()) === "interrupted", "a new message while parked is refused (§5.4)");

    console.log("   (second approver OPS-7 co-signs)");
    await app.receive(c, { type: "resume", answers: { [pauses[0]!.id]: { approved: true, approverId: "OPS-7" } } });
    t = c.drain();
    describe(t);
    check(interrupts(t).length === 0, "the customer is not asked again (their answer replays from the journal)");
    check(traces(t, "execute_transfer").some((f) => f.data.status === "completed"), "the transfer executes");
    check(effects.execute_transfer === 2, `exactly one execution per transfer (total ${effects.execute_transfer})`);
    check(ACCOUNTS["CHK-001"]!.balanceCents === 1_248_055 - 25_000 - 750_000, "the checking balance was debited once per transfer");

    // ── 4. history as a genui table ───────────────────────────────────────────
    section("4. history — the ledger as a genui-table");
    model.load({
        route: [say("history")],
        history: [call("list_transactions", { accountId: "CHK-001" }), say("Here is your recent activity.")],
    });
    user("Show my recent transactions");
    await app.receive(c, { type: "text", data: { text: "Show my recent transactions" } });
    t = c.drain();
    describe(t);
    const tables = uiChunks(t, "genui-table");
    check(tables.length === 1, "one genui-table is mounted");
    const table = tables[0]!.props as { columns: string[]; rows: string[][] };
    check(table.columns.join("|") === "Date|Description|Amount", "with Date / Description / Amount columns");
    check(table.rows.length === 5, `5 rows: 3 seeded + 2 transfers (got ${table.rows.length})`);
    check(table.rows.some((r) => r[1] === "Transfer to Acme Rentals Ltd" && r[2] === "$-7,500.00"), "the co-signed transfer is in the history");
    check(!JSON.stringify(traces(t)).includes("Salary"), "the rows travel in the table, not in the tool trace");

    // ── 5. fraud flag: a hidden tool fails silently ───────────────────────────
    section("5. fraud flag — the hidden screen fails, the model recovers");
    fraudServiceUp = false;
    model.load({
        route: [say("transfer")],
        payments: [
            call("lookup_payee", { name: "QuickCash Intl" }),
            call("load_skill", { name: "wire-transfer-rules" }),
            call("fraud_screen", { payeeId: "PAY-NEW-14", amount: 900 }),
            call("flag_for_review", { payeeId: "PAY-NEW-14", amount: 900, reason: "new payee; fraud screen unavailable" }),
            say("I couldn't complete the security check, so I've held this transfer for review (ticket REV-100). Nothing has been sent."),
        ],
    });
    user("Send $900 to QuickCash Intl");
    const before = c.wire.length;
    await app.receive(c, { type: "text", data: { text: "Send $900 to QuickCash Intl" } });
    t = c.drain();
    describe(t);
    check(effects.fraud_screen === 3, "fraud_screen really ran (and failed)");
    check(!c.wire.slice(before).some((f) => f.type === "tool_call" && f.data.name === "fraud_screen"), "…yet no fraud_screen frame reached the wire");
    check(!traces(t).some((f) => f.data.status === "error"), "no error trace at all");
    check(errorCode(t) === undefined && runStatus(t) === "finished", "no error frame; the run finishes normally");
    check(
        model.observations.payments?.some((o) => o === "Error: fraud screening service timed out") === true,
        "the model read the failure as an observation",
    );
    check(toolNames(t).join("|") === "lookup_payee|flag_for_review", "and followed the skill: flag for review, no transfer_funds");
    check(interrupts(t).length === 0 && effects.execute_transfer === 2 && effects.transfer_funds === 2, "no approval was asked for, nothing staged, no money moved");
    check(reviewQueue.length === 1 && reviewQueue[0]!.startsWith("REV-100 PAY-NEW-14 900"), "the review queue holds the transfer");
    check(botText(t)?.includes("held this transfer for review") === true, "the customer is told what happened");
    fraudServiceUp = true;

    // ── 6. dispute: the other skill, the other tool ───────────────────────────
    section("6. dispute — dispute-handling unlocks open_dispute");
    model.load({
        route: [say("dispute")],
        payments: [
            call("load_skill", { name: "dispute-handling" }),
            call("open_dispute", { date: "2026-10-05", description: "Electricity", amount: 112.75 }),
            say("I've opened dispute DSP-500 for the $112.75 Electricity charge; you'll see a provisional credit."),
        ],
    });
    start = roundCount();
    user("I don't recognise the $112.75 electricity charge");
    await app.receive(c, { type: "text", data: { text: "I don't recognise the $112.75 electricity charge" } });
    t = c.drain();
    describe(t);
    rounds = roundsFrom(start);
    check(rounds[0] === ALWAYS, "open_dispute is not offered before dispute-handling loads");
    check(rounds[1] === `${ALWAYS}|open_dispute`, "then only open_dispute joins — the transfer tools stay locked");
    check(skillUses(t).map((f) => f.data.name).join("|") === "dispute-handling", "one `skill` frame: dispute-handling");
    check(effects.open_dispute === 1 && DISPUTES[0]?.caseId === "DSP-500", "the dispute is opened once");
    check(interrupts(t).length === 0 && runStatus(t) === "finished", "no approval needed; the run finishes");

    console.log(`\nside effects: ${JSON.stringify(effects)}`);
    console.log("\n✅ banking probe passed — skill-held money tools, one- and two-approver transfers, exactly-once execution, a genui-table history, a silent fraud-tool failure, and a dispute all verified");
}

main(probe);
