// Insurance claims desk — a domain probe. An ilmek graph served over mekik,
// driven offline by a scripted model, asserting its own frame stream:
//
//     START → intake (genui-form pause) → assess (policy tools + skills) → END
//
//   1. intake    — the claim form is a pause: an interrupt that mounts a
//                  genui-form; the submitted values are the resume answer
//   2. approve   — the adjuster model looks up the policy, LOADS A SKILL
//                  mid-run (a `skill` frame between two tool traces), checks
//                  coverage and records an approval with a payout
//   3. reject    — a flood claim on a policy that excludes floods: a different
//                  skill, an off-list reason code refused by the schema, then
//                  a typed rejection reason (code + clause) on the wire
//
// The server's skill catalog is announced on connect (`skills` frame, level 1
// only) and the node only offers the skills tagged for home claims.
//
//   node examples/insurance/insurance.ts     # offline self-test, exit 0/1

import { channel, END, graph, START } from "@ilmek/core";
import type { Context } from "@ilmek/core";
import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { mekik } from "@mekik/core";
import type { OutgoingFrame, SkillEntry } from "@mekik/core";
import { withMekikTools, withSkills } from "@mekik/langchain";

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
    seqOf,
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

const decisionSchema = z.object({
    policyNumber: z.string(),
    outcome: z.enum(["approved", "rejected"]),
    payout: z.number().optional(),
    reason: z
        .object({ code: z.enum(REJECTION_CODES), clause: z.string(), detail: z.string() })
        .optional(),
});

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
const effects = { lookup_policy: 0, record_decision: 0 };

/** The server's skill catalog — level 1 travels to the client, instructions stay here until loaded. */
const SKILLS: SkillEntry[] = [
    {
        name: "water-damage-assessment",
        description: "How to assess an escape-of-water claim (burst pipes, leaks): evidence, deductible, payout.",
        instructions:
            "1. Confirm the peril is a sudden escape of water, not gradual seepage.\n" +
            "2. Payout = estimate minus the policy deductible, capped at the estimate.\n" +
            "3. Record the decision with record_decision before replying.",
        tags: ["home"],
    },
    {
        name: "rejection-letter",
        description: "How to decline a claim: cite the exclusion clause and a typed reason code.",
        instructions:
            "Decline only with a reason code from EXCLUDED_PERIL, POLICY_LAPSED, BELOW_DEDUCTIBLE. " +
            "Quote the policy clause. Be plain and kind; tell the customer how to appeal.",
        tags: ["home"],
    },
    {
        name: "auto-collision",
        description: "How to assess a motor collision claim.",
        instructions: "Ask for the other party's details and the police report number.",
        tags: ["auto"],
    },
];

// ── tools ─────────────────────────────────────────────────────────────────────

