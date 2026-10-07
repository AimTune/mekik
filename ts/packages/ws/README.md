# @mekik/ws

WebSocket transport for [mekik](https://github.com/AimTune/mekik) — serves a
`MekikApp` over the `mekik/1` wire protocol. A thin adapter over `ws`: every
protocol rule lives in the engine, this package only speaks sockets.

```ts
import { mekik } from "@mekik/core";
import { serveWs } from "@mekik/ws";

const app = mekik({ graph });
serveWs(app, { port: 8800, path: "/ws" }); // omit `path` to accept any path
```

Options: `port`, `path` (omit to accept any path), and `server` to attach to an
existing `http.Server` instead of creating one. Returns a handle —
`{ server, wss, close() }` — so a test or process can shut the server down.

The handshake runs on a socket's first frame (normally `hello`). Identity may
arrive in the URL query string or that `hello` frame; both are merged, the frame
winning on conflict, and each field is taken only in its declared type. An
`Authorization: Bearer` header also supplies the token. Frames on one socket are
handled in order, after the handshake, and a close never overtakes it.

Docs: https://mekik.aimtune.dev/serving/transport

MIT
