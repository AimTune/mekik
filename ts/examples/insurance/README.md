# Insurance claims desk

An ilmek graph served over mekik, driven offline by a scripted adjuster model.
The probe plays the client (it submits the claim form and the senior adjuster's
sign-off) and asserts its own frame stream, so it is also an integration test:
no network, no API key, exit code 0 or 1.

```text
START → intake (genui-form pause) → assess (runAgent + skills) → END
```

The adjuster node is a `runAgent` loop from `@mekik/langchain`. Only
`lookup_policy` is always offered. The decision tools are **held under a
skill** with `skillTools` (§12): the model doesn't see them until it loads the
skill that governs them.

```ts
skillTools: {
    "water-damage-assessment": [checkCoverage, approveClaim],
    "rejection-letter": [checkCoverage, rejectClaim],
},
policy: { approve_claim: { approve: SIGN_OFF }, reject_claim: { approve: SIGN_OFF } },
```

## What it shows

| # | Scenario | What the probe asserts |
|---|---|---|
| 0 | Connect | The server's skill catalog (`skills` option, three skills) is announced in a `skills` frame. It carries names and descriptions only, never the instructions. |
| 1 | Intake + approval | The intake is a pause: an `interrupt` that mounts a `genui-form` with no chips, and the submitted values are the resume answer that reaches `lookup_policy`. **(a)** Until `load_skill`, every model round is offered only `lookup_policy` and `load_skill`. **(b)** A scripted premature `check_coverage` call is refused with an observation naming the skill to load; the tool doesn't run and no trace is emitted. One `skill` frame (`water-damage-assessment`, `source: "server"`) follows. The `load_skill` observation names the unlocked tools. **(c)** From the next round on, `check_coverage` and `approve_claim` are offered, and `reject_claim` never is. `approve_claim` parks the run for the senior adjuster's sign-off. **(d)** After the resume, only one new model round runs (the earlier ones replay from the journal). That round is still offered the unlocked tools, and `approve_claim` runs exactly once. The typed `claim-decision` component shows the payout. The prompt lists only the `home`-tagged skills. |
| 2 | Rejection | A flood claim on a policy that excludes floods. Loading `rejection-letter` unlocks `check_coverage` and `reject_claim` (not `approve_claim`). After the sign-off, `reject_claim` runs once, and `claim-decision` carries a typed reason `{ code: "EXCLUDED_PERIL", clause: "4.2(b)", detail }` whose code is pinned by the tool's zod enum. |

The mekik pieces in play are:

- `mekik.approve` with `ui: mekik.genui.form.ref(…)`
- the `skills` app option
- `runAgent` with `skills: { tags }`, `skillTools` and an approval `policy`
- `mekik.component<ClaimDecision>("claim-decision")`, a typed component whose props the compiler checks

The probe drives `runAgent` through `ScriptedModel.asChatModel`, which records the tool list offered in each round.

## Run it

From `ts/` (after `pnpm install && pnpm build`):

```bash
node examples/insurance/insurance.ts
```

Each step prints the frames it saw and a `✓` line per assertion, ending with
`✅ insurance probe passed …`.