function adjusterTools(ctx: Context<any>): StructuredToolInterface[] {
    const lookup = tool(
        ({ policyNumber }) => {
            effects.lookup_policy++;
            const p = POLICIES[policyNumber];
            if (!p) throw new Error(`No policy ${policyNumber}.`);
            return p;
        },
        { name: "lookup_policy", description: "Fetch a policy by number.", schema: z.object({ policyNumber: z.string() }) },
    );
    const coverage = tool(
        ({ policyNumber, peril }) => {
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
    const record = tool(
        (d: z.infer<typeof decisionSchema>): ClaimDecision => {
            effects.record_decision++;
            const claimId = `CLM-${7000 + CLAIMS.length}`;
            const decision: ClaimDecision =
                d.outcome === "approved"
                    ? { claimId, outcome: "approved", payout: d.payout ?? 0 }
                    : { claimId, outcome: "rejected", reason: d.reason! };
            CLAIMS.push(decision);
            return decision;
        },
        {
            name: "record_decision",
            description: "Record the claim decision. A rejection must carry a typed reason.",
            schema: decisionSchema,
        },
    );
    return [...withMekikTools(ctx, [lookup, coverage, record]), ...withSkills(ctx, { tags: ["home"] })];
}

// ── the graph ─────────────────────────────────────────────────────────────────

const model = new ScriptedModel();

const ADJUSTER =
    "You are a home-insurance claims adjuster. Look up the policy, load the skill that matches the claim, " +
    "check coverage, record the decision, then explain it to the customer in two sentences.";

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
        // Level 1 in the prompt: names and descriptions of the home skills only.
        const system = `${ADJUSTER}\n\n${mekik.skillsPrompt(ctx, { tags: ["home"] })}`;
        const input = `Claim on ${c.policyNumber}: ${c.peril} on ${c.incidentDate}, estimate $${c.estimate}. ${c.description}`;
        const out = await runTools(ctx, model, "assess", adjusterTools(ctx), system, input);

        const decision = out.results.record_decision as ClaimDecision | undefined;
        if (decision) claimDecision(ctx, decision);
        return { reply: out.text };
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

function skillFrames(frames: OutgoingFrame[]) {
    return frames.filter((f): f is Extract<OutgoingFrame, { type: "skill" }> => f.type === "skill");
}

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

async function probe(): Promise<void> {
    const app = makeApp();
    const c = new Collector("conn-insurance");
    await app.connect(c);
    const hello = c.drain();

    section("0. connect — the skill catalog is announced, level 1 only");
    const catalog = hello.find((f) => f.type === "skills");
    check(catalog?.type === "skills" && catalog.skills?.length === 3, "a `skills` frame lists the 3 server skills");
    check(!JSON.stringify(catalog).includes("Payout = estimate"), "instructions never travel in the catalog");

    // ── 1–2. a covered claim: the skill is loaded mid-run ─────────────────────
    section("1. intake + approval — a burst pipe on POL-1001, a skill loaded mid-run");
    model.load({
        assess: [
            call("lookup_policy", { policyNumber: "POL-1001" }),
            call("load_skill", { name: "water-damage-assessment" }),
            call("check_coverage", { policyNumber: "POL-1001", peril: "burst pipe" }),
            call("record_decision", { policyNumber: "POL-1001", outcome: "approved", payout: 3700 }),
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
    const skills = skillFrames(t);
    check(skills.length === 1 && skills[0]!.data.name === "water-damage-assessment", "one `skill` frame: water-damage-assessment");
    check(skills[0]!.data.status === "loaded" && skills[0]!.data.source === "server", "loaded from the server catalog");
    const lookupSeq = seqOf(traces(t, "lookup_policy")[0]!)!;
    const decideSeq = seqOf(traces(t, "record_decision")[0]!)!;
    const skillSeq = seqOf(skills[0]!)!;
    check(lookupSeq < skillSeq && skillSeq < decideSeq, `mid-run: after lookup_policy (seq ${lookupSeq}), before record_decision (seq ${decideSeq})`);
    check(
        model.observations.assess?.some((o) => o.includes("Payout = estimate minus the policy deductible")) === true,
        "the model got the instructions (level 2) as the load_skill observation",
    );
    const sys = model.systems.assess ?? "";
    check(sys.includes("<name>water-damage-assessment</name>") && sys.includes("<name>rejection-letter</name>"), "the prompt lists the home skills");
    check(!sys.includes("auto-collision"), "…and not the auto-tagged one (tag scoping)");
    let card = uiChunks(t, "claim-decision")[0]?.props as ClaimDecision | undefined;
    check(card?.outcome === "approved" && card.payout === 3700, "the claim-decision component shows the approval and payout");
    check(botText(t)?.includes("$3,700") === true && runStatus(t) === "finished", "the reply explains the payout; the run finishes");

    // ── 3. rejection with a typed reason ──────────────────────────────────────
    section("2. rejection — a flood on POL-2002, with a typed reason");
    model.load({
        assess: [
            call("lookup_policy", { policyNumber: "POL-2002" }),
            call("load_skill", { name: "rejection-letter" }),
            call("check_coverage", { policyNumber: "POL-2002", peril: "flood" }),
            // An off-list code: the schema refuses it before the tool body runs.
            call("record_decision", {
                policyNumber: "POL-2002",
                outcome: "rejected",
                reason: { code: "NOT_COVERED", clause: "4.2(b)", detail: "Flood is excluded." },
            }),
            call("record_decision", {
                policyNumber: "POL-2002",
                outcome: "rejected",
                reason: { code: "EXCLUDED_PERIL", clause: "4.2(b)", detail: "Flood and surface water are excluded by clause 4.2(b)." },
            }),
            say("I'm sorry — flood damage is excluded under clause 4.2(b) of your policy, so we can't pay this claim. You can appeal within 30 days."),
        ],
    });
    const decisionsBefore = effects.record_decision;
    t = await fileClaim(app, c, {
        policyNumber: "POL-2002",
        incidentDate: "2026-10-04",
        peril: "flood",
        estimate: "18000",
        description: "River overflowed into the basement.",
    });

    const loaded = skillFrames(t).map((f) => f.data.name);
    check(loaded.join("|") === "rejection-letter", "this time the rejection-letter skill is loaded");
    check(
        model.observations.assess?.some((o) => o.startsWith("Error:") && o.includes("schema")) === true,
        "the off-list reason code was refused by the schema (an observation, not a crash)",
    );
    check(effects.record_decision === decisionsBefore + 1, "so only the valid decision was recorded");
    const recorded = traces(t, "record_decision").filter((f) => f.data.status === "completed");
    check(recorded.length === 1, "and only that one is traced");
    card = uiChunks(t, "claim-decision")[0]?.props as ClaimDecision | undefined;
    check(card?.outcome === "rejected", "the claim-decision component shows a rejection");
    const reason = card?.outcome === "rejected" ? card.reason : undefined;
    check(reason?.code === "EXCLUDED_PERIL" && (REJECTION_CODES as readonly string[]).includes(reason.code), "with a typed reason code: EXCLUDED_PERIL");
    check(reason?.clause === "4.2(b)", "citing the policy clause 4.2(b)");
    check(botText(t)?.includes("clause 4.2(b)") === true, "and the reply tells the customer why, and how to appeal");
    check(!uiChunks(t, "claim-decision").some((u) => (u.props as ClaimDecision).outcome === "approved"), "nothing on the wire says approved");

    check(effects.lookup_policy === 2, "one policy lookup per claim");
    console.log(`\nclaims ledger: ${JSON.stringify(CLAIMS)}`);
    console.log("\n✅ insurance probe passed — a genui-form intake pause, policy tools, a skill loaded mid-run, and a typed rejection reason all verified");
}

main(probe);
