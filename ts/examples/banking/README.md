# Banking desk

A routed ilmek graph served over mekik, driven offline by a scripted model. The
probe plays the client and asserts its own frame stream, so it is also an
integration test: no network, no API key, exit code 0 or 1.

```text
START → route ─┬→ accounts ───────────────────────────────────────────→ END
               ├→ history ────────────────────────────────────────────→ END
               └→ payments ─┬→ transfer_approve ─┬→ transfer_execute → END
                (runAgent)  │   (1 or 2 pauses)  └→ END (declined)
                            └→ END (dispute opened, or held for review)
```

The bank has a §12 skill catalog in which **each skill owns its tools**. A skill
is its instructions plus the tools those instructions govern
(`SkillEntry.tools`):

```ts
const SKILLS: SkillEntry<StructuredToolInterface>[] = [
    {
        name: "wire-transfer-rules",
        description: "Rules for sending money: fraud screening, limits, second approvers. Load before any transfer.",
        instructions: "1. Screen every transfer with fraud_screen. …",
        tools: [checkTransferLimit, transferFunds],
    },
    {
        name: "dispute-handling",
        description: "How to open a card or account dispute for a transaction the customer does not recognise.",
        instructions: "Confirm the date, description and amount from the history, then open_dispute. …",
        tools: [openDispute],
    },
];
```

The `payments` node is a `runAgent` loop that passes only its always-on tools
and `skills: true`; the skills bring their own. Every tool is built once, at
module level: `transfer_funds` stages per conversation and `list_transactions`
mounts its table by reading the calling run's `ctx` with `toolContext(config)`.
The tools never leave the server: the `skills` frame carries names and
descriptions only.

Until a skill is loaded, the model is offered only `lookup_payee`, the hidden
`fraud_screen`, `flag_for_review` and `load_skill`. Balance and history tools
stay always-on in their own nodes. `transfer_funds` only stages the transfer;
the money moves in `transfer_execute` after the approvals.

## What it shows

| # | Scenario | What the probe asserts |
|---|---|---|
| 0 | Connect | A `skills` frame announces `dispute-handling` and `wire-transfer-rules`, and names none of their tools. |
| 1 | Balance query | `get_accounts` and `get_balance` are traced, the run finishes without a pause, and the `accounts` node bound only the read tools. |
| 2 | Transfer under the limit | `transfer_funds` is not offered before `wire-transfer-rules` loads. A premature call is refused with an observation and stages nothing. From the next round `check_transfer_limit` and `transfer_funds` are offered, but `open_dispute` is not. The `skill` frame's `seq` comes before the transfer trace. One `interrupt` with a `genui-card` and Send / Cancel chips; after the resume only `execute_transfer` runs, once. |
| 3 | Transfer over the $5,000 limit | The skill-held `check_transfer_limit` flags a second approver. The customer approves, then the run parks **again** for the second approver. A new message while parked is refused with `error{interrupted}`. On the co-sign the customer is not asked again, the agent loop does not re-run, and the transfer executes once. |
| 4 | Transaction history | `list_transactions` mounts one `genui-table` whose rows include both transfers. |
| 5 | Fraud flag | `fraud_screen` (policy `show: false`) throws. No frame for it reaches the wire (the turn's frames are asserted exactly), there is no error trace or error frame, the model reads `Error from fraud_screen: fraud screening service timed out` and, following the skill, calls `flag_for_review` instead of `transfer_funds`. Nothing is staged and no money moves. |
| 6 | Dispute | `open_dispute` is offered only after `dispute-handling` loads, and the transfer tools stay locked. The dispute is opened once. |

The mekik pieces in play:

- `runAgent` with `skills` and a `show: false` policy
- the `skills` app option, with `SkillEntry<StructuredToolInterface>` entries that own their tools
- `toolContext(config)` in module-level tools
- `withMekikTools` in the read-only nodes
- `mekik.approve` with `key` for two pauses in one node
- `mekik.genui.card.ref` and `mekik.genui.table`
- `mekik.tool` for the step that moves money
- a router node with `command({ goto })`

## Run it

From `ts/` (after `pnpm install && pnpm build`):

```bash
node examples/banking/banking.ts
```

Each step prints the frames it saw and a `✓` line per assertion, ending with
`✅ banking probe passed …`.
