# mekik conformance

Language-neutral parity for **mekik/1** (see `../../PROTOCOL.md`). Same shape as
ilmek's own `conformance/README.md`: a scenario list every implementation encodes
as its own test suite, plus **golden fixtures** that both suites replay
byte-for-byte.

Two layers:

1. **Golden fixtures** (`fixtures/*.json`) - pin the pure `eventToFrames`
   mapping. Each fixture is a recorded ilmek event stream for one run plus the
   exact mekik frames it must produce. Both `eventToFrames` implementations
   replay them and compare canonical JSON. This is the closed, machine-checkable
   core of the contract.
2. **Scenario suites** - pin the engine behaviours that involve more than one
   frame or more than one run (handshake, replay, fan-out, resume routing,
   locking, auth). Each language writes these as ordinary tests
   (`node --test` in TS, `dotnet test` in .NET), asserting the same observable
   wire behaviour.

## Fixture format

```jsonc
{
  "name": "single-approval",
  "description": "one interrupt → interrupt frame with ui + actions",
  "startSeq": 6, // conversation's persistent seq before this run (watermark base)
  "replyChannel": "reply", // optional: channel whose final value becomes the run's reply text
  "events": [
    /* IlmekEvent JSON, in yield order */
  ],
  "expectedFrames": [
    /* mekik Frame JSON, in emit order */
  ],
}
```

**Determinism.** So fixtures are reproducible across languages, the mapper is
instantiated with:

- a **seq allocator** starting at `startSeq + 1`, incremented once per persistent
  frame;
- a **deterministic id minter**: message ids `msg-1`, `msg-2`, …; stream ids
  `stream-1`, `stream-2`, … (each kind its own 1-based counter, minted in emit
  order). Production uses a random minter; only the minter differs.
- a **fixed clock** returning `1750000000000` for every `timestamp`. Production
  uses the wall clock; only the clock differs.

The `IlmekEvent` JSON carries a stable placeholder envelope
(`runId:"run-1"`, `threadId:"conv-1"`, ilmek's own `seq`, `ns:[]`); the mapper
ignores the envelope and assigns mekik's own `seq`. Fixtures are generated once
by the TS reference (`pnpm --filter @mekik/core gen:fixtures`), hand-reviewed,
and committed; both suites then treat them as read-only goldens.

## Golden fixture cases (`fixtures/`)

| fixture                | exercises                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `run-empty`            | `run_start` → `run{started}`; `run_end{done}` with no output → `run{finished}` only         |
| `tokens`               | `emitToken` customs → streaming `genui` text chunks; auto-close `stream_done` at run end    |
| `genui-ui`             | `mekik.ui` custom → `genui` ui chunk; chunk-id assignment                                  |
| `tool-call`            | `mekik.tool` running→completed customs → `tool_call` upsert by id                          |
| `tool-error`           | tool failure → `tool_call{status:"error"}`                                                  |
| `reply-text`           | `run_end{done}` + `replyChannel` → consolidated `bot` `text` frame after stream close       |
| `single-approval`      | one `interrupt` → `interrupt` frame with `ui` + `actions`; `run{interrupted}`               |
| `plain-interrupt`      | `ctx.interrupt` with no `$mekik` → `interrupt` frame, no `ui`/`actions`                    |
| `concurrent-approvals` | two pending in one `interrupt` event → two `interrupt` frames, distinct ids, both preserved |
| `run-error`            | `run_end{error}` → `⚠️` `text` + `run{error}`                                               |
| `run-aborted`          | `run_end{aborted}` → `run{aborted}` only, no text                                           |
| `mixed-turn`           | ui + tokens + tool + reply in one run (ordering + seq monotonicity)                         |

## Scenario suites (behavioural)

1. **handshake** - anonymous connect mints `userId`/`conversationId`; `welcome`
   returns them; client-asserted ids are adopted; a server-substituted
   `conversationId` resets client watermark to 0.
2. **watermark replay** - reconnect with `watermark = N` receives exactly the
   persistent frames with `seq > N`, in order, then live delivery; transient
   frames are never replayed.
3. **multi-tab fan-out** - two connections on one conversation both receive every
   persistent frame; the sender's own `text` turn is not echoed to itself but is
   delivered to the other connection and stored.
4. **cross-run seq** - persistent `seq` is monotonic across multiple runs of one
   conversation (does not reset per run, unlike ilmek's event seq).
5. **single approval round-trip** - `interrupt` → `resume{answers:{[id]:…}}` →
   `interrupt_resolved` → run continues → `run{finished}`.
6. **concurrent interrupts routed by id** - two pending; a `resume` answering both
   ids resumes correctly; answering by ilmek `key` would collapse them (must not).
7. **incomplete resume rejected** - two pending, a `resume` answering only one id
   draws `error{incomplete_resume}` and starts no run (ilmek's `resumeKeyed`
   requires every open interrupt answered); a `resume` answering both finishes it.
8. **reconnect while interrupted** - `welcome.data.pending` re-announces open
   interrupts with their `ui`/`actions` so the UI re-renders the form.
9. **genui-form submit** - `genui_event{eventType:"submit", payload:{id, answer}}`
   whose `id` names an open interrupt is coerced to a `resume` (equivalent path).
10. **abort** - `abort` frame ends the run `aborted`; the last checkpoint stands;
    a subsequent `resume`/`text` still works on the thread.
11. **turn lock** - a second `text` while a run is in flight gets
    `error{busy}`; only one run executes.
12. **new turn while interrupted** - a `text` (not `resume`) while parked draws
    `error{interrupted}` and does not start a run.
13. **auth reject** - bad token → `error{unauthorized}` + WS close 4401; verified
    `userId` overrides a spoofed asserted one; `claims` reach `meta.auth`.
14. **exactly-once under replay** - a `mekik.tool` side effect before an
    interrupt runs once across the pause/resume cycle (the ilmek journal
    guarantee, observed through the wire: one `tool_call{running}` id, not two).

Subtle cases fresh ports tend to break (mirroring ilmek's list): 6 and 7
(id-vs-key routing), 8 (pending re-announce), 12 (refuse new turn while parked),
14 (replay idempotence).
