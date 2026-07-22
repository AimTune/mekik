# Horizontal scale, the mekik way

v1 ships in-memory stores and a process-local turn lock — one node serves every
conversation. This document is the model for running mekik as a **fleet**: N
nodes behind a load balancer, a Redis backplane, and an autoscaler that adds and
removes nodes under load. It is a design contract, not a promise that the code
already does all of this — the ports named here exist (or are scaffolded); the
Redis implementations are the follow-up workstream.

The guiding idea: **a conversation is the unit of consistency.** On one node
that is trivially true — everything about a conversation lives in a single
`Live` object ([`engine.ts`](../ts/packages/core/src/engine.ts)):

```ts
interface Live {
    seq: number;                          // the monotonic persistent-frame counter
    connections: Map<string, ConnState>;  // every tab on this conversation
    turn: AbortController | null;          // the turn lock — single writer
}
```

Scaling horizontally means preserving that single-writer invariant across nodes.

## What is process-local today

Five things live in node memory and must get a fleet story:

| State | Where | What breaks when spread across nodes |
| --- | --- | --- |
| `live.turn` (turn lock) | `handleText` / `handleResume` | Two nodes run a turn for the same conversation at once → duplicate LLM run, interleaved frames |
| `live.seq` counter | `ensureLive` (seeded from `history.currentSeq`) | seq collisions, out-of-order transcript |
| `live.connections` fan-out | `dispatch` | Two tabs of one user on different nodes never see each other |
| ilmek `Checkpointer` | `MekikApp` ctor (default in-memory) | Parked interrupts lost on restart / invisible to the re-homing node |
| `HistoryStore` / `ConversationStore` | `stores.ts` | Reconnect replay and ownership don't survive a node move |

The last two are already **ports** — Redis backends drop in without touching the
engine. The first three need the model below.

## Two architectures, and why we pick the hybrid

### A — Conversation affinity (owner node)

Route every connection for conversation `C` to one owner node. `Live` for `C`
exists only there, so the turn lock, seq, and fan-out stay exactly as coded —
**zero engine changes on the hot path.** Redis is used only for the durable
ports plus a lightweight ownership lease.

- **Pros:** lowest latency (no per-frame network hop), fan-out stays in-memory,
  the correctness-critical turn lock stays a local `AbortController`.
- **Cons:** the router must pin by `conversationId` (not by client IP); scale-in
  re-homes conversations (a reconnect wave); a single conversation can't be split
  across nodes (fine — one conversation is inherently serial).

### B — Shared backplane (no affinity)

Any connection on any node. Redis becomes the source of truth for the
per-conversation runtime: the turn lock is a distributed lock (`SET NX PX` +
heartbeat, because a turn can run for many seconds while the model streams), seq
is a Redis `INCR`, and fan-out is Redis Pub/Sub.

- **Pros:** the load balancer can route anywhere; scale-in just drops sockets and
  clients reconnect wherever they land.
- **Cons:** **every frame crosses Redis** (latency + Redis is the ordering
  authority and a throughput bottleneck); the cross-network turn lock is the
  hardest correctness surface (lease renewal during long runs, split-brain if
  Redis blips).

### The choice: hybrid, affinity-first

mekik's engine already encodes "one conversation = one single-writer `Live`," so
**affinity (A) is the natural fit and the default hot path.** The backplane (B)
is kept only as a **fallback for the window where affinity is momentarily
violated** — e.g. a tab reconnects to node B before node A's ownership lease has
expired. In that window B subscribes to `C`'s backplane channel so the user's
tabs stay coherent; it does **not** route steady-state traffic through Redis.

```
                 ┌─────────────── LB / ingress ───────────────┐
                 │  hash(conversationId) → owner node (HRW)    │
                 └──────────┬───────────────────┬──────────────┘
                            │                    │
                      ┌─────▼─────┐        ┌─────▼─────┐
     tab A ──────────▶│  node 1   │        │  node 2   │◀────────── tab B
     (conv C)         │ Live(C)   │        │ (re-homed │            (conv C,
                      │ turn lock │        │  window)  │             raced)
                      │ seq, fan  │        └─────┬─────┘
                      └─────┬─────┘              │
                            │  publish(C, frame) │ subscribe(C)  ← fallback only
                            └──────────┬─────────┘
                                       │
                    ┌──────────────────▼───────────────────┐
                    │  Redis: history, conversations,       │
                    │  ilmek checkpointer, ownership lease   │
                    └──────────────────────────────────────┘
```

