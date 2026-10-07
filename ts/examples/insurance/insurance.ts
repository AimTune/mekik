// Insurance claims desk — a domain probe. An ilmek graph served over mekik,
// driven offline by a scripted model, asserting its own frame stream:
//
//     START → intake (genui-form pause) → assess (runAgent + skills) → END
//
//   1. intake    — the claim form is a pause: an interrupt that mounts a
//                  genui-form; the submitted values are the resume answer
//   2. approve   — the adjuster model looks up the policy and LOADS A SKILL
//                  mid-run. Each skill in the catalog OWNS its decision tools
//                  (SkillEntry.tools, §12): not offered before the load,
//                  a premature call is refused without running, offered from
//                  the next round on — and still offered after the senior
//                  adjuster's sign-off pause and resume
//   3. reject    — a flood claim on a policy that excludes floods: a different
//                  skill unlocks a different decision tool, and the rejection
//                  carries a typed reason (code + clause) on the wire
//
// The server's skill catalog is announced on connect (`skills` frame, level 1
// only) and the node only offers the skills tagged for home claims.
//
//   node examples/insurance/insurance.ts     # offline self-test, exit 0/1

import { channel, END, graph, START } from "@ilmek/core";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { mekik } from "@mekik/core";
import type { OutgoingFrame, SkillEntry } from "@mekik/core";
import { runAgent, toolContext } from "@mekik/langchain";

import {
    botText,
    call,
    check,
    Collector,
    describe,
    interrupts,
    main,
    runStatus,
    say,
    ScriptedModel,
    section,
    seqOf,
    skillsCatalog,
    skillUses,
    traces,
    uiChunks,
    user,
} from "../lib/probe-kit.ts";

// ── the insurer ───────────────────────────────────────────────────────────────

interface Policy {
    number: string;
    holder: string;
    status: "active" | "lapsed";
    deductible: number;
    covered: string[];
    exclusions: Record<string, string>; // peril → policy clause
}

const POLICIES: Record<string, Policy> = {
    "POL-1001": {
        number: "POL-1001",
        holder: "Ada Lovelace",
        status: "active",
        deductible: 500,
        covered: ["burst pipe", "fire", "theft"],
        exclusions: { flood: "4.2(b)" },
    },
    "POL-2002": {
        number: "POL-2002",
        holder: "Alan Turing",
        status: "active",
        deductible: 1000,
        covered: ["fire", "theft", "burst pipe"],
        exclusions: { flood: "4.2(b)", earthquake: "4.2(c)" },
    },
};

/** The rejection codes a decision may carry — the type the wire is held to. */
const REJECTION_CODES = ["EXCLUDED_PERIL", "POLICY_LAPSED", "BELOW_DEDUCTIBLE"] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

export interface RejectionReason {
    code: RejectionCode;
    clause: string;
    detail: string;
}

/** What the `claim-decision` component renders — approved with a payout, or rejected with a typed reason. */
export type ClaimDecision =
    | { claimId: string; outcome: "approved"; payout: number }
    | { claimId: string; outcome: "rejected"; reason: RejectionReason };

/** Bound once, typed: the compiler checks every emission's props. */
const claimDecision = mekik.component<ClaimDecision>("claim-decision");

/** What the claim form submits. Form fields arrive as strings. */
interface ClaimForm {
    policyNumber: string;
    incidentDate: string;
    peril: string;
    estimate: string;
    description: string;
}

const CLAIMS: ClaimDecision[] = [];
const effects = { lookup_policy: 0, check_coverage: 0, approve_claim: 0, reject_claim: 0 };

// ── tools ─────────────────────────────────────────────────────────────────────
//
// Built once, at module level. The decision tools mount the claim-decision
// card on the run that called them, read with toolContext(config).

