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
| [`banking`](https://github.com/AimTune/mekik/tree/main/ts/examples/banking) | router → accounts / history / transfer (prepare → approve → execute) | two pauses in one node for a second approver, exactly-once execution, a `genui-table` history, a hidden tool that fails without a trace |
| [`insurance`](https://github.com/AimTune/mekik/tree/main/ts/examples/insurance) | intake (form pause) → assess | a `genui-form` interrupt, decision tools held under a skill until `load_skill`, a sign-off pause that keeps them, a typed rejection reason |
| [`healthcare-triage`](https://github.com/AimTune/mekik/tree/main/ts/examples/healthcare-triage) | intake → escalate (chips) → book (client tool) | redacted identifiers, a chips-only pause, the page's calendar as a client tool, a clean transcript replay |
| [`travel-booking`](https://github.com/AimTune/mekik/tree/main/ts/examples/travel-booking) | router → search → compare → book; cancel | a reconnect that replays exactly the missed frames, `welcome.pending`, a cancellation that runs once |
| [`support-desk`](https://github.com/AimTune/mekik/tree/main/ts/examples/support-desk) | router → billing / tech → handoff / chat | per-node tool scoping, an MCP knowledge base, an A2A hand-off whose pause is relayed to the desk's human |

## Banking

A transfer is quoted in one node and approved in the next. Over the $5,000
limit, the approval node calls `mekik.approve` twice with different `key`s:
the customer first, then a second approver. On the resume that answers the
second pause, the node re-runs from the top and the customer's answer comes
back from the journal, so the customer is not asked again. The probe asserts
that, plus one `execute_transfer` per transfer and a ledger debited once.

The history is a `genui-table` mounted from inside the tool. The fraud
check is wrapped with `withMekikTools(ctx, tools, { fraud_screen: { show: false } })`
and throws: no frame for it reaches the wire, no error trace, no `error`
frame. The model reads `Error: fraud screening service timed out` as an
observation and calls `flag_for_review` instead, and no money moves.

## Insurance

The claim form is the pause. `mekik.approve` with
`ui: mekik.genui.form.ref({ fields })` and no actions mounts the form, and the
submitted values come back as the resume answer. The app's `skills` option
holds three skills: the `skills` frame announces them on connect (no
instructions), and the adjuster node offers only the `home`-tagged ones.

The adjuster is a `runAgent` loop, and its decision tools are
[held under a skill](./authoring/skills.md#tools-under-a-skill). Only
`lookup_policy` is always offered. `skillTools` puts `check_coverage` and
`approve_claim` under `water-damage-assessment`, and `check_coverage` and
`reject_claim` under `rejection-letter`. The probe records the tool list
offered in each model round and asserts four things:

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
`sql-agent.ts --probe`, a `redact` policy on `withMekikTools`. The model
reads the real MRN, date of birth and name, while the traces show
`«redacted»`. The probe checks that no identifier appears anywhere on the
wire, including in a second tab's full transcript replay.

An urgent score parks the run with `mekik.choose` (three chips, no form). The
booking slot comes from the page's own calendar: `mekik.callClientTool(ctx,
"open_calendar", …)` parks on an interrupt carrying `data.tool`, the page
answers `{ ok: true, result }`, and `book_appointment` runs once against the
real MRN. An emergency answer mounts a `genui-alert` and never opens the
calendar.

## Travel booking

Search, compare and book are separate nodes. The comparison is a
`genui-table` with a literal chunk id, so the replay after the pick
re-renders the same element. The pick and the booking approval are separate
pauses.

The reconnect test: the client records a watermark, then its socket dies while
the booking approval streams. A new connection with
`{ conversationId, watermark }` gets `welcome.pending` re-announcing the same
approval id, and a replay that starts at `watermark + 1`, has no gaps, and is
exactly the frames the dead socket missed. The approval is answered from the
new socket, and the booking runs once.

Cancellation runs before a second pause ("rebook?") in the same node, so the
resume that answers it replays the node. The journal keeps `cancel_booking` at
one call. Two tabs confirming at once get one run and one refusal (`busy`),
and asking to cancel again finds the cancelled booking in graph state.

## Support desk

A router sends each turn to a node with its own tools, and the probe asserts
what each node bound. The other two agents in this scenario are mekik apps too:

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
  and records what each node's model was shown: its toolbox, its system prompt
  and every observation;
- `runTools` is the model↔tool loop, with decisions journaled per node.
  For `runAgent`, `asChatModel(node)` wraps the same script as a chat model
  and records the tool list offered in each round;
- `Collector`, `check` and `describe` cover frame capture and the output style.

To write a new scenario, copy a directory, swap the domain, and assert the
frames your users depend on.
