# Travel booking

A multi-step ilmek graph served over mekik, driven offline by a scripted model.
The probe plays the client — including a dropped socket and two browser tabs —
and asserts its own frame stream, so it is also an integration test: no
network, no API key, exit code 0 or 1.

```text
START → route ─┬→ search → compare (genui-table + chips) → book (approval) → END
               ├→ cancel (confirm → cancel_booking → "rebook?") ───────────→ END
               └→ chat ────────────────────────────────────────────────────→ END
```

## What it shows

| # | Scenario | What the probe asserts |
|---|---|---|
| 1 | Search and compare | `search_flights` is traced; the offers are mounted as a `genui-table` with a literal chunk id (`compare-offers`), totals for two adults; the pick is an interrupt with one chip per offer, valued by offer id. |
| 2 | Reconnect | The client persists up to a watermark, picks a flight, and the socket dies while `price_check` and the booking approval stream. A new connection with `{ conversationId, watermark }` gets `welcome.pending` re-announcing the same approval id, the server's watermark, and a replay that starts at `watermark + 1` with no gaps and is **exactly** the frames the dead socket missed — no second greeting. Answering the replayed approval from the new socket books once; search, price check and booking each ran exactly once. |
| 3 | Cancellation | Two tabs see the same confirmation (fan-out) and both confirm at once: one resume runs, the other is refused (`busy` or `not_interrupted`). `cancel_booking` runs before a second pause ("rebook?") in the **same node**, so the next resume replays the node from the top; the journal keeps the cancellation at one call, and its re-emitted trace upserts the same id. Asking to cancel again finds the cancelled booking in graph state: no pause, no tool. |

The mekik pieces in play: a router node, `withMekikTools` for the model's
search, `mekik.genui.table` with an explicit `id`, `mekik.approve` with dynamic
`actions`, `mekik.choose` with `key` for two pauses in one node, `mekik.tool`
for journaled provider calls, and the `hello.conversationId` /
`hello.watermark` reconnect handshake.

## Run it

From `ts/` (after `pnpm install && pnpm build`):

```bash
node examples/travel-booking/travel.ts
```

Each step prints the frames it saw and a `✓` line per assertion, ending with
`✅ travel-booking probe passed …`.
