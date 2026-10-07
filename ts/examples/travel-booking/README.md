# Travel booking

A multi-step ilmek graph served over mekik, driven offline by a scripted model.
The probe plays the client, including a dropped socket and two browser tabs,
and asserts its own frame stream, so it is also an integration test: no
network, no API key, exit code 0 or 1.

```text
START → route ─┬→ search → compare (genui-table + chips) → book (runAgent, approval) → END
               ├→ cancel (runAgent: confirm → cancel_booking → "rebook?") ──────────→ END
               └→ chat ────────────────────────────────────────────────────────────→ END
```

## Skills

The agency has a §12 catalog. `book` and `cancel` are `runAgent` loops, and
each one holds its consequential tool under the policy skill that governs it
(`skillTools`). Each tool also sits behind an approval policy.

| Skill | Tag | Holds |
|---|---|---|
| `fare-rules` | `booking` | `book_flight` (approval: "Book TK1759 for $824?") |
| `cancellation-policy` | `cancellation` | `cancel_booking` (approval: "Cancel BK-4001? …") |

## What it shows

| # | Scenario | What the probe asserts |
|---|---|---|
| 0 | Connect | A `skills` frame announces `fare-rules` and `cancellation-policy`. |
| 1 | Search and compare | `search_flights` is traced. The offers are mounted as a `genui-table` with a literal chunk id (`compare-offers`), with totals for two adults. The pick is an interrupt with one chip per offer, valued by offer id. |
| 2 | Reconnect | `book_flight` is not offered before `fare-rules` loads and is offered from the next round, where its approval policy parks the run. The socket dies while those frames stream. A new connection with `{ conversationId, watermark }` gets `welcome.pending` re-announcing the same approval id, and a replay that starts at `watermark + 1`, has no gaps, and is **exactly** the frames the dead socket missed, including the `fare-rules` skill frame. There is no second greeting. After the approval is answered from the new socket, **the unlocked set survives**: the next model round is still offered `book_flight`. Search, price check and booking each run exactly once. |
| 3 | Cancellation | `cancel_booking` is offered only after `cancellation-policy` loads. Two tabs see the same confirmation (fan-out) and confirm at once: one resume runs and the other is refused (`busy` or `not_interrupted`). `cancel_booking` runs before a second pause ("rebook?") in the **same node**, so the next resume replays the node, agent loop included. The model is not asked again, the skill-held cancellation stays at one call, and its re-emitted trace upserts the same id. Asking to cancel again finds the cancelled booking in graph state: no pause, no tool. |

The mekik pieces in play:

- `runAgent` with `skills: { tags }`, `skillTools` and `approve` policies
- the `skills` app option
- a router node
- `withMekikTools` for the search
- `mekik.genui.table` with an explicit `id`
- `mekik.approve` with dynamic `actions`
- `mekik.choose` with `key`
- the `hello.conversationId` / `hello.watermark` reconnect handshake

## Run it

From `ts/` (after `pnpm install && pnpm build`):

```bash
node examples/travel-booking/travel.ts
```

Each step prints the frames it saw and a `✓` line per assertion, ending with
`✅ travel-booking probe passed …`.
