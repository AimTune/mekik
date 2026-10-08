# mekik conformance

Language-neutral parity for **mekik/1** (see [`../PROTOCOL.md`](../PROTOCOL.md)). Same shape as
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

Where the runners live:

| layer | TypeScript (`ts/packages/core/test/`) | .NET (`dotnet/test/Mekik.Core.Tests/`) |
| --- | --- | --- |
| golden fixtures | `fixtures.test.ts` | `ConformanceTests.cs` |
| catalog hashes | `hashes.test.ts` | `CatalogHashConformanceTests.cs` |
| MCP JSON-RPC | `mcp.test.ts` | `McpServerTests.cs` |
| A2A JSON-RPC | `a2a.test.ts` | `A2aServerTests.cs` |
| scenarios | `scenarios.test.ts`, `engine-edges.test.ts`, `client-tools.test.ts`, `skills.test.ts`, … | `EngineScenariosTests.cs`, `EngineEdgeTests.cs`, `ClientToolsTests.cs`, `SkillsTests.cs`, … |

The .NET test project copies the JSON files in this folder to its output
directory and reads them from `AppContext.BaseDirectory` (CI builds rewrite
source paths, so `[CallerFilePath]` cannot find them).

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
| `run-empty`            | `run_start` → `run{started}`; `run_end{done}` with no output → `run{finished}` only (no stream opened, so no `stream_done`) |
| `tokens`               | `emitToken` customs → streaming `genui` text chunks sharing one chunk id (one growing bubble); auto-close `stream_done` at run end |
| `single-approval`      | one `interrupt` → `interrupt` frame with `ui` + `actions`, `$mekik` stripped from the payload; `run{interrupted}` |
| `concurrent-approvals` | two pending in one `interrupt` event (same journal key) → two `interrupt` frames, distinct thread-scoped ids, both preserved |
| `mixed-turn`           | `mekik.tool` running→completed traces, a `mekik.ui` chunk, tokens and a `replyChannel` reply in one run: ordering, seq monotonicity, chunk-id sequencing (the text run shares one id; the ui chunk before and the `stream_done` after take their own), stream auto-close, then the consolidated `bot` `text`; `node_start` is ignored |
| `rich-message`         | `mekik.message` customs → persistent rich message frames (§4.5); caller id wins over the minted one; a reserved frame type is dropped |
| `client-tool-call`     | `mekik.callClientTool` (§11.3): running `tool_call` trace, then an interrupt whose `$mekik.tool` unwraps to `data.tool={name,params}` with empty payload and no ui/actions/event |
| `skill-loaded`         | `mekik.loadSkill` (§12.5): `$mekik.skill` customs → persistent `skill` frames carrying the use record verbatim; an unknown name is a `status:"error"` use; the reply follows |

The rest of the §4.1 table — `run_end{error}` (`⚠️` text + `run{error}`, the
`<node>: <message>` joining), `run_end{aborted}`, a plain `ctx.interrupt` with
no `$mekik`, an explicit chunk id — is pinned by each suite's mapper unit tests
(`mapper.test.ts` / `mapper-edges.test.ts`, `CoreUnitTests.cs`) rather than by a
shared fixture. A stream that throws mid-run (§4.1) is covered behaviourally by
the recursion-limit tests (`helpers-ports.test.ts`, `EngineEdgeTests.cs`).

### The MCP JSON-RPC fixture

[`mcp/rpc.json`](mcp/rpc.json) pins the JSON-RPC surface of `MekikMcpServer`
(PROTOCOL.md §13): `initialize` version negotiation, `ping`, the two advertised
tools, the error codes for unknown methods, unknown tools and bad argument
shapes. Both suites run every case against a server configured with the
fixture's `options`. `tools/call` results are asserted behaviourally instead —
conversation ids are minted at random.

### The A2A fixture

[`a2a/rpc.json`](a2a/rpc.json) pins `MekikA2aServer`'s Agent Card and JSON-RPC
surface (PROTOCOL.md §14): the card built from the fixture's `options` (the
agent as the first skill, then the app's skills), and the error codes for unknown
tasks, unsupported methods and bad message shapes. `message/send` results carry
minted ids and timestamps and are asserted behaviourally.

### The catalog hash fixture

