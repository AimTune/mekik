# Mekik.Redis

Redis horizontal-scale backends for [mekik](https://github.com/AimTune/mekik) —
the two ports a fleet needs, so a single-node app becomes N nodes behind a load
balancer with **no engine changes**. The .NET mirror of `@mekik/redis`; see
[`docs/SCALING.md`](https://github.com/AimTune/mekik/blob/main/docs/SCALING.md)
for the model.

- **`RedisTurnLock`** — a `SET NX PX` single-writer lease per conversation, so
  only one node runs a turn at a time. The held lease heartbeats its own TTL, so a
  long streaming run never lets the lock lapse; a crashed owner's lock expires.
- **`RedisBackplane`** — Redis Pub/Sub cross-node fan-out, so every node holding a
  tab of a conversation re-fans each frame to its own sockets.

```csharp
using Mekik;
using StackExchange.Redis;

var redis = await ConnectionMultiplexer.ConnectAsync(builder.Configuration["Redis"]!);

var app = new MekikApp(new MekikOptions
{
    Graph = graph,
    TurnLock  = new RedisTurnLock(redis),   // single-writer lease across nodes
    Backplane = new RedisBackplane(redis),  // cross-node fan-out
});
```

Pass **nothing** and mekik keeps its process-local defaults (`LocalTurnLock`,
`NoopBackplane`) — scaling is entirely opt-in, exactly like `History` and
`Conversations`.

Built on [StackExchange.Redis](https://www.nuget.org/packages/StackExchange.Redis):
share one `IConnectionMultiplexer` across both. The turn lock uses its database; the
backplane uses its subscriber (a multiplexer already manages the subscribe-mode
connection internally, so no second connection to wire up).

## `RedisTurnLock` options

```csharp
new RedisTurnLock(redis, new RedisTurnLockOptions
{
    KeyPrefix = "mekik",                  // share one Redis across apps. Default "mekik".
    Ttl       = TimeSpan.FromSeconds(30), // lock TTL; must exceed a turn's worst case. Default 30s.
    Heartbeat = TimeSpan.FromSeconds(10), // self-renew interval. Default Ttl / 3 (at least 1s).
    OnLost    = convId => logger.LogWarning("turn lease lost {Conv}", convId),
});
```

The lease is token-checked: a node can only renew or release a lock it still
holds, so a slow node whose TTL lapsed can never free the new owner's lock. The
key is `{KeyPrefix}:lock:{conversationId}`. The lease releases on `DisposeAsync`
(the engine disposes it when the turn ends). If that release fails (a Redis blip),
the engine still frees its local turn lock and the key simply expires on its TTL,
so the conversation never answers `busy` forever.

## `RedisBackplane` options

```csharp
new RedisBackplane(redis, new RedisBackplaneOptions { KeyPrefix = "mekik" });
```

The channel is `{KeyPrefix}:bp:{conversationId}`, and each message is the
canonical-JSON envelope `{"frame", "originId"}` (camelCase, `BackplaneEnvelope.Encode`)
— the engine skips its own by `OriginId`, and a relayed frame reaches the engine
in the same shape as a locally produced one. The TypeScript `@mekik/redis`
backplane writes the same bytes, so TypeScript and .NET nodes can share one prefix
(PROTOCOL.md §5.1). A malformed payload is dropped, never fanned out; for one
release `BackplaneEnvelope.Decode` also reads the PascalCase `{"OriginId", "Frame"}`
that 0.9 wrote, so a running fleet can be upgraded node by node. The returned subscription unsubscribes on
`DisposeAsync`.

## Routing

A fleet needs sticky-by-`conversationId` ingress so a conversation's connections
land on its owner node (the backplane is a fallback for the re-home window, not the
steady-state path). `conversationId` travels in the WebSocket query string so an
edge proxy can hash on it without parsing frames. See
[`docs/SCALING.md`](https://github.com/AimTune/mekik/blob/main/docs/SCALING.md).

MIT
