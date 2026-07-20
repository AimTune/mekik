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

Identity may arrive in the URL query string or the first `hello` frame; both are
merged at connect. Returns a handle so a test or process can shut the server down.

MIT