[`hashes/catalogs.json`](hashes/catalogs.json) pins the `genui_components`
(§10.2) and `skills` (§12.2) catalog hashes. Each case carries the catalog, the
exact canonical JSON string that is hashed, and its sha256. The cases are chosen
where canonical JSON (§9) tends to drift between runtimes: declaration and key
order, quotes and markup characters, non-ASCII text, astral-plane characters
(emoji must stay raw, not become `\uD83C…` surrogate escapes), U+2028/U+2029
(raw) against control characters (escaped), and numbers in JavaScript's
shortest round-trip form (`1e+21`, `1e-7`). Generated by the TS reference
(`pnpm --filter @mekik/core gen:hashes`); both suites assert every case.

## Scenario suites (behavioural)

1. **handshake** - anonymous connect mints `userId`/`conversationId`; `welcome`
   returns them; client-asserted ids are adopted; a server-substituted
   `conversationId` resets client watermark to 0.
2. **watermark replay** - reconnect with `watermark = N` receives exactly the
   persistent frames with `seq > N`, in order, then live delivery; transient
   frames are never replayed. A `watermark` or id of the wrong type in the
   `hello` (or a non-numeric query-string watermark) is ignored as if absent
   (transport tests: `ts/packages/ws/test/`, `Mekik.AspNetCore.Tests`).
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
15. **component-event routing** - a node parked on `onEvent` announces its
    `interrupt{data:{event}}` with no `actions`; a `genui_event{scope:"component"}`
    of that name resolves it and its `payload` is the node's returned value. One
    that no node is waiting for is dropped without reaching the app handler.
16. **mekik-event routing** - a `genui_event{scope:"graph"}` never resolves a
    pause: it reaches the app handler, whose input update starts an ordinary turn
    (so `error{interrupted}` while parked, `error{busy}` mid-run, and no `text`
    frame from the user). An absent `scope` tries the component route first, then
    the graph one; an unknown `scope` is `error{bad_request}`.
17. **client tool declaration** (§11.1) - `hello.tools` are ignored entirely
    unless the app opts in; opted in, they reach `ctx.meta.clientTools`
    sanitized (nameless dropped, duplicate name last-wins); the policy function
    is an allowlist; a `client_tools` frame replaces the connection's set and
    `[]` withdraws it; one without a `tools` array is `error{bad_request}`; a
    multi-tab conversation snapshots the union, most recent declaration of a
    name winning.
18. **client tool tag filtering** (§11.2) - an untagged tool matches every
    query; a tagged tool only queries whose tags intersect; `mode` narrows by
    invocation kind; no filter returns everything.
19. **client tool round-trip** (§11.3) - `callClientTool` parks the run on an
    interrupt carrying `data.tool={name,params}` (no ui/actions/event, empty
    payload) after a running `tool_call` trace; a resume with `{ok:true,result}`
    resolves the call (completed trace carrying the result, stable trace id
    across the replay); `{ok:false,error}` makes it throw (error trace, run
    ends `error`); a bare non-envelope answer is taken as the result;
    `welcome.pending` re-announces the open call with `data.tool`; a journaled
    side effect before the call runs exactly once across the pause.
20. **client tool notify** (§11.3) - a `notify`-mode tool never parks: the
    invocation is a genui event chunk named `client_tool` with
    `payload={name,params}`, keyed by the trace id, and the running→completed
    trace pair emits in the same turn.
21. **skill catalog handshake** (§12.2) - a configured catalog is announced once
    after `welcome` as a transient `skills` frame carrying level-1 summaries
    (never instructions), each stamped `source:"server"`, with a sha256 hash
    over the canonical summaries; a matching `hello.skillsHash` draws
    `{unchanged:true}` and no list; no catalog ⇒ no frame. The hash ignores
    order and origin stamps and is identical across languages.
22. **client skill declaration** (§12.4) - `hello.skills` are ignored entirely
    unless the app opts in; sanitization drops a bad name, a missing or
    over-long description, missing instructions; duplicates last-win; the
    policy function is the allowlist; a `client_skills` frame replaces the set
    and `[]` withdraws it; a non-array draws `bad_request`; a client skill
    never overrides a server skill of the same name; multi-tab is the union
    with the latest declaration winning.
23. **skill snapshot and tags** (§12.3) - server skills list first, then
    client ones, each with its origin; untagged skills match every query and
    tagged ones only on intersection; the `source` filter narrows to one
    origin; the rendered prompt is byte-identical to ilmek's and empty when
    there is nothing to list.
