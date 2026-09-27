// The A2A HTTP transport for mekik (PROTOCOL.md §14). A thin adapter: it serves
// the Agent Card on GET and hands one JSON-RPC message per POST to
// `MekikA2aServer.handle`. All protocol logic lives in @mekik/core.
//
//   import { mekik, MekikA2aServer } from "@mekik/core";
//   import { serveA2a } from "@mekik/a2a";
//   const app = mekik({ graph });
//   const agent = new MekikA2aServer(app, { name: "Support desk", url: "http://localhost:8901/a2a" });
//   serveA2a(agent, { port: 8901 });   // card at /.well-known/agent-card.json, JSON-RPC at /a2a

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { MekikA2aServer } from "@mekik/core";

export interface ServeA2aOptions {
    /** Port to listen on. Ignored when `server` is supplied. */
    port?: number;
    /** The JSON-RPC endpoint path. Default `/a2a`. */
    path?: string;
    /** Where the Agent Card is served. Default `/.well-known/agent-card.json`. */
    cardPath?: string;
    /** Attach to an existing HTTP server instead of creating one. */
    server?: Server;
    /** Largest request body accepted, in bytes. Default 1 MiB. */
    maxBodyBytes?: number;
}

export interface ServeA2aHandle {
    readonly server: Server;
    close(): Promise<void>;
}

/** The default Agent Card path (A2A 0.3). */
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

/**
 * The request handler behind {@link serveA2a}, for mounting on an existing
 * server or framework. `GET` on the card path returns the Agent Card; `POST`
 * on the endpoint carries one JSON-RPC message and gets its response (`202`
 * for a notification, `400` for unparseable JSON, `413` over the body cap).
 */
export function a2aRequestHandler(
    agent: MekikA2aServer,
    options: { path?: string; cardPath?: string; maxBodyBytes?: number } = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
    const path = options.path ?? "/a2a";
    const cardPath = options.cardPath ?? AGENT_CARD_PATH;
    const maxBody = options.maxBodyBytes ?? 1024 * 1024;
    return async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === cardPath) {
            if (req.method !== "GET") {
                res.writeHead(405, { Allow: "GET" }).end();
                return true;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(agent.agentCard()));
            return true;
        }
        if (url.pathname !== path) return false;
        if (req.method !== "POST") {
            res.writeHead(405, { Allow: "POST" }).end();
            return true;
        }
        let body: string;
        try {
            body = await readBody(req, maxBody);
        } catch (err) {
            res.writeHead(err instanceof BodyTooLarge ? 413 : 400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: err instanceof Error ? err.message : String(err) } }));
            return true;
        }
        let message: unknown;
        try {
            message = JSON.parse(body);
        } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
            return true;
        }
        const response = await agent.handle(message);
        if (response === null) {
            res.writeHead(202).end();
            return true;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        return true;
    };
}

/** Serve a `MekikA2aServer` over HTTP. Returns a handle so a test/process can shut it down. */
export function serveA2a(agent: MekikA2aServer, options: ServeA2aOptions = {}): ServeA2aHandle {
    const handler = a2aRequestHandler(agent, options);
    const server = options.server ?? createServer();

    server.on("request", (req, res) => {
        void handler(req, res)
            .then((handled) => {
                if (!handled && options.server === undefined) res.writeHead(404).end();
            })
            .catch((err) => {
                if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }));
            });
    });

    if (options.server === undefined && options.port !== undefined) server.listen(options.port);

    return {
        server,
        close: () =>
            new Promise<void>((resolve) => {
                if (options.server === undefined) server.close(() => resolve());
                else resolve();
            }),
    };
}

class BodyTooLarge extends Error {
    constructor() {
        super("request body too large");
    }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        req.on("data", (chunk: Buffer) => {
            if (tooLarge) return;
            size += chunk.length;
            if (size > maxBytes) {
                tooLarge = true;
                chunks.length = 0;
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => (tooLarge ? reject(new BodyTooLarge()) : resolve(Buffer.concat(chunks).toString("utf8"))));
        req.on("error", reject);
    });
}
