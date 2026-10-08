---
sidebar_position: 2
title: Conformance
description: How mekik proves two implementations produce one wire — golden fixtures that pin the pure event→frame mapping, and scenario suites that pin the multi-frame engine behaviours.
---

# Conformance

Two implementations, one wire. The claim that TypeScript and .NET produce byte-identical `mekik/1` is not a hope — it's checked, two ways. This page is how. The [normative source](https://github.com/AimTune/mekik/blob/main/conformance/README.md) is `conformance/README.md`; this is its tour.

## Two layers

```mermaid
flowchart TD
  subgraph closed["Golden fixtures — the closed, machine-checkable core"]
    F["fixtures/*.json<br/>recorded events + expected frames"]
    F --> TS["TS eventToFrames"]
    F --> NET[".NET EventToFrames"]
    TS --> Cmp{canonical JSON<br/>byte-for-byte?}
    NET --> Cmp
  end
  subgraph open["Scenario suites — multi-frame behaviours"]
    S["35 scenarios<br/>(handshake, replay, fan-out, …)"]
    S --> TSt["node --test"]
    S --> NETt["dotnet test"]
  end
```

1. **Golden fixtures** pin the *pure* `eventToFrames` mapping. Each fixture is a recorded ilmek event stream for one run plus the exact mekik frames it must produce. Both implementations replay them and compare canonical JSON. This is the closed core of the contract.
2. **Scenario suites** pin the engine behaviours that involve more than one frame or more than one run — handshake, replay, fan-out, resume routing, locking, auth. Each language writes these as ordinary tests asserting the same observable wire.

## Why fixtures work: determinism

A pure function can only be pinned if it's deterministic. `eventToFrames` isn't quite pure — it mints ids, stamps timestamps, allocates seq — so the fixtures inject deterministic versions of exactly those three things:

- a **seq allocator** starting at `startSeq + 1`, incremented once per persistent frame;
- a **deterministic id minter**: message ids `msg-1`, `msg-2`, …; stream ids `stream-1`, `stream-2`, … (each kind its own 1-based counter, minted in emit order);
- a **fixed clock** returning `1750000000000` for every `timestamp`.

