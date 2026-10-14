// A fake Converger: the channel-scoped side of the native endpoint
// (/socket/converger/v1, Converger protocol v1 section 10), just enough of it to
// drive the transport. Bare `hello` → channel `welcome`; every conversation frame
// is `{conversationId, frame}`; persistent frames get the hub's own seq; a message
// with an `id` is acked.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";

import { isPersistent, type OutgoingFrame } from "@mekik/core";

export interface Envelope {
    conversationId: string;
    frame: Record<string, unknown>;
}

export class FakeHub {
    readonly server: Server;
    readonly wss: WebSocketServer;
    /** Every `hello` the hub got, with the bearer it came with. */
    readonly hellos: Array<{ frame: Record<string, unknown>; bearer: string | undefined }> = [];
    /** Every conversation frame the hub got, in order. */
    readonly received: Envelope[] = [];
    /** Every bare frame other than hello (ping, auth). */
    readonly bare: Array<Record<string, unknown>> = [];
    readonly sockets: WebSocket[] = [];
    /** Close every new socket with this code right after its hello (auth refusal tests). */
    refuseWith: number | null = null;
    expiresAt = Date.now() + 1_800_000;
    private readonly seqs = new Map<string, number>();
    private acks = 0;

    private constructor() {
        this.server = createServer();
        this.wss = new WebSocketServer({ server: this.server });
        this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => this.accept(ws, req));
    }

    static async start(): Promise<FakeHub> {
        const hub = new FakeHub();
        await new Promise<void>((resolve) => hub.server.listen(0, "127.0.0.1", resolve));
        return hub;
    }

    get url(): string {
        return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/socket/converger/v1`;
    }

    /** The conversation frames received for one conversation, unwrapped. */
    framesOf(conversationId: string): Array<Record<string, unknown>> {
        return this.received.filter((e) => e.conversationId === conversationId).map((e) => e.frame);
    }

    /** Deliver a user turn the way Converger does: stored first (a seq), then enveloped. */
    userTurn(conversationId: string, text: string, extra: Record<string, unknown> = {}): number {
        const seq = this.nextSeq(conversationId);
        this.push({
            conversationId,
            frame: {
                type: "text",
                id: `act-${conversationId}-${seq}`,
                seq,
                from: "user",
                sender: { id: "alice", role: "user" },
                data: { text },
                timestamp: 1750000000000,
                ...extra,
            },
        });
        return seq;
    }

    /** Forward an end user's bot-only frame (resume, abort, ...) unchanged. */
    forward(conversationId: string, frame: Record<string, unknown>): void {
        this.push({ conversationId, frame });
    }

    /** Send any envelope (or bare frame) to every live socket. */
    push(message: unknown): void {
        for (const ws of this.sockets) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    }

    /** Drop every connection abruptly (a network blip). */
    drop(): void {
        for (const ws of this.sockets.splice(0)) ws.terminate();
    }

    async waitFor(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
        const start = Date.now();
        while (!cond()) {
            if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
            await new Promise((r) => setTimeout(r, 5));
        }
    }

    close(): Promise<void> {
        for (const ws of this.sockets.splice(0)) ws.terminate();
        return new Promise((resolve) => this.wss.close(() => this.server.close(() => resolve())));
    }

    private nextSeq(conversationId: string): number {
        const seq = (this.seqs.get(conversationId) ?? 0) + 1;
        this.seqs.set(conversationId, seq);
        return seq;
    }

    private accept(ws: WebSocket, req: IncomingMessage): void {
        this.sockets.push(ws);
        const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
        ws.on("message", (raw: Buffer) => {
            const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
            if (msg.type === "hello") {
                this.hellos.push({ frame: msg, bearer });
                if (this.refuseWith !== null) {
                    ws.send(JSON.stringify({ type: "error", data: { code: "unauthorized", message: "invalid token" } }));
                    ws.close(this.refuseWith, "unauthorized");
                    return;
                }
                ws.send(
                    JSON.stringify({
                        type: "welcome",
                        data: {
                            protocol: "converger/1",
                            compat: ["mekik/1"],
                            scope: "channel",
                            channelId: "ch-bot",
                            connectionId: `hub-${this.hellos.length}`,
                            expiresAt: this.expiresAt,
                            limits: { idleTimeoutMs: 60000, maxConversations: 5000 },
                        },
                    }),
                );
                return;
            }
            if (typeof msg.type === "string") {
                this.bare.push(msg);
                if (msg.type === "ping") ws.send(JSON.stringify({ type: "heartbeat", timestamp: Date.now() }));
                if (msg.type === "auth") ws.send(JSON.stringify({ type: "tokenRefreshed", data: { expiresAt: this.expiresAt } }));
                return;
            }
            const env = msg as unknown as Envelope;
            this.received.push(env);
            if (isPersistent(env.frame as unknown as OutgoingFrame)) {
                const seq = this.nextSeq(env.conversationId);
                if (typeof env.frame.id === "string" && "from" in env.frame) {
                    ws.send(
                        JSON.stringify({
                            conversationId: env.conversationId,
                            frame: { type: "ack", clientId: env.frame.id, id: `act-${++this.acks}`, seq, timestamp: Date.now() },
                        }),
                    );
                }
            }
        });
    }
}
