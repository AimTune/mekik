# TypeScript ↔ .NET parity

mekik ships two implementations that speak the identical `mekik/1` wire
([`PROTOCOL.md`](../PROTOCOL.md)). This is the naming map — it extends ilmek's own
`MODEL.md §11` conventions (TS `camelCase` free functions / builder methods; .NET
`PascalCase` + `Async` suffix).

| concept | TypeScript (`@mekik/core`, `@mekik/ws`) | .NET (`Mekik.Core`, `Mekik.AspNetCore`) |
| --- | --- | --- |
| app factory | `mekik(options)` → `MekikApp` | `new MekikApp(MekikOptions)` |
| serve | `serveWs(app, { port, path })` | `endpoints.MapMekik(path, app)` |
| engine | `ConversationEngine` | `ConversationEngine` |
| connection | `Connection` | `IConnection` |
| event → frame | `eventToFrames` / `TurnMapper` | `Mapper.EventToFrames` / `TurnMapper` |
| canonical JSON | `canonicalize` | `Json.Canonicalize` |
| parse inbound | `parseIncoming` | `Protocol.ParseIncoming` |
| authoring helpers | `mekik.text / ui / event / tool / approve` | `Shuttle.Text / Ui / Event / Tool / Approve` |
| ilmek seam | `IlmekAdapter` | `IlmekAdapter` |
| history port | `HistoryStore` / `InMemoryHistoryStore` | `IHistoryStore` / `InMemoryHistoryStore` |
| conversation port | `ConversationStore` / `InMemoryConversationStore` | `IConversationStore` / `InMemoryConversationStore` |
| auth port | `Authenticator` / `StaticTokenAuthenticator` | `IAuthenticator` / `StaticTokenAuthenticator` |
| id minter | `IdMinter` / `randomMinter()` | `IIdMinter` / `RandomMinter` |
| protocol version | `PROTOCOL_VERSION` | `Protocol.Version` |
| auth close code | `AUTH_CLOSE_CODE` (4401) | `Protocol.AuthCloseCode` |

## Deliberate divergences

1. **The helper class is `Shuttle`, not `Mekik`, in .NET.** A static class sharing its
   namespace's name (`Mekik`) binds ambiguously at call sites — the same reason
   ilmek's runtime is `IlmekRuntime`, not `Ilmek`. "Shuttle" is what *mekik* means —
   the loom part that carries the thread across — so the name still says what the
   layer does. .NET call sites read `Shuttle.Ui(ctx, …)`; TypeScript folds the
   helpers onto the callable `mekik` factory, so both `mekik({ graph })` and
   `mekik.ui(ctx, …)` work off one name.

2. **Frames are dictionaries in .NET.** The TS side has structural frame types; the
   .NET mapper builds `Dictionary<string, object?>` and the wire path stays
   dictionary-based. This is deliberate: it makes canonical-JSON parity exact,
   with nothing lost to serializer attributes, property casing, or optional-field
   omission. Frames are just JSON either way.

3. **Cancellation.** An `abort` frame cancels via an `AbortController`/`AbortSignal`
   in TS and a `CancellationTokenSource`/`CancellationToken` in .NET (which is what
   ilmek's .NET run loop already takes).

4. **The interrupt rethrow rule.** In .NET, any `try/catch` in the adapter or
   helpers that wraps node execution MUST rethrow when the exception is an
   `InterruptSignalException` — a blanket `catch (Exception)` would swallow the
   pause. `Shuttle.Tool` does this. (In TS the pause is a thrown non-`Error` value, so
   an `instanceof Error` catch can't swallow it; the helper still checks
   `isInterrupt` for symmetry.) See ilmek `MODEL.md §11`.

## What guarantees they agree

The [golden fixtures](../conformance/fixtures) are recorded ilmek event streams
plus the exact frames they must produce, in canonical JSON. Both `eventToFrames`
implementations replay the same files and compare byte-for-byte. If a change makes
the two diverge, a fixture test goes red. The behavioural
[scenarios](../conformance/README.md) cover the rest (handshake, replay, fan-out,
resume routing, locking, auth) as parallel test suites.