/** Always offered: the policy lookup. */
const lookupPolicy = tool(
    ({ policyNumber }) => {
        effects.lookup_policy++;
        const p = POLICIES[policyNumber];
        if (!p) throw new Error(`No policy ${policyNumber}.`);
        return p;
    },
    { name: "lookup_policy", description: "Fetch a policy by number.", schema: z.object({ policyNumber: z.string() }) },
);

const checkCoverage = tool(
    ({ policyNumber, peril }) => {
        effects.check_coverage++;
        const p = POLICIES[policyNumber];
        if (!p) throw new Error(`No policy ${policyNumber}.`);
        const clause = p.exclusions[peril];
        return clause
            ? { covered: false, exclusionClause: clause, deductible: p.deductible }
            : { covered: p.covered.includes(peril), deductible: p.deductible };
    },
    {
        name: "check_coverage",
        description: "Is this peril covered by the policy? Returns the deductible and any exclusion clause.",
        schema: z.object({ policyNumber: z.string(), peril: z.string() }),
    },
);

// The decision tools emit the claim-decision component themselves: their
// bodies run exactly once (journaled), so the card is mounted exactly once.
const approveClaim = tool(
    ({ payout }, config): ClaimDecision => {
        effects.approve_claim++;
        const decision: ClaimDecision = { claimId: `CLM-${7000 + CLAIMS.length}`, outcome: "approved", payout };
        CLAIMS.push(decision);
        claimDecision(toolContext(config), decision);
        return decision;
    },
    {
        name: "approve_claim",
        description: "Approve the claim with a payout.",
        schema: z.object({ policyNumber: z.string(), payout: z.number() }),
    },
);

const rejectClaim = tool(
    ({ reason }, config): ClaimDecision => {
        effects.reject_claim++;
        const decision: ClaimDecision = { claimId: `CLM-${7000 + CLAIMS.length}`, outcome: "rejected", reason };
        CLAIMS.push(decision);
        claimDecision(toolContext(config), decision);
        return decision;
    },
    {
        name: "reject_claim",
        description: "Decline the claim with a typed reason.",
        schema: z.object({
            policyNumber: z.string(),
            reason: z.object({ code: z.enum(REJECTION_CODES), clause: z.string(), detail: z.string() }),
        }),
    },
);

// ── the skill catalog (§12): each skill is its instructions + the tools it governs ──

/**
 * Level 1 travels to the client; the instructions stay here until loaded, and
 * the tools never leave the server. check_coverage sits under both home skills
 * (loading either one unlocks it); each skill owns its own decision tool.
 */
const SKILLS: SkillEntry<StructuredToolInterface>[] = [
    {
        name: "water-damage-assessment",
        description: "How to assess an escape-of-water claim (burst pipes, leaks): evidence, deductible, payout.",
        instructions:
            "1. Confirm the peril is a sudden escape of water, not gradual seepage.\n" +
            "2. Payout = estimate minus the policy deductible, capped at the estimate.\n" +
            "3. Record it with approve_claim before replying.",
        tags: ["home"],
        tools: [checkCoverage, approveClaim],
    },
    {
        name: "rejection-letter",
        description: "How to decline a claim: cite the exclusion clause and a typed reason code.",
        instructions:
            "Decline with reject_claim, using a reason code from EXCLUDED_PERIL, POLICY_LAPSED, BELOW_DEDUCTIBLE. " +
            "Quote the policy clause. Be plain and kind; tell the customer how to appeal.",
        tags: ["home"],
        tools: [checkCoverage, rejectClaim],
    },
    {
        name: "auto-collision",
        description: "How to assess a motor collision claim.",
        instructions: "Ask for the other party's details and the police report number.",
        tags: ["auto"],
    },
];

// ── the graph ─────────────────────────────────────────────────────────────────

const model = new ScriptedModel();

const ADJUSTER =
    "You are a home-insurance claims adjuster. Look up the policy, load the skill that matches the claim, " +
    "check coverage, record the decision, then explain it to the customer in two sentences.";

