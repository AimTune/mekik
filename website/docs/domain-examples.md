---
sidebar_position: 10
title: Domain scenarios
description: Five offline probes that serve a realistic ilmek graph over mekik — banking, insurance, healthcare triage, travel booking and a support desk — and assert their own frame streams.
---

# Domain scenarios

The [examples](./examples.md) each demonstrate one part of mekik. The domain
scenarios do the opposite: each one is a small, realistic desk that uses
several features together, the way an application would. Each runs
**offline**. A scripted model stands in for the LLM (the same seam as the
`--probe` modes), the probe plays the client, and every step asserts the frame
stream it got back. So each scenario is also an integration test, and CI runs
all five.

They live under [`ts/examples/`](https://github.com/AimTune/mekik/tree/main/ts/examples), one directory each, with a README:

```bash
cd ts
node examples/banking/banking.ts
node examples/insurance/insurance.ts
node examples/healthcare-triage/triage.ts
node examples/travel-booking/travel.ts
node examples/support-desk/support.ts

pnpm run examples:domain   # all five; also part of `pnpm check`
```

The output follows the existing probes: the frames of each turn (`→` a tool
call, `←` its result, `⏸` a pause, `▦` a component, `✦` a skill), a `✓` line per
assertion, and a final `✅`. A failed assertion exits `1` with the message.

## At a glance

| Scenario | Graph | What it pins on the wire |
|---|---|---|
| [`banking`](https://github.com/AimTune/mekik/tree/main/ts/examples/banking) | router → accounts / history / payments (agent) → approve → execute | money tools held under skills, two pauses in one node for a second approver, exactly-once execution, a `genui-table` history, a hidden tool that fails without a trace |
| [`insurance`](https://github.com/AimTune/mekik/tree/main/ts/examples/insurance) | intake (form pause) → assess | a `genui-form` interrupt, decision tools held under a skill until `load_skill`, a sign-off pause that keeps them, a typed rejection reason |
| [`healthcare-triage`](https://github.com/AimTune/mekik/tree/main/ts/examples/healthcare-triage) | intake (agent) → escalate (chips) → book (client tool, agent) | redacted identifiers on every frame, skill-held scoring and booking, an allowlisted **client-declared** skill, a chips-only pause, the page's calendar as a client tool |
| [`travel-booking`](https://github.com/AimTune/mekik/tree/main/ts/examples/travel-booking) | router → search → compare → book (agent); cancel (agent) | a reconnect that replays exactly the missed frames with the unlocked tools intact, `welcome.pending`, a skill-held cancellation that runs once |
| [`support-desk`](https://github.com/AimTune/mekik/tree/main/ts/examples/support-desk) | router → billing / tech → handoff / chat | tag-scoped skills per route, per-node tool scoping, an MCP knowledge base, an A2A hand-off whose pause is relayed to the desk's human |

## Skills in every scenario

Every scenario has its own §12 skill catalog (the `skills` app option, announced
in the `skills` frame on connect). Each catalog
[holds a tool under the skill](./authoring/skills.md#tools-under-a-skill) that
governs it, so the model cannot call that tool before it has read the rules:

| Scenario | Skill (tag) | Holds |
|---|---|---|
| banking | `wire-transfer-rules` | `check_transfer_limit`, `transfer_funds` |
| banking | `dispute-handling` | `open_dispute` |
| insurance | `water-damage-assessment` (home) | `check_coverage`, `approve_claim` |
| insurance | `rejection-letter` (home) | `check_coverage`, `reject_claim` |
| healthcare-triage | `triage-protocol` (triage) | `score_triage` |
| healthcare-triage | `appointment-booking` (booking) | `book_appointment` |
| travel-booking | `fare-rules` (booking) | `book_flight` |
| travel-booking | `cancellation-policy` (cancellation) | `cancel_booking` |
| support-desk | `refund-policy` (billing) | `issue_credit` |
| support-desk | `incident-runbook` (tech) | `escalate_to_specialist` |

The probes record the tool list offered in every model round. Every
scenario asserts that a held tool is absent before its skill loads and
offered from the round after. Several also check that a premature call is
refused with an observation and does not run. Beyond that, each scenario adds
its own check:

- tag scoping across routes (support desk);
- the unlocked set surviving a pause or a reconnect (insurance, travel);
- redaction holding on the skill frames (healthcare).

Most agents use `runAgent({ skills, skillTools })`. The support desk's tech
node shows the hand-wired form, `withSkills(ctx, filter, { toolNames })`,
because its MCP tools come pre-wrapped by `withMcpTools`.

## Banking

The payments node is a `runAgent` loop whose money tools are held under
skills: `wire-transfer-rules` holds `check_transfer_limit` and
`transfer_funds`, and `dispute-handling` holds `open_dispute`. Balance and
history tools stay always-on in their own nodes. The probe asserts that
`transfer_funds` is not offered before its skill loads, and that a premature
call is refused without staging anything. It also checks that the `skill`
frame's `seq` comes before the transfer trace, and that loading
`dispute-handling` unlocks only `open_dispute`.

`transfer_funds` only stages the transfer; the approvals come next. Over the
$5,000 limit, the approval node calls `mekik.approve` twice with different
`key`s: the customer first, then a second approver. On the resume that answers
the second pause, the node re-runs from the top and the customer's answer
comes back from the journal, so the customer is not asked again. The probe
asserts that, plus one `execute_transfer` per transfer and a ledger debited
once.

The history is a `genui-table` mounted from inside the tool. The fraud check
runs with a `show: false` policy, so no frame for it reaches the wire. When
the service is down, the model reads `Error: fraud screening service timed out`
as an observation. Following the skill, it calls `flag_for_review` instead of
`transfer_funds`, and no money moves.

## Insurance

The claim form is the pause. `mekik.approve` with
`ui: mekik.genui.form.ref({ fields })` and no actions mounts the form, and the
submitted values come back as the resume answer. The app's `skills` option
holds three skills: the `skills` frame announces them on connect (no
instructions), and the adjuster node offers only the `home`-tagged ones.

The adjuster is a `runAgent` loop. Only `lookup_policy` is always offered.
`skillTools` puts `check_coverage` and `approve_claim` under
`water-damage-assessment`, and `check_coverage` and `reject_claim` under
`rejection-letter`. The probe asserts four things:

- **Before `load_skill`**, only `lookup_policy` and `load_skill` are offered.
- **A premature `check_coverage` call** is refused with an observation naming
  the skill to load. The tool doesn't run and nothing is traced.
- **From the round after the `skill` frame**, the skill's tools are offered,
  and the other skill's decision tool never is.
- **Across a pause.** Each decision needs a senior adjuster's sign-off (an
  `approve` policy). On the resume, the earlier rounds replay from the
  journal, the next round is still offered the unlocked tools, and the
  decision runs exactly once.

A rejection carries a typed reason. `reject_claim`'s zod schema pins `code` to
`EXCLUDED_PERIL | POLICY_LAPSED | BELOW_DEDUCTIBLE`, and
`{ code: "EXCLUDED_PERIL", clause: "4.2(b)" }` lands on the typed
`claim-decision` component.

## Healthcare triage

The medical record number arrives as a verified claim
(`StaticTokenAuthenticator`, read with `mekik.authClaims`), never in the chat.
The intake tools use the same redaction technique as
`sql-agent.ts --probe`: a `redact` policy, here on `runAgent`. The model reads
the real MRN, date of birth and name, while the traces show `«redacted»`. The
probe checks that no identifier appears on any frame: skill frames (which
carry only `id`, `name`, `status` and `source`) and a second tab's full
transcript replay included.

Both agents use skills, each scoped to its own tag. `triage-protocol` holds
`score_triage`, the red-flag rules, and `appointment-booking` holds the
server-side `book_appointment`. The calendar itself stays a
[client tool](./authoring/client-tools.md).

This is also the scenario with
[client-declared skills](./authoring/skills.md#client-declared-skills-off-by-default). The portal declares two in
`hello.skills`, and the server opts in with a `clientSkills` allowlist that
accepts `plain-language` and drops `override-triage`, a skill that would tell
the model to ignore red flags. The probe asserts both outcomes:

- `plain-language` is in the prompt and its `skill` frame says
  `source: "client"`;
- `override-triage` never reaches the model, and loading it is an
  unknown-skill observation with no frame.

Client skills are per connection: another patient's portal, which declared
none, does not get `plain-language`.

An urgent score parks the run with `mekik.choose` (three chips, no form). The
booking slot comes from the page's own calendar: `mekik.callClientTool(ctx,
"open_calendar", …)` parks on an interrupt carrying `data.tool`, and the page
answers `{ ok: true, result }`. The booking agent then loads its skill, and
`book_appointment` runs once against the real MRN. An emergency answer mounts
a `genui-alert` and never opens the calendar.

## Travel booking

Search, compare and book are separate nodes. The comparison is a
`genui-table` with a literal chunk id, so the replay after the pick
re-renders the same element. The `book` and `cancel` nodes are `runAgent`
loops: `fare-rules` holds `book_flight` and `cancellation-policy` holds
`cancel_booking`, each gated by an approval policy.

The reconnect test: the client records a watermark, then its socket dies while
the `fare-rules` skill frame and the booking approval stream. A new connection
with `{ conversationId, watermark }` gets `welcome.pending` re-announcing the
same approval id, and a replay that starts at `watermark + 1`, has no gaps, and
is exactly the frames the dead socket missed, skill frame included. The
approval is answered from the new socket. The next model round is still
offered `book_flight` (the unlocked set is derived from the journal), and the
booking runs once.

The skill-held cancellation runs before a second pause ("rebook?") in the
same node, so the resume that answers it replays the node, agent loop and all.
The model is not asked again, and the journal keeps `cancel_booking` at one
call. Two tabs confirming at once get one run and one refusal (`busy`), and
asking to cancel again finds the cancelled booking in graph state.

## Support desk

A router sends each turn to a node with its own tools, and the probe asserts
what each node bound. The skills are **tag-scoped per route**:
`refund-policy` (billing) holds `issue_credit`, and `incident-runbook` (tech)
holds `escalate_to_specialist`. The probe asserts tag scoping both ways:

- each node's prompt lists only its own skill;
- loading the other route's skill is an unknown-skill observation;
- the only `skill` frame on each turn is the node's own.

The other two agents in this scenario are mekik apps too:

- the **knowledge base** is served with `MekikMcpServer` and consumed by the
  tech node through `withMcpTools`, as `kb__search`, which surfaces as an
  ordinary `tool_call` trace ([MCP](./serving/mcp.md));
- the **network specialist** is served with `MekikA2aServer`. The desk hands
  the case over with `message/send` inside `mekik.tool`, which journals it
  ([A2A](./serving/a2a.md)).

When the specialist's task comes back `input-required`, the desk parks on its
own interrupt carrying the specialist's question and chips. It then forwards
the human's answer as a data part on the same task. The probe checks one
hand-off message and one answer, the same task and context ids, a single
reboot on the specialist's side, and a resume that replays only the hand-off
node, so the knowledge base is not called again.

## Writing your own

The scenarios share
[`ts/examples/lib/probe-kit.ts`](https://github.com/AimTune/mekik/blob/main/ts/examples/lib/probe-kit.ts):

- `ScriptedModel` holds per-node queues of scripted decisions (`say`, `call`)
  and records what each node's model was shown: its toolbox, its system
  prompt, every observation, and the tool list offered in each round.
  `asChatModel(node)` wraps the same script as a chat model for `runAgent`.
- `runTools` is a hand-wired model↔tool loop, with decisions journaled per
  node. Its `skillTools` option applies `runAgent`'s skill gating to tools
  that come pre-wrapped.
- `Collector`, `check` and `describe` cover frame capture and the output style.

To write a new scenario, copy a directory, swap the domain, and assert the
frames your users depend on.
