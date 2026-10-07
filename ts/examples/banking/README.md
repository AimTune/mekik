# Banking desk

A routed ilmek graph served over mekik, driven offline by a scripted model. The
probe plays the client and asserts its own frame stream, so it is also an
integration test: no network, no API key, exit code 0 or 1.

```text
START → route ─┬→ accounts ───────────────────────────────────────────→ END
               ├→ history ────────────────────────────────────────────→ END
               └→ transfer_prepare ─┬→ transfer_approve ─┬→ transfer_execute → END
                                    │   (1 or 2 pauses)  └→ END (declined)
                                    └→ END (held for fraud review)
```

## What it shows

| # | Scenario | What the probe asserts |
|---|---|---|
| 1 | Balance query | `get_accounts` and `get_balance` are traced as `tool_call` frames, the result carries the ledger value, the run finishes without a pause, and the `accounts` node bound only the read tools. |
| 2 | Transfer under the limit | One `interrupt` with a `genui-card` and Send / Cancel chips; nothing is debited before the answer; after the resume only `execute_transfer` runs, exactly once. |
| 3 | Transfer over the $5,000 limit | The customer approves, then the run parks **again** on a second interrupt for a second approver (`role: "second-approver"`, the limit in the payload). A new message while parked is refused with `error{interrupted}`. On the co-sign the customer is not asked again (their answer replays from the journal), the quote does not re-run, and the transfer executes once. |
| 4 | Transaction history | `list_transactions` mounts one `genui-table` (Date / Description / Amount) whose rows include both transfers; the rows travel in the table, not the tool trace. |
| 5 | Fraud flag | `fraud_screen` is wrapped with `show: false` and throws. No frame for it reaches the wire, there is no error trace or error frame, the model reads `Error: fraud screening service timed out` as an observation and calls `flag_for_review` instead; no approval is asked for and no money moves. |

The mekik pieces in play: `withMekikTools` (traces, `show: false`, exactly-once
via `ctx.step`), `mekik.approve` with `key` for two pauses in one node,
`mekik.genui.card.ref` / `mekik.genui.table`, `mekik.tool` for the money-moving
step, and a router node with `command({ goto })`.

## Run it

From `ts/` (after `pnpm install && pnpm build`):

```bash
node examples/banking/banking.ts
```

Each step prints the frames it saw and a `✓` line per assertion, ending with
`✅ banking probe passed …`.
