# @mekik/redis

Redis horizontal-scale backends for [mekik](https://github.com/AimTune/mekik) —
the two ports a fleet needs, so a single-node app becomes N nodes behind a load
balancer with **no engine changes**. See [`docs/SCALING.md`](https://github.com/AimTune/mekik/blob/main/docs/SCALING.md)
for the model.

- **`RedisTurnLock`** — a `SET NX PX` single-writer lease per conversation, so
  only one node runs a turn at a time. The held lease heartbeats its own TTL, so a
  long streaming run never lets the lock lapse; a crashed owner's lock expires.
- **`RedisBackplane`** — Redis Pub/Sub cross-node fan-out, so every node holding a
  tab of a conversation re-fans each frame to its own sockets.

```ts
import { Redis } from "ioredis";
import { mekik } from "@mekik/core";
import { RedisTurnLock, RedisBackplane } from "@mekik/redis";

const redis = new Redis(process.env.REDIS_URL!);

const app = mekik({
  graph,
  turnLock: new RedisTurnLock(redis),   // single-writer lease across nodes
  backplane: new RedisBackplane(redis),  // cross-node fan-out
});
```

Pass **nothing** and mekik keeps its process-local defaults (`LocalTurnLock`,
`NoopBackplane`) — scaling is entirely opt-in, exactly like `history` and
`conversations`.

## Bring your own client

`ioredis` is an optional peer dependency. This package never imports it — it types
the client structurally (see `RedisClient`), so any client with the handful of
methods it uses works, and you share your own connection:

- `RedisTurnLock` uses one connection.
- `RedisBackplane` `duplicate()`s the connection for its subscriber, because a
  client in subscribe mode cannot also `PUBLISH`. Pass `{ subscriber }` to supply
  your own dedicated subscriber instead.

## `RedisTurnLock` options

```ts
new RedisTurnLock(redis, {
  keyPrefix: "mekik",   // share one Redis across apps. Default "mekik".
  ttlMs: 30_000,        // lock TTL; must exceed a turn's worst case. Default 30s.
  heartbeatMs: 10_000,  // self-renew interval. Default ttlMs / 3.
  onLost: (convId) => log.warn("turn lease lost", convId),
});
```

The lease is token-checked: a node can only renew or release a lock it still
holds, so a slow node whose TTL lapsed can never free the new owner's lock. The
key is `${keyPrefix}:lock:${conversationId}`.

## `RedisBackplane` options

```ts
new RedisBackplane(redis, {
  keyPrefix: "mekik",   // channel prefix. Default "mekik".
  subscriber: mySubConn, // your own subscribe-mode connection. Default: redis.duplicate().
});
```

One subscriber connection is multiplexed across every conversation — channels are
reference-counted, so the Nth `subscribe` shares one Redis `SUBSCRIBE` and the last
`unsubscribe` tears it down. The channel is `${keyPrefix}:bp:${conversationId}`.
Call `backplane.close()` on shutdown to close the connection it opened.

## Routing

A fleet needs sticky-by-`conversationId` ingress so a conversation's connections
land on its owner node (the backplane is a fallback for the re-home window, not the
steady-state path). `conversationId` travels in the WebSocket query string so an
edge proxy can hash on it without parsing frames. See
[`docs/SCALING.md`](https://github.com/AimTune/mekik/blob/main/docs/SCALING.md).

MIT
