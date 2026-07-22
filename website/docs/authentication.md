---
sidebar_position: 7
title: Authentication
description: Opt-in, connect-time authentication — the Authenticator port, credential channels, the verified-userId anti-spoofing rule, and how claims reach a node via ctx.meta.auth.
---

# Authentication

Authentication in mekik is **opt-in** and **connect-time only**. By default every connection is accepted and identity is client-asserted. Configure an `Authenticator` and connect requires a valid credential — and a verified identity overrides whatever the client claimed. This page is that model.

> **Scope, up front.** v1 auth is connect-time only: no mid-session refresh, no token expiry handling on the server, no RBAC. It decides *who may open a socket*, and nothing more. Authorization beyond that is your graph's job.

## The port

An `Authenticator` is a one-method port:

```ts
interface Authenticator {
  authenticate(credential: Credential): Promise<AuthVerdict> | AuthVerdict;
}

interface Credential {
  token?: string;                                  // from hello.token, ?token=, or Bearer header
  headers?: Record<string, string | undefined>;    // raw connect headers (for a cookie/session check)
  query?: Record<string, string | undefined>;      // raw connect query params
}

interface AuthVerdict {
  ok: boolean;
  userId?: string;                                 // the authoritative id — overrides the asserted one
  claims?: Record<string, unknown>;                // surfaced to nodes at ctx.meta.auth
  reason?: string;                                 // human-readable rejection reason
}
```

Enable it on the app:

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
const app = mekik({ graph, authenticator: myAuthenticator });
```

The port is `Authenticator` with an `authenticate(credential)` method returning an `AuthVerdict`.

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
var app = new MekikApp(new MekikOptions { Graph = graph, Authenticator = myAuthenticator });
```

The port is `IAuthenticator` with an `AuthenticateAsync(credential, ct)` method returning the same verdict shape.

</TabItem>
</Tabs>

## Where the credential comes from

The [transport](./serving/transport.md) assembles the `Credential` from whatever channel carried it:

| Channel | Fills | Typical use |
|---|---|---|
| `hello.token` | `credential.token` | a client that sends a token in the handshake frame |
| `?token=` query param | `credential.token` + `credential.query` | a proxy/gateway authenticating at the HTTP upgrade |
| `Authorization: Bearer` header | `credential.token` | a non-browser client (browsers can't set WS headers) |
| a cookie | `credential.headers` | a same-site browser app (`HttpOnly` session cookie) |

Your `Authenticator` reads whichever it expects. A JWT authenticator verifies `credential.token`; a session authenticator reads the cookie out of `credential.headers`.

## The verified-userId rule (anti-spoofing)

The single most important rule:

> When an `Authenticator` returns `ok:true` with a `userId`, that id is **authoritative** and overrides any `userId` the client asserted in `hello`.

A client can *claim* to be `userId: "admin"` in its `hello`. If the authenticator verifies the token and says the user is actually `u-7`, the connection is `u-7` — the asserted `admin` is discarded. A valid token cannot be used to impersonate another user. Read the verified id back from `welcome`:

```ts
await connector.connect();
connector.identity?.userId; // the id the server verified, not necessarily the one asserted
```

## Rejection

When `authenticate` returns `ok:false`, the engine sends an `error` frame and closes the socket:

```jsonc
{ "type": "error", "data": { "code": "unauthorized", "message": "invalid token" } }
```

followed by WebSocket close code **4401** (`AUTH_CLOSE_CODE`). A client should treat 4401 as terminal for this credential — reconnecting with the same rejected token can't change the verdict. An auth rejection is **not** a chat message; it never lands in the transcript.

## Claims reach the node

On success, the verdict's `claims` are placed at `ctx.meta.auth`, so a node reads verified, server-side facts without the graph knowing anything about auth:

```ts
.node("desk", async (state, ctx) => {
  const claims = ctx.meta.auth as { role?: string; tenant?: string } | undefined;
  if (claims?.role !== "admin") return { reply: "Not authorized for that." };
  // …
})
```

`claims` stay server-side — they are *not* sent to the client. They're the trusted context your graph branches on. See [Concepts → Graph context](./concepts.md#7-graph-context-as-a-parameter).

## A minimal authenticator

For tests and simple deployments, `StaticTokenAuthenticator` is a fixed `token → {userId, claims}` table:

```ts
import { mekik, StaticTokenAuthenticator } from "@mekik/core";

const app = mekik({
  graph,
  authenticator: new StaticTokenAuthenticator({
    "tok-alice": { userId: "u-alice", claims: { role: "admin" } },
    "tok-bob":   { userId: "u-bob",   claims: { role: "user" } },
  }),
});
```

A real one verifies a JWT signature or a session cookie:

```ts
const jwtAuth: Authenticator = {
  async authenticate(cred) {
    if (!cred.token) return { ok: false, reason: "no token presented" };
    try {
      const payload = await verifyJwt(cred.token, secret);
      return { ok: true, userId: payload.sub, claims: { role: payload.role } };
    } catch {
      return { ok: false, reason: "invalid token" };
    }
  },
};
```

## Pairing with the client

The chativa connector presents credentials through its own `MekikAuthProvider` adapters — `CookieAuth`, `TokenAuth`, or a custom one — which decide *what* the client sends, while your `Authenticator` decides *whether* to accept it. The two are mirror ports:

| chativa adapter (client) | mekik authenticator (server) | credential |
|---|---|---|
| `CookieAuth` | a cookie/session `Authenticator` | the browser's cookie — nothing to send |
| `TokenAuth` (string) | a static-token `Authenticator` | a long-lived API key |
| `TokenAuth` (function) | a JWT `Authenticator` | a short-lived JWT, re-minted per attempt |
| your own `MekikAuthProvider` | your own `Authenticator` | anything |

See chativa's [MekikConnector → Authentication](https://github.com/AimTune/chativa/blob/main/docs/connectors/mekik.md#authentication) for the client side.

## Where to go next

- [**Transport**](./serving/transport.md) — how the credential is assembled from the socket.
- [**Protocol → Identity & resume**](./protocol/identity.md) — how a verified `userId` interacts with the four-id model.
- [**Concepts → Graph context**](./concepts.md#7-graph-context-as-a-parameter) — `ctx.meta.auth` alongside `meta.mekik` and `meta.client`.