Production swaps in a random minter and the wall clock — *only those differ.* The input `IlmekEvent` JSON carries a stable placeholder envelope (`runId:"run-1"`, `threadId:"conv-1"`, ilmek's own seq, `ns:[]`); the mapper ignores the envelope and assigns mekik's own seq. Fixtures are generated once by the TS reference (`pnpm --filter @mekik/core gen:fixtures`), hand-reviewed, committed, and thereafter treated as read-only goldens by both suites.

### Canonical JSON

The comparison is byte-for-byte over **canonical** JSON: UTF-8, object keys sorted ascending, no insignificant whitespace, numbers in shortest round-trip form. "Sorted" means exactly what JavaScript's `JSON.stringify` emits for an object built in sorted order: integer-like keys (`"9"`, `"10"`) first in numeric order, then the rest in ascending code-unit order. `canonicalize` (TS) and `Json.Canonicalize` (.NET) produce it. This is why .NET models frames as dictionaries rather than typed objects — see [Parity divergence 2](./languages.md#the-six-deliberate-divergences).

## The golden fixtures

| fixture | exercises |
|---|---|
| `run-empty` | `run_start` → `run{started}`; `run_end{done}` with no output → `run{finished}` only |
| `tokens` | `emitToken` customs → streaming `genui` text chunks sharing one chunk id; auto-close `stream_done` at run end |
| `single-approval` | one `interrupt` → `interrupt` frame with `ui` + `actions`; `run{interrupted}` |
| `concurrent-approvals` | two pending in one `interrupt` → two `interrupt` frames, distinct ids, both preserved |
| `mixed-turn` | tool traces (running → completed), a ui chunk, tokens and a consolidated reply in one run: ordering, seq monotonicity, chunk-id sequencing, stream auto-close |
| `client-tool-call` | `mekik.callClientTool`: a running `tool_call` trace, then an `interrupt` whose `data.tool` is `{name, params}` with an empty payload |
| `rich-message` | `mekik.message` customs → persistent [rich message frames](../authoring/messages.md); a caller-supplied id wins over the minted one; a reserved frame type is dropped |
| `skill-loaded` | `mekik.loadSkill` customs → persistent [`skill` frames](../authoring/skills.md) carrying the use record verbatim; an unknown name is a `status:"error"` use |

Each row is a claim about the [event→frame mapping](../protocol/event-mapping.md), frozen as JSON. The remaining rows of that table — `run_end{error}`, `run_end{aborted}`, a plain `ctx.interrupt` with no `$mekik`, an explicit chunk id — are pinned by each language's mapper unit tests instead of a shared fixture.

[`conformance/hashes/catalogs.json`](https://github.com/AimTune/mekik/blob/main/conformance/hashes/catalogs.json) pins the `genui_components` and `skills` catalog hashes: each case carries the catalog, the exact canonical JSON string that gets hashed, and its sha256, chosen where runtimes tend to drift (key order, non-ASCII and emoji, U+2028/U+2029, number formatting).

Another fixture file, [`conformance/mcp/rpc.json`](https://github.com/AimTune/mekik/blob/main/conformance/mcp/rpc.json), pins the JSON-RPC surface of the [MCP server](../serving/mcp.md) — `initialize`, `ping`, `tools/list`, the error codes — request by request, replayed by both suites. A third, [`conformance/a2a/rpc.json`](https://github.com/AimTune/mekik/blob/main/conformance/a2a/rpc.json), pins the [A2A agent](../serving/a2a.md)'s Agent Card and JSON-RPC surface the same way. And [`conformance/redis/envelope.json`](https://github.com/AimTune/mekik/blob/main/conformance/redis/envelope.json) pins the [Redis backplane](../scaling.mdx) envelope: both encoders must write the exact same canonical `{"frame", "originId"}` string, each suite decodes the other language's output, and malformed payloads must decode to nothing.

## The scenario suites

The 35 behavioural scenarios cover what a single-run fixture can't. The first sixteen are the core wire:

1. **handshake** — anonymous connect mints ids; `welcome` returns them; asserted ids adopted; a substituted `conversationId` resets client watermark to 0.
2. **watermark replay** — reconnect with `watermark = N` receives exactly the persistent frames with `seq > N`, in order, then live delivery; transient frames never replay.
3. **multi-tab fan-out** — two connections both receive every persistent frame; the sender's own `text` is not echoed to itself but is delivered to the other connection and stored.
4. **cross-run seq** — persistent `seq` is monotonic across multiple runs of one conversation (does not reset per run).
5. **single approval round-trip** — `interrupt` → `resume` → `interrupt_resolved` → continue → `run{finished}`.
6. **concurrent interrupts routed by id** — two pending; a `resume` answering both ids resumes correctly; answering by ilmek `key` would collapse them (must not).
7. **incomplete resume rejected** — answering only one of two draws `error{incomplete_resume}` and starts no run; answering both finishes it.
8. **reconnect while interrupted** — `welcome.data.pending` re-announces open interrupts with their `ui`/`actions`.
9. **genui-form submit** — `genui_event{eventType:"submit", payload:{id, answer}}` naming an open interrupt is coerced to a `resume`.
10. **abort** — an `abort` ends the run `aborted`; the last checkpoint stands; a later `resume`/`text` still works.
11. **turn lock** — a second `text` while a run is in flight gets `error{busy}`; only one run executes.
12. **new turn while interrupted** — a `text` (not `resume`) while parked draws `error{interrupted}` and starts no run.
13. **auth reject** — bad token → `error{unauthorized}` + WS close 4401; a verified `userId` overrides a spoofed asserted one; `claims` reach `meta.auth`.
14. **exactly-once under replay** — a `mekik.tool` side effect before an interrupt runs once across the pause/resume (observed as one `tool_call{running}` id, not two).
15. **component-event routing** — a node parked on `onEvent` announces its `interrupt{data:{event}}` with no `actions`; a `genui_event{scope:"component"}` of that name resolves it and its `payload` is the node's returned value. One no node is waiting for is dropped without reaching the app handler.
16. **mekik-event routing** — a `genui_event{scope:"graph"}` never resolves a pause: it reaches the app handler, whose input update starts an ordinary turn (`error{interrupted}` while parked, `error{busy}` mid-run, no user `text` frame). An absent `scope` tries the component route first, then the graph one; an unknown `scope` is `error{bad_request}`.

The rest cover the opt-in features and the edges — the [normative list](https://github.com/AimTune/mekik/blob/main/conformance/README.md#scenario-suites-behavioural) has each one in full:

- **17–20, client tools** — declaration and sanitization (ignored unless the app opts in), tag and mode filtering, the `call` round-trip with its `{ok, result | error}` envelope, and `notify` as a `client_tool` event chunk.
- **21–24, skills** — the `skills` catalog handshake and its hash, client skill declarations (off by default; never override a server skill), the turn snapshot with tags and origin, and `loadSkill`'s persistent `skill` frame.
- **25–27, MCP** — a turn as `tools/call`, pause and `<name>__resume`, and MCP tools inside an agent.
- **28–30, A2A** — a turn as a task, `input-required` and resume, `tasks/get` / `tasks/cancel`.
- **31, malformed frames** — `bad_request` for bad JSON, a non-object, a missing or unknown `type` or a wrong-typed field, with the connection kept open; `no_session` before the handshake; a re-`hello` ignored.
- **32, mid-stream join** — a tab connecting while a run streams gets every persistent frame exactly once, in `seq` order.
- **33, client meta** — `meta.client` is the allowlisted `hello.meta` with the frame's `meta` laid over it, per connection.
- **34, lock hygiene** — the turn lock is free after every terminal state, a refusing `TurnLock` is `busy` with nothing written, and a failing lease release never wedges the conversation.
- **35, stream that throws** — a run whose event stream throws after `run_start` still ends with a `⚠️` bot `text` and `run{error}` for every tab.

> **The scenarios ports tend to break** (mirroring ilmek's own list): **6 and 7** (id-vs-key routing), **8** (pending re-announce), **12** (refuse a new turn while parked), **14** (replay idempotence), and **16** (scope precedence — the `submit` id shortcut outranks `scope`, and a `component-event` must not fall through to the app handler). If you're porting mekik to a third language, write these five first.

## Running it

```bash
# TypeScript — golden fixtures + behavioural scenarios via node --test
cd ts && pnpm check

# .NET — replays the SAME fixtures through its own EventToFrames, canonical compare
cd dotnet && dotnet test Mekik.slnx
```

The .NET suite loading the *same* fixture files and comparing canonical JSON is what proves the two implementations produce identical wire — not two parallel test suites that happen to agree, but one set of goldens replayed through both mappers.

> **CI gotcha worth knowing:** `[CallerFilePath]` can't locate repo files in CI because deterministic builds rewrite source paths to `/_/`. The fixtures are copied to the test output directory and resolved via `AppContext.BaseDirectory` instead.

## Where to go next

- [**TypeScript ↔ .NET**](./languages.md) — the naming map and the divergences these tests hold in place.
- [**Protocol → Event mapping**](../protocol/event-mapping.md) — the mapping the fixtures pin.
- [**Engine & turn lifecycle**](../engine.md) — the behaviours the scenario suites cover.
