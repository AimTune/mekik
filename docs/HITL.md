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

## Buttons, typed (no hand-written JSON)

When the pause is really just "pick one of these buttons", skip `approve`'s
generic + `actions` JSON and use `mekik.choose` (`Shuttle.Choose` in .NET) with
`mekik.action` (`Shuttle.Action`) chip constructors:

```ts
// Bare strings: the answer IS the picked label — and the type is inferred.
const size = await mekik.choose(ctx, "Pick a size", ["S", "M", "L"]);
//    ^? "S" | "M" | "L"

// Valued chips: the answer is the picked action's value.
const verdict = await mekik.choose(ctx, { title: `Refund ${order.total}?` }, [
    mekik.action("Approve", { approved: true }),
    mekik.action("Reject", { approved: false }),
]);
if (verdict.approved) { /* … */ }
```

```csharp
var size = await Shuttle.Choose<string>(ctx, "Pick a size", ["S", "M", "L"]);
var verdict = await Shuttle.Choose<Dictionary<string, object?>>(ctx, "Refund?",
    [Shuttle.Action("Approve", new Dictionary<string, object?> { ["approved"] = true }),
     Shuttle.Action("Reject",  new Dictionary<string, object?> { ["approved"] = false })]);
```

On the wire this is a plain `interrupt` frame whose `actions` are the options —
nothing new for a client to learn; chativa renders the same chips it always has.
The rules:

- A **string payload** is shorthand for `{ title }`; pass a record to shape the
  payload yourself.
- A **bare string option** is both label and answer. An option built with
  `mekik.action(label, value)` resolves to its `value`; with no value, to its label
  (the protocol's `MessageAction` rule).
- In TypeScript the answer type is **inferred from the options** — no manual
  generic. As with `approve<T>`, it is a contract with your client, not a wire
  guarantee.
- `opts.ui` still mounts a form alongside (chips remain the fallback), and
  `opts.key` disambiguates a node that pauses more than once.

`choose` **parks the run** until someone picks. For buttons that merely offer a
shortcut — the user may tap one or type something else entirely — send a buttons
or quick-reply *message* instead ([GENUI.md](GENUI.md#2-rich-messages)); the tap
arrives as the next user turn rather than as a resume.

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
