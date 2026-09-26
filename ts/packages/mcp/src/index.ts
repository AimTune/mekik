// The MCP Streamable HTTP transport for mekik (PROTOCOL.md §13). A thin adapter:
// it reads one JSON-RPC message per POST, hands it to `MekikMcpServer.handle`,
// and writes the response. All protocol logic lives in @mekik/core.
//
//   import { mekik, MekikMcpServer } from "@mekik/core";
//   import { serveMcp } from "@mekik/mcp";
//   const app = mekik({ graph });
//   serveMcp(new MekikMcpServer(app, { name: "support_desk" }), { port: 8900, path: "/mcp" });

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { MekikMcpServer } from "@mekik/core";

export interface ServeMcpOptions {
    /** Port to listen on. Ignored when `server` is supplied. */
    port?: number;
    /** Only handle this path (e.g. `/mcp`). Default `/mcp`. */
    path?: string;
    /** Attach to an existing HTTP server instead of creating one. */
    server?: Server;
    /** Largest request body accepted, in bytes. Default 1 MiB. */
    maxBodyBytes?: number;
}

export interface ServeMcpHandle {
    readonly server: Server;
    close(): Promise<void>;
}

/**
 * The request handler behind {@link serveMcp}, for mounting on an existing
 * server or framework: `POST` carries one JSON-RPC message and gets its
 * response (or `202` for a notification); `GET` is `405` — this transport does
 * not open a server-to-client stream; `DELETE` ends a (stateless) session with
 * `200`. Anything else is `405`.
 */
export function mcpRequestHandler(mcp: MekikMcpServer, options: { maxBodyBytes?: number } = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    const maxBody = options.maxBodyBytes ?? 1024 * 1024;
    return async (req, res) => {
        if (req.method === "DELETE") {
            res.writeHead(200).end();
            return;
        }
        if (req.method !== "POST") {
            res.writeHead(405, { Allow: "POST, DELETE" }).end();
            return;
        }
        let body: string;
        try {
            body = await readBody(req, maxBody);
        } catch (err) {
            res.writeHead(err instanceof BodyTooLarge ? 413 : 400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: err instanceof Error ? err.message : String(err) } }));
            return;
        }
        let message: unknown;
        try {
            message = JSON.parse(body);
        } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
            return;
        }
        const response = await mcp.handle(message);
        if (response === null) {
            res.writeHead(202).end();
            return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
    };
}

/** Serve a `MekikMcpServer` over Streamable HTTP. Returns a handle so a test/process can shut it down. */
export function serveMcp(mcp: MekikMcpServer, options: ServeMcpOptions = {}): ServeMcpHandle {
    const path = options.path ?? "/mcp";
    const handler = mcpRequestHandler(mcp, options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {});
    const server = options.server ?? createServer();

    server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== path) {
            if (options.server === undefined) res.writeHead(404).end();
            return; // on a shared server, other routes belong to their owner
        }
        void handler(req, res).catch((err) => {
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
            if (tooLarge) return; // keep draining so the 413 can be written on an open socket
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