## The ports

Same philosophy as the existing stores: an interface with an in-memory default,
so single-node runs need no Redis and the fleet swaps implementations in.

1. **`HistoryStore` → `RedisHistoryStore`** — already a port. A Redis Stream or a
   sorted set keyed by `seq` per conversation.
2. **`ConversationStore` → `RedisConversationStore`** — already a port. A hash
   per conversation.
3. **ilmek `Checkpointer` → durable** — this is ilmek's port, not mekik's, but a
   fleet **must** swap the default `InMemoryCheckpointer`, or a re-homing node
   can't see parked interrupts.
4. **`TurnLock` (new)** — `acquire / renew / release` a per-conversation lease.
   - In-memory default: today's behavior — the lock is just `live.turn`, one
     process, no lease.
   - Redis default: `SET lock:{C} {token} NX PX {ttl}`, renewed by a heartbeat
     while the run streams, released with a token-checked Lua script. TTL must
     exceed a turn's worst case, and a crashed owner's lock must expire so the
     next turn can proceed elsewhere.
5. **`Backplane` (new)** — `publish(convId, frame)` / `subscribe(convId, handler)`.
   - In-memory default: no-op — single node fans out directly.
   - Redis default: Pub/Sub. `dispatch` fans out to local sockets **and**
     publishes; a message arriving from the backplane fans out to local sockets
     **only** (no re-record, no re-publish — the producing node already recorded
     it once).

## The correctness heart: safe re-home

`ensureLive` re-seeds `seq` from `history.currentSeq()` when a node first sees a
conversation ([`engine.ts`](../ts/packages/core/src/engine.ts)). That is only
safe if the **previous owner has flushed every `record()` before the new owner
reads `currentSeq()`.** Otherwise the new owner seeds a stale seq and collides.

Affinity + the ownership lease closes this: the new owner cannot `acquire` until
the old lease is released or expires, and the old owner flushes its transcript on
drain before releasing. **Plain Pub/Sub does not close it** — which is the second
reason the hybrid keeps affinity as the primary and the backplane as a fallback,
not the main path.

An interrupted turn is safe to retry because `mekik.tool` journals side effects
for exactly-once across resume — the same mechanism HITL relies on. So a turn cut
off by a re-home is either resumed from the durable checkpoint by the new owner or
re-sent by the client; neither double-fires a side effect.

## Autoscaling — not stateless HTTP

WebSocket + LLM serving breaks the usual autoscaling assumptions.

- **Metric, not CPU.** LLM turns are I/O-bound — the node waits on the model, so
  CPU stays low while the box is "full." Scale on **active conversations /
  concurrent WS connections / in-flight-turn depth**, exported as a custom metric.
  KEDA with a Redis or Prometheus scaler on "active conversations" is the clean
  path; a raw HPA on CPU will under-provision badly.
- **Scale-out is easy** — but use **rendezvous (HRW) hashing** so adding a node
  remaps only ~1/N conversations, not the whole ring.
- **Scale-in is the hard part — drain, don't kill:**
  1. Fail readiness so the LB stops sending new connections.
  2. `terminationGracePeriodSeconds` long enough to let in-flight turns finish
     (or abort them — parked interrupts survive in the durable checkpointer).
  3. `preStop` hook: flush the transcript, release ownership leases, then close
     sockets.
  4. Clients reconnect to another node and replay the tail via
     `welcome.watermark` + `history.after`. **Autoscaling leans on mekik's
     existing reconnect mechanism** — it does not work without the durable stores.
- **Routing needs `conversationId` at the edge.** The LB must hash on it without
  parsing frames, so it travels in the query string
  (`?conversationId=…`, see [`@mekik/ws`](../ts/packages/ws/src/index.ts)). The
  ingress hashes that; the ownership lease absorbs the transient during a remap.

## What single-node still gets

None of this changes the smallest useful call. `mekik({ graph })` keeps the
in-memory `TurnLock` and the no-op `Backplane`; the fleet is opt-in by passing
Redis implementations, exactly as `history` and `conversations` are opt-in today.