24. **skill load** (§12.5) - `loadSkill` returns the instructions and emits a
    persistent `skill` frame with a replay-stable id (`…:skill:0`) and the
    origin; the frame replays to a reconnecting tab; a client-declared skill
    loads with `source:"client"`; an unknown name emits `status:"error"` and
    throws, ending the run `error`; `skillResource` reaches a folder-backed
    server source and is refused for client skills and sources without files.
25. **MCP turn** (§13.2) - `tools/call <name>` runs one turn: a finished run
    returns the reply as text and `{conversationId, status:"finished", reply,
    toolCalls, skills}`; a `conversationId` continues the conversation and an
    unknown one starts fresh (the result reports the id used); a graph error is
    a result with `isError` and the error text; `includeFrames` adds the
    persistent frames only.
26. **MCP pause and resume** (§13.2) - a paused run returns
    `status:"interrupted"` with `pending[{id, payload, actions?, tool?}]` and
    a text that names each interrupt and the resume tool; `<name>__resume` with
    answers keyed by id finishes it; a turn on a parked conversation, or a
    resume with nothing open, is `status:"refused"` with `isError` and the
    engine's error text — never a crash.
27. **MCP tools in an agent** (§13.1) - `withMcpTools` / `McpFunctions.Wrap`
    keep name, description and schema (a missing description gets a default);
    a call is a `tool_call` trace, runs once across a pause (same trace id on
    replay), and reads as the result text; `isError` results and structured-only
    results become observations; the policy map applies by exposed name and an
    `approve` decline never runs the remote tool.
28. **A2A turn as task** (§14.2) - `message/send` without a task id runs one
    turn and returns a `completed` task with the reply as a text artifact named
    `reply`, the user message in `history` stamped with task and context ids,
    and `metadata.mekik`; a `contextId` continues the conversation with a new
    task id; a graph error is `failed` with the error text as the status
    message; a turn on a parked conversation is `rejected` with the engine's
    `interrupted` text.
29. **A2A input-required and resume** (§14.3) - a paused turn is
    `input-required` with an agent status message (prose + a `{pending}` data
    part) and `metadata.pending`; a text reply on the task resolves a single
    interrupt (an action label maps to its value) and completes the task with
    three history entries; several open interrupts require a data part
    `{answers}` and refuse text alone; a message on a completed task is
    refused.
30. **A2A tasks/get and tasks/cancel** (§14.4) - `tasks/get` returns the task
    and `historyLength` truncates (0 ⇒ empty); `tasks/cancel` marks an
    `input-required` task `canceled` and answers `-32002` for a completed one.
31. **malformed frames** (§3.1) - bad JSON, a non-object, a missing or unknown
    `type`, and a known type with a wrong-typed required field each draw exactly
    one `error{bad_request}`; the connection stays open and the next valid frame
    runs. A frame from a connection that never connected (or already
    disconnected) is `error{no_session}`; a re-`hello` mid-session is ignored.
32. **mid-stream join** (§2) - a tab that connects while a run is streaming
    receives `welcome` first, then every persistent frame exactly once and in
    `seq` order, even when live frames are dispatched while its replay tail is
    still being read.
33. **client meta** (§6) - `meta.client` is the allowlisted subset of the
    connection's `hello.meta` with the frame's `meta` laid over it per key; it
    is per-connection (another tab's `hello.meta` never leaks) and dropped
    entirely without `acceptClientMeta`.
34. **lock hygiene** (§5) - the turn lock is free after a finished, errored or
    aborted run; a `TurnLock` that refuses is `error{busy}` with nothing written
    to the transcript; a lease whose release fails, or a lock whose acquire
    throws, never leaves the conversation answering `busy`; a tab that sends a
    turn and disconnects at once still has its turn run for the other tabs.
35. **stream that throws** (§4.1) - a run whose event stream throws after
    `run_start` (ilmek's recursion limit) ends on the wire like
    `run_end{error}`: a `⚠️` bot `text`, then `run{error}`, for every tab; the
    turn lock is freed.

Subtle cases fresh ports tend to break (mirroring ilmek's list): 6 and 7
(id-vs-key routing), 8 (pending re-announce), 12 (refuse new turn while parked),
14 (replay idempotence), 16 (scope precedence - the `submit` id shortcut outranks
`scope`, and a `component-event` must not fall through to the app handler).
