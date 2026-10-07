# Healthcare triage

An ilmek graph served over mekik, driven offline by a scripted triage model.
The probe plays the patient portal — including the page's own calendar — and
asserts its own frame stream, so it is also an integration test: no network,
no API key, exit code 0 or 1.

```text
START → intake → escalate (chips) ─┬→ book (client tool: the page's calendar) → END
                                   ├→ END (emergency: call 112)
                                   └→ END (nurse callback)
```

The patient never types their medical record number (MRN). It arrives as a
verified claim from the portal session (`StaticTokenAuthenticator`), so it is
on the server and in the model's context, and the probe proves it never reaches
the wire.

## What it shows

| # | Scenario | What the probe asserts |
|---|---|---|
| 1 | Intake, redacted | The model calls `lookup_patient`, `record_symptoms` and `score_triage`. The tools are wrapped with `withMekikTools` and a `redact` policy (the same technique as `sql-agent.ts --probe`): the traces show `«redacted»` for the MRN, date of birth and name, non-identifying fields still show, and the model's observations contain the real values. |
| 2 | Escalation | An urgent score parks the run on a chips-only interrupt (`mekik.choose`): three chips, no form, no client tool, the level and red flags in the payload. Typing instead of choosing is refused with `error{interrupted}`. |
| 3 | Booking | The slot comes from the page's calendar, a §11 client tool: the run parks on an interrupt whose `data.tool` is `open_calendar` with `{ specialty, within }`. The booking node's `mekik.clientTools(ctx, { tags: ["scheduling"] })` excludes the `vitals`-tagged `read_wearable`. The page answers with `{ ok: true, result }`; the completed trace carries the slot, `book_appointment` runs exactly once against the real MRN and is traced with the MRN masked. No identifier appears anywhere on the wire. |
| 4 | Replay | A second tab connects to the same conversation with `watermark: 0` and replays the whole transcript, which still carries no identifier. |
| 5 | Emergency | Another patient picks "Call 112 now": an error-variant `genui-alert`, the calendar is never opened, nothing is booked. |

The mekik pieces in play: the `authenticator` option and `mekik.authClaims`,
`withMekikTools` with `redact`, `mekik.choose` / `mekik.action`, the
`clientTools` allowlist with `mekik.clientTools` and `mekik.callClientTool`,
`mekik.genui.alert`, and reconnect replay.

## Run it

From `ts/` (after `pnpm install && pnpm build`):

```bash
node examples/healthcare-triage/triage.ts
```

Each step prints the frames it saw and a `✓` line per assertion, ending with
`✅ healthcare-triage probe passed …`.
