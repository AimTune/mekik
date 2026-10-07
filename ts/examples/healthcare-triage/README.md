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

## Skills

The clinic has a §12 skill catalog in which each skill **owns** the tool it
governs (`SkillEntry.tools`). Both agents (`intake` and `book`) are `runAgent`
loops over that catalog, so each tool is offered only once its skill is loaded:

| Skill | Tag | Owns |
|---|---|---|
| `triage-protocol` | `triage` | `score_triage`, the red-flag rules that decide escalation |
| `appointment-booking` | `booking` | `book_appointment`, the server-side booking (the calendar itself stays a §11 client tool) |

Each node asks for its own tag, so the intake agent never sees the booking
skill and vice versa. The portal also declares two skills of its own in
`hello.skills` (§12.4). The server's `clientSkills` allowlist accepts
`plain-language` and drops `override-triage`, a prompt-injection-shaped
skill that would tell the model to ignore red flags.

## What it shows

| # | Scenario | What the probe asserts |
|---|---|---|
| 0 | Connect | The `skills` frame lists the two server skills and none of their tools. Client declarations are never echoed. |
| 1 | Intake | **Redaction:** `lookup_patient` and `record_symptoms` run under a `redact` policy (the technique from `sql-agent.ts --probe`). The traces show `«redacted»` for the MRN, date of birth and name, while the model's observations contain the real values. **Skills:** `score_triage` is not offered before `triage-protocol` loads, and a premature call is refused with an observation and does not run. The prompt lists `triage-protocol` and the client's `plain-language`, but not `appointment-booking` (other tag) and not `override-triage` (dropped). Two `skill` frames follow: `triage-protocol` (`source: "server"`) and `plain-language` (`source: "client"`). Loading `override-triage` returns an unknown-skill observation and emits no frame. The skill frames carry only `id`, `name`, `status` and `source`, with no identifier. |
| 2 | Escalation | An urgent score parks the run on a chips-only interrupt (`mekik.choose`): three chips, no form, no client tool. Typing instead of choosing is refused with `error{interrupted}`. |
| 3 | Booking | The slot comes from the page's calendar, a §11 client tool (`open_calendar`, scoped by the `scheduling` tag). The booking agent isn't asked until the page answers. It then loads `appointment-booking`, which unlocks `book_appointment`, which runs exactly once against the real MRN and is traced with the MRN masked. No identifier appears anywhere on the wire, skill frames included. |
| 4 | Replay | A second tab replays the whole transcript, including the three persistent skill frames, and it still carries no identifier. |
| 5 | Emergency | Another patient, whose portal declared no skills, gets no `plain-language` (client skills are per connection). Picking "Call 112 now" mounts an error-variant `genui-alert`, the calendar is never opened, and nothing is booked. |

The mekik pieces in play:

- the `authenticator` option and `mekik.authClaims`
- `runAgent` with `skills: { tags }` and a `redact` policy, over skill entries that own their tools
- `toolContext(config)` (`score_triage` keys its result by conversation)
- the `skills` and `clientSkills` app options
- `mekik.choose` / `mekik.action`
- the `clientTools` allowlist, with `mekik.clientTools` and `mekik.callClientTool`
- `mekik.genui.alert`
- reconnect replay

## Run it

From `ts/` (after `pnpm install && pnpm build`):

```bash
node examples/healthcare-triage/triage.ts
```

Each step prints the frames it saw and a `✓` line per assertion, ending with
`✅ healthcare-triage probe passed …`.
