---
sidebar_position: 1
title: TypeScript ↔ .NET
description: The naming map between @mekik/core and Mekik.Core, and the four deliberate divergences — the Shuttle helper name, dictionary frames, cancellation, and the interrupt rethrow rule.
---

# TypeScript ↔ .NET

mekik ships two implementations that speak the identical `mekik/1` wire: **TypeScript** (the reference) and **.NET** (the port). This page is the naming map and the handful of deliberate divergences. It extends ilmek's own `MODEL.md §11` conventions — TS `camelCase` free functions and builder methods; .NET `PascalCase` with an `Async` suffix.

## The naming map

| concept | TypeScript (`@mekik/core`, `@mekik/ws`) | .NET (`Mekik.Core`, `Mekik.AspNetCore`) |
|---|---|---|
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

The pattern is mechanical: a TS interface `Foo` becomes .NET `IFoo`; a TS free function `foo()` becomes a `PascalCase` method, `Async`-suffixed where it awaits. If you know one side, you can read the other.

## The four deliberate divergences

Where the two can't be mechanically identical, they diverge on purpose. Four cases:

### 1. The helper class is `Shuttle`, not `Mekik`

A static class sharing its namespace's name (`Mekik`) binds ambiguously at call sites — the same reason ilmek's runtime is `IlmekRuntime`, not `Ilmek`. So .NET call sites read `Shuttle.Ui(ctx, …)`. "Shuttle" is what *mekik* means — the loom part that carries the thread across — so the name still says what the layer does. TypeScript has no such clash: it folds the helpers onto the callable `mekik` factory, so both `mekik({ graph })` and `mekik.ui(ctx, …)` work off one name.

```ts
// TS
mekik.approve(ctx, { title: "Refund?" });
```
```csharp
// .NET
Shuttle.Approve(ctx, new() { ["title"] = "Refund?" });
```

### 2. Frames are dictionaries in .NET

The TS side has structural frame *types*; the .NET mapper builds `Dictionary<string, object?>` and the wire path stays dictionary-based. This is deliberate — it makes canonical-JSON parity **exact**, with nothing lost to serializer attributes, property casing, or optional-field omission. Frames are just JSON either way; .NET declines to model them as typed objects precisely so the serializer can't introduce a divergence the fixtures would then have to chase.

### 3. Cancellation

An `abort` frame cancels via an `AbortController`/`AbortSignal` in TS and a `CancellationTokenSource`/`CancellationToken` in .NET — which is exactly what ilmek's .NET run loop already takes. Same behaviour, each language's idiom.

### 4. The interrupt rethrow rule

This one is load-bearing. In .NET, an interrupt propagates as an `InterruptSignalException`, so any `try/catch` in the adapter or helpers that wraps node execution **must rethrow** when `InterruptSignalException.IsInterrupt(ex)` — a blanket `catch (Exception)` would swallow the pause and turn a human-in-the-loop into a silently-dropped run. `Shuttle.Tool` does this.

In TS the pause is a thrown *non-`Error` value*, so an `instanceof Error` catch can't accidentally swallow it — but the helper still checks `isInterrupt` for symmetry. If you write your own tool wrapper in .NET, this is the rule you must not forget. See ilmek `MODEL.md §11`.

```csharp
try {
    var result = await ctx.StepAsync(name, fn);
    // …
} catch (Exception ex) when (!InterruptSignalException.IsInterrupt(ex)) {
    // only real failures land here; the pause propagates untouched
}
```

## What guarantees they agree

Naming and divergences are cosmetic; the wire is not. Two mechanisms hold the two implementations to byte-identical output:

1. **Golden fixtures** — recorded ilmek event streams plus the exact frames they must produce, in canonical JSON. Both `eventToFrames` implementations replay the same files and compare byte-for-byte. If a change makes them diverge, a fixture test goes red.
2. **Scenario suites** — the multi-frame, multi-run behaviours (handshake, replay, fan-out, resume routing, locking, auth), written as ordinary tests in each language against the same observable wire.

Canonical JSON is UTF-8, object keys sorted ascending, no insignificant whitespace, numbers in shortest round-trip form. The full list of fixtures and scenarios is [Conformance](./conformance.md).

## Where to go next

- [**Conformance**](./conformance.md) — the golden fixtures and the scenario list.
- [**Protocol → Event mapping**](../protocol/event-mapping.md) — the mapping both `eventToFrames` implementations encode.
- [**Authoring → Helpers**](../authoring/helpers.md) — the `mekik.*` / `Shuttle.*` helpers side by side.