/** Every decision needs a senior adjuster's sign-off — a pause in the middle of the agent loop. */
const SIGN_OFF = { title: "Senior adjuster sign-off" };

const claims = graph("insurance")
    .channel("input", channel.lastWrite<string>(""))
    .channel("claim", channel.lastWrite<ClaimForm | null>(null))
    .channel("reply", channel.lastWrite<string>(""))

    // The intake form IS the pause: the node parks on an interrupt that mounts
    // a genui-form, and the submitted values come back as the resume answer.
    .node("intake", async (_s, ctx) => {
        const claim = await mekik.approve<ClaimForm>(
            ctx,
            { title: "Tell us what happened" },
            {
                ui: mekik.genui.form.ref({
                    title: "Home insurance claim",
                    fields: [
                        { name: "policyNumber", label: "Policy number", type: "text", required: true },
                        { name: "incidentDate", label: "Date of incident", type: "date", required: true },
                        { name: "peril", label: "What caused the damage?", type: "text", required: true },
                        { name: "estimate", label: "Repair estimate (USD)", type: "number", required: true },
                        { name: "description", label: "Describe the damage", type: "textarea" },
                    ],
                    buttonText: "Submit claim",
                }),
                key: "intake",
            },
        );
        return { claim };
    })

    .node("assess", async (s, ctx) => {
        const c = s.claim!;
        const reply = await runAgent(ctx, model.asChatModel("assess"), {
            system: ADJUSTER,
            input: `Claim on ${c.policyNumber}: ${c.peril} on ${c.incidentDate}, estimate $${c.estimate}. ${c.description}`,
            tools: [lookupPolicy], // always offered
            stream: false,
            // Level 1 in the prompt (home skills only) + load_skill — and each
            // skill's own tools, offered only once that skill is loaded.
            skills: { tags: ["home"] },
            policy: { approve_claim: { approve: SIGN_OFF }, reject_claim: { approve: SIGN_OFF } },
        });
        return { reply };
    })

    .edge(START, "intake")
    .edge("intake", "assess")
    .edge("assess", END)
    .compile();

function makeApp() {
    return mekik({
        graph: claims,
        input: (frame) => ({ input: frame.data.text }),
        reply: (state) => state.reply as string,
        skills: SKILLS,
        greeting: () => "Hi! Tell me you'd like to file a claim and I'll open the form.",
    });
}

// ── the probe ─────────────────────────────────────────────────────────────────

const ALWAYS = "lookup_policy|load_skill";
const offered = (from: number) => (model.rounds.assess ?? []).slice(from).map((r) => r.join("|"));

/** The intake turn: the form pause, then the submitted form. Returns the frames after the submit. */
async function fileClaim(app: ReturnType<typeof makeApp>, c: Collector, form: ClaimForm): Promise<OutgoingFrame[]> {
    user("I'd like to file a claim");
    await app.receive(c, { type: "text", data: { text: "I'd like to file a claim" } });
    const t = c.drain();
    describe(t);
    const pause = interrupts(t)[0];
    check(pause?.data.ui?.component === "genui-form", "the run parks on an interrupt that mounts a genui-form");
    const fields = (pause!.data.ui!.props as { fields: Array<{ name: string }> }).fields.map((f) => f.name);
    check(fields.join("|") === "policyNumber|incidentDate|peril|estimate|description", "the form asks for policy, date, peril, estimate, description");
    check(pause!.data.actions === undefined, "no chips: the form's submit answers the pause");
    check(runStatus(t) === "interrupted", "the run ends interrupted");
    console.log(`   (form submitted: ${JSON.stringify(form)})`);
    await app.receive(c, { type: "resume", answers: { [pause!.id]: form } });
    const r = c.drain();
    describe(r);
    return r;
}

