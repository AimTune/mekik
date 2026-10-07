# Insurance claims desk

An ilmek graph served over mekik, driven offline by a scripted adjuster model.
The probe plays the client — including submitting the claim form — and asserts
its own frame stream, so it is also an integration test: no network, no API
key, exit code 0 or 1.

```text
START → intake (genui-form pause) → assess (policy tools + skills) → END
```

## What it shows

| # | Scenario | What the probe asserts |
|---|---|---|
| 0 | Connect | The server's skill catalog (`skills` option, three skills) is announced in a `skills` frame — names and descriptions only, never the instructions. |
| 1 | Intake + approval | The intake is a pause: an `interrupt` that mounts a `genui-form` (policy, date, peril, estimate, description) with no chips. The submitted values are the resume answer and reach `lookup_policy`. The model calls `load_skill` **mid-run**: one `skill` frame (`water-damage-assessment`, `status: "loaded"`, `source: "server"`) whose `seq` falls between the `lookup_policy` and `record_decision` traces. The model gets the instructions as the tool observation; the prompt lists only the skills tagged `home`, not the `auto` one. A typed `claim-decision` component shows the payout. |
| 2 | Rejection | A flood claim on a policy that excludes floods. The model loads `rejection-letter`, then tries an off-list reason code, which the tool's zod schema refuses before the body runs (an observation, not a crash, and no trace). The retry records the rejection; `claim-decision` carries a typed reason `{ code: "EXCLUDED_PERIL", clause: "4.2(b)", detail }`. |

The mekik pieces in play: `mekik.approve` with `ui: mekik.genui.form.ref(…)`,
the `skills` app option, `mekik.skillsPrompt(ctx, { tags })`, `withSkills` from
`@mekik/langchain` (the `load_skill` tool and its `skill` frame),
`withMekikTools`, and `mekik.component<ClaimDecision>("claim-decision")` for a
typed component whose props the compiler checks.

## Run it

From `ts/` (after `pnpm install && pnpm build`):

```bash
node examples/insurance/insurance.ts
```

Each step prints the frames it saw and a `✓` line per assertion, ending with
`✅ insurance probe passed …`.
