// The WebSocket transport for mekik (PROTOCOL.md §2). A thin adapter: it turns
// each socket into a `Connection` and forwards frames to a `MekikApp`. All the
// protocol logic lives in the engine — this file only speaks `ws`.
//
//   import { mekik } from "@mekik/core";
//   import { serveWs } from "@mekik/ws";
//   const app = mekik({ graph });
//   serveWs(app, { port: 8800, path: "/ws" });

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import type { MekikApp } from "@mekik/core";
import type { Connection, ConnectParams } from "@mekik/core";
import type { OutgoingFrame } from "@mekik/core";

export interface ServeWsOptions {
    /** Port to listen on. Ignored when `server` is supplied. */
    port?: number;
    /** Only accept upgrades on this path (e.g. `/ws`). Omit to accept any path. */
    path?: string;
    /** Attach to an existing HTTP server instead of creating one. */
    server?: Server;
}

export interface ServeWsHandle {
    readonly server: Server;
    readonly wss: WebSocketServer;
    /** Close the server and every live socket. */
    close(): Promise<void>;
}

class WsConnection implements Connection {
    readonly id: string;
    private readonly ws: WebSocket;
    constructor(ws: WebSocket) {
        this.ws = ws;
        this.id = `connection-${randomBytes(8).toString("base64url")}`;
    }
    send(frame: OutgoingFrame): void {
        if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(frame));
    }
    close(code?: number, reason?: string): void {
        // 4401 is our auth-reject code; ws requires codes be 1000/1002-1014 or 3000-4999.
        this.ws.close(code, reason);
    }
}

/** Serve a `MekikApp` over WebSocket. Returns a handle so a test/process can shut it down. */
export function serveWs(app: MekikApp, options: ServeWsOptions = {}): ServeWsHandle {
    const server = options.server ?? createServer();
    const wss = new WebSocketServer(options.path !== undefined ? { server, path: options.path } : { server });

    wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
        const conn = new WsConnection(ws);

        // Serialize per-socket: the handshake (app.connect) must finish before any
        // frame is delivered, and frames must stay in order.
        let chain: Promise<void> = Promise.resolve();
        let connected = false;

        ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
            const text = raw.toString();
            chain = chain.then(async () => {
                if (!connected) {
                    connected = true;
                    await app.connect(conn, mergeConnectParams(req, text));
                    // A non-hello first frame (identity came via query string) still
                    // needs processing after the handshake.
                    if (!isHelloFrame(text)) await app.receive(conn, text);
                    return;
                }
                await app.receive(conn, text);
            }).catch((err) => reportError(ws, err));
        });

        ws.on("close", () => {
            // If the socket closed before its first frame, there is nothing to
            // disconnect — connect was never called.
            if (connected) app.disconnect(conn);
        });

        ws.on("error", () => {
            if (connected) app.disconnect(conn);
        });
    });

    if (options.server === undefined && options.port !== undefined) server.listen(options.port);

    return {
        server,
        wss,
        close: () =>
            new Promise<void>((resolve) => {
                for (const client of wss.clients) client.terminate();
                wss.close(() => {
                    if (options.server === undefined) server.close(() => resolve());
                    else resolve();
                });
            }),
    };
}

/** Identity may travel in the URL query string OR the first `hello` frame; merge, frame wins. */
function mergeConnectParams(req: IncomingMessage, firstFrame: string): ConnectParams {
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = url.searchParams;

    const hello: NonNullable<ConnectParams["hello"]> = {};
    const userId = q.get("userId");
    const conversationId = q.get("conversationId");
    const watermark = q.get("watermark");
    const token = q.get("token");
    if (userId) hello.userId = userId;
    if (conversationId) hello.conversationId = conversationId;
    if (watermark !== null && watermark !== "") hello.watermark = Number(watermark);
    if (token) hello.token = token;

    if (isHelloFrame(firstFrame)) {
        const parsed = safeParse(firstFrame) as Partial<NonNullable<ConnectParams["hello"]>> | null;
        if (parsed) {
            if (parsed.userId) hello.userId = parsed.userId;
            if (parsed.conversationId) hello.conversationId = parsed.conversationId;
            if (typeof parsed.watermark === "number") hello.watermark = parsed.watermark;
            if (parsed.token) hello.token = parsed.token;
            if (parsed.meta) hello.meta = parsed.meta;
        }
    }

    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (bearer && !hello.token) hello.token = bearer;

    return {
        hello,
        credential: {
            ...(hello.token !== undefined ? { token: hello.token } : {}),
            headers: flattenHeaders(req.headers),
            query: Object.fromEntries(q.entries()),
        },
    };
}

function isHelloFrame(text: string): boolean {
    const parsed = safeParse(text);
    return typeof parsed === "object" && parsed !== null && (parsed as { type?: unknown }).type === "hello";
}

function safeParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function flattenHeaders(headers: IncomingMessage["headers"]): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(headers)) out[k] = Array.isArray(v) ? v.join(", ") : v;
    return out;
}

function reportError(ws: WebSocket, err: unknown): void {
    // A handler that throws must not take the socket down silently; surface it as
    // an error frame if we still can.
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "error", data: { code: "internal", message: err instanceof Error ? err.message : String(err) } }));
    }
}
