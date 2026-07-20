# Human-in-the-loop, the mekik way

mekik's headline feature is durable, interactive human-in-the-loop (HITL): a
graph node pauses for a person, the pause survives a process restart, and the
answer resumes the graph exactly where it stopped — without re-running the side
effects that already happened. This is ilmek's `ctx.interrupt` / `resume`
machinery (ilmek's `MODEL.md §6`) surfaced as first-class
protocol frames. This guide is the authoring contract.

## Pausing for a human

Use `mekik.approve` (`Shuttle.Approve` in .NET), a thin wrapper over ilmek's
`ctx.interrupt` that attaches presentation metadata:

```ts
const answer = await mekik.approve<{ approved: boolean }>(
    ctx,
    { title: `Refund ${order.total}?` },          // the question payload
    {
        ui: { component: "approval-form", props: { orderId: order.id } },  // mount a form
        actions: [                                                         // …or chip fallback
            { label: "Approve", value: { approved: true } },
            { label: "Reject",  value: { approved: false } },
        ],
    },
);
```

The node **suspends** at that `await` on the first pass — it never returns. The
engine emits an `interrupt` frame (carrying the question `payload`, the optional
`ui`, and the `actions`) and ends the run `interrupted`. When the client answers,
the graph re-runs the node from the top and the `await` returns the human's answer.

- Provide `ui` for a rich form, `actions` for quick-reply chips, or neither — the
  client then falls back to default Approve/Cancel chips.
- The question `payload` is arbitrary; whatever you pass reaches the client as
  `interrupt.data.payload` (with mekik's reserved `$mekik` metadata stripped).

## Answering

The client answers with a `resume` frame keyed by the **thread-scoped interrupt
id** the `interrupt` frame carried:

```jsonc
{ "type": "resume", "answers": { "gate:interrupt#0": { "approved": true } } }
```

Two rules the engine enforces for you:

- **Answer by `id`, never by ilmek's `key`.** Two nodes pausing in one superstep
  can share a journal `key` (`interrupt#0`); only the thread-scoped `id`
  disambiguates them. Answering by `key` would silently collapse concurrent pauses
  to one answer — a real bug this design exists to prevent (ilmek `MODEL.md §6.1`).
- **Answer *every* open interrupt in one `resume`.** ilmek's `resumeKeyed` requires
  it; a `resume` that omits an open interrupt draws `error{incomplete_resume}` and
  starts no run. When several pauses are open (a fan-out where each branch paused),
  send one `resume` with every id.

The engine acknowledges each answered pause with an `interrupt_resolved` frame
(so every tab, and future replay, learns it is closed), then streams the
continuation.

## The exactly-once rule (the whole point)

Because a paused node **re-runs from the top** on resume, any side effect that ran
before the pause would happen twice — unless it is journaled. Wrap every side
effect in `mekik.tool` (which is `ctx.step` plus a `tool_call` trace):

```ts
.node("checkout", async (s, ctx) => {
    // Runs ONCE, ever. On the resume pass it returns the journaled order.
    const order = await mekik.tool(ctx, "create_order", { cart: s.cart },
        () => Orders.create(s.cart));

    const ok = await mekik.approve(ctx, { title: `Charge ${order.total}?` });

    // Everything above re-runs on resume — but create_order is memoized, so no
    // second order is opened. This charge runs after the pause that gates it.
    await mekik.tool(ctx, "charge", { orderId: order.id }, () => Payments.charge(order));
    return { reply: "done" };
})
```

Two corollaries for tool authors:

- **Put a side effect *after* the pause that should gate it.** Anything before the
  pause re-runs (and is memoized); anything after runs only once the human has
  answered.
- The `tool_call` traces re-emit on the resume pass, but they are upserts by `id`,
  so the client just updates the existing entry — no duplicate spinners.

## Reconnecting mid-pause

Open interrupts live in ilmek's checkpoint, not in memory, so they survive a
restart. On (re)connect the `welcome` frame re-announces them in
`welcome.data.pending` — each with its `ui`/`actions` — so a reopened tab
re-renders the approval form and can answer it.

## Other controls

- **`abort`** cancels an in-flight run at the next superstep boundary; the last
  checkpoint stands, so the thread stays resumable. A pause already taken is
  unaffected.
- **A new `text` turn while parked** is refused with `error{interrupted}` — answer
  the open interrupt(s) first. (A plain new turn would drop the pause, mirroring
  ilmek's own `ResumeError`.)

## .NET note

In .NET the pause propagates as an `InterruptSignalException`. Any `try/catch`
around node work must rethrow it (`Shuttle.Tool` does) — a blanket `catch (Exception)`
would swallow the pause. See [`docs/LANGUAGES.md`](LANGUAGES.md).