/** Answer the senior adjuster's sign-off pause in `frames`. Returns the frames after it. */
async function signOff(app: ReturnType<typeof makeApp>, c: Collector, frames: OutgoingFrame[], tool: string): Promise<OutgoingFrame[]> {
    const pause = interrupts(frames)[0];
    check((pause?.data.payload as { title: string; tool: string }).tool === tool && runStatus(frames) === "interrupted", `${tool} parks the run for the senior adjuster's sign-off`);
    console.log("   (senior adjuster approves)");
    await app.receive(c, { type: "resume", answers: { [pause!.id]: { approved: true } } });
    const r = c.drain();
    describe(r);
    return r;
}

async function probe(): Promise<void> {
    const app = makeApp();
    const c = new Collector("conn-insurance");
    await app.connect(c);
    const hello = c.drain();

    section("0. connect — the skill catalog is announced, level 1 only");
    const catalog = skillsCatalog(hello);
    check(catalog?.skills?.length === 3, "a `skills` frame lists the 3 server skills");
    check(!JSON.stringify(catalog).includes("Payout = estimate"), "instructions never travel in the catalog");
    check(!JSON.stringify(catalog).includes("approve_claim"), "…and neither do the tools each skill owns");

    // ── 1. a covered claim: the skill unlocks its tools mid-run ───────────────
    section("1. intake + approval — a burst pipe on POL-1001; the skill unlocks the decision tools");
    model.load({
        assess: [
            call("lookup_policy", { policyNumber: "POL-1001" }),
            // Premature: check_coverage is held under a skill nobody has loaded yet.
            call("check_coverage", { policyNumber: "POL-1001", peril: "burst pipe" }),
            call("load_skill", { name: "water-damage-assessment" }),
            call("check_coverage", { policyNumber: "POL-1001", peril: "burst pipe" }),
            call("approve_claim", { policyNumber: "POL-1001", payout: 3700 }),
            say("Your claim is approved: we'll pay $3,700 (the $4,200 estimate less your $500 deductible)."),
        ],
    });
    let t = await fileClaim(app, c, {
        policyNumber: "POL-1001",
        incidentDate: "2026-10-02",
        peril: "burst pipe",
        estimate: "4200",
        description: "Kitchen pipe burst overnight.",
    });

    check(traces(t, "lookup_policy")[0]?.data.params?.policyNumber === "POL-1001", "the form's values reach the policy lookup");
    let rounds = offered(0);
    check(rounds.slice(0, 3).every((r) => r === ALWAYS), "(a) before load_skill the model is offered only lookup_policy + load_skill");
    check(
        model.observations.assess?.some((o) => o.includes('Tool check_coverage belongs to skills "rejection-letter", "water-damage-assessment"') && o.includes("load_skill")) === true,
        "(b) the premature check_coverage is refused as an observation naming both skills that own it",
    );
    check(effects.check_coverage === 1 && traces(t, "check_coverage").length === 2, "(b) …and did not run: one coverage run, one traced call (running → completed)");
    const skills = skillUses(t);
    check(skills.length === 1 && skills[0]!.data.name === "water-damage-assessment", "one `skill` frame: water-damage-assessment");
    check(skills[0]!.data.status === "loaded" && skills[0]!.data.source === "server", "loaded from the server catalog");
    check(
        model.observations.assess?.some((o) => o.includes("Tools now available from skill water-damage-assessment: check_coverage, approve_claim.")) === true,
        "the load_skill observation carries the instructions and names the unlocked tools",
    );
    check(rounds[3] === `${ALWAYS}|check_coverage|approve_claim`, "(c) from the next round on, check_coverage and approve_claim are offered");
    check(!rounds.some((r) => r.includes("reject_claim")), "(c) reject_claim (under the other skill) is never offered");
    const lookupSeq = seqOf(traces(t, "lookup_policy")[0]!)!;
    const skillSeq = seqOf(skills[0]!)!;
    const coverageSeq = seqOf(traces(t, "check_coverage")[0]!)!;
    check(lookupSeq < skillSeq && skillSeq < coverageSeq, `mid-run: the skill frame (seq ${skillSeq}) sits between lookup_policy and check_coverage`);
    const sys = model.systems.assess ?? "";
    check(sys.includes("<name>water-damage-assessment</name>") && sys.includes("<name>rejection-letter</name>"), "the prompt lists the home skills");
    check(!sys.includes("auto-collision"), "…and not the auto-tagged one (tag scoping)");
    check(effects.approve_claim === 0, "nothing recorded before the sign-off");

    const before = rounds.length;
    t = await signOff(app, c, t, "approve_claim");
    rounds = offered(before);
    check(rounds.length === 1, "after the resume the model is asked once more (earlier rounds replay from the journal)");
    check(rounds[0] === `${ALWAYS}|check_coverage|approve_claim`, "(d) and that round is still offered the unlocked tools");
    check(effects.approve_claim === 1 && effects.check_coverage === 1, "(c) approve_claim ran exactly once; the replay did not re-run check_coverage");
    let card = uiChunks(t, "claim-decision")[0]?.props as ClaimDecision | undefined;
    check(card?.outcome === "approved" && card.payout === 3700, "the claim-decision component shows the approval and payout");
    check(botText(t)?.includes("$3,700") === true && runStatus(t) === "finished", "the reply explains the payout; the run finishes");

    // ── 2. rejection with a typed reason ──────────────────────────────────────
    section("2. rejection — a flood on POL-2002; another skill, another tool, a typed reason");
    model.load({
        assess: [
            call("lookup_policy", { policyNumber: "POL-2002" }),
            call("load_skill", { name: "rejection-letter" }),
            call("check_coverage", { policyNumber: "POL-2002", peril: "flood" }),
            call("reject_claim", {
                policyNumber: "POL-2002",
                reason: { code: "EXCLUDED_PERIL", clause: "4.2(b)", detail: "Flood and surface water are excluded by clause 4.2(b)." },
            }),
            say("I'm sorry — flood damage is excluded under clause 4.2(b) of your policy, so we can't pay this claim. You can appeal within 30 days."),
        ],
    });
    const start = (model.rounds.assess ?? []).length;
    t = await fileClaim(app, c, {
        policyNumber: "POL-2002",
        incidentDate: "2026-10-04",
        peril: "flood",
        estimate: "18000",
        description: "River overflowed into the basement.",
    });
    check(skillUses(t).map((f) => f.data.name).join("|") === "rejection-letter", "this time the rejection-letter skill is loaded");
    rounds = offered(start);
    check(rounds[2] === `${ALWAYS}|check_coverage|reject_claim`, "it unlocks check_coverage and reject_claim — not approve_claim");
    t = await signOff(app, c, t, "reject_claim");
    check(effects.reject_claim === 1, "reject_claim ran exactly once");
    card = uiChunks(t, "claim-decision")[0]?.props as ClaimDecision | undefined;
    check(card?.outcome === "rejected", "the claim-decision component shows a rejection");
    const reason = card?.outcome === "rejected" ? card.reason : undefined;
    check(reason?.code === "EXCLUDED_PERIL" && (REJECTION_CODES as readonly string[]).includes(reason.code), "with a typed reason code: EXCLUDED_PERIL");
    check(reason?.clause === "4.2(b)", "citing the policy clause 4.2(b)");
    check(botText(t)?.includes("clause 4.2(b)") === true, "and the reply tells the customer why, and how to appeal");
    check(effects.approve_claim === 1, "nothing new was approved");

    check(effects.lookup_policy === 2, "one policy lookup per claim");
    console.log(`\nclaims ledger: ${JSON.stringify(CLAIMS)}`);
    console.log("\n✅ insurance probe passed — a genui-form intake pause, tools held under a skill until it loads, a sign-off pause that keeps them, and a typed rejection reason all verified");
}

main(probe);
