// The Converger transport for mekik (PROTOCOL.md "Running behind a hub"). Like
// `@mekik/ws` it only speaks sockets — all protocol logic stays in the engine —
// but it dials OUT: one WebSocket from this process to Converger's channel-scoped
// agent socket, every conversation multiplexed on it as `{conversationId, frame}`.
// Each conversation becomes one virtual `Connection`, driven through the same
// `app.connect` / `app.receive` / `app.disconnect` calls `@mekik/ws` makes.
//
//   import { mekik, externalTranscript } from "@mekik/core";
//   import { connectConverger } from "@mekik/converger";
//   const app = mekik({ graph, ...externalTranscript() });
//   connectConverger(app, { url: "wss://hub.example/socket/converger/v1", secret: process.env.CHANNEL_SECRET });

import { randomBytes } from "node:crypto";

import { WebSocket } from "ws";

import { ExternalTranscriptHistoryStore, isPersistent } from "@mekik/core";
import type { Connection, ExternalTranscript, MekikApp, OutgoingFrame } from "@mekik/core";

/** Converger's protocol id, sent in `hello`. */
export const CONVERGER_PROTOCOL = "converger/1";

export interface ConvergerOptions {
    /** The native endpoint, e.g. `wss://hub.example/socket/converger/v1`. */
    url: string;
    /**
     * A channel-scoped token (`scope: "channel"`), or a function returning a fresh
     * one. A function (or `secret`) is called on every (re)connect and before the
     * token expires; a fixed string cannot be renewed, so the transport stops when
     * Converger rejects it (close 4401).
     */
    token?: string | (() => string | Promise<string>);
    /** The bot channel's secret: tokens are minted with `POST {apiUrl}/api/v1/converger/tokens/generate`. */
    secret?: string;
    /** Base URL of Converger's HTTP API for `secret`. Default: `url`'s origin, `ws(s)` → `http(s)`. */
    apiUrl?: string;
    /** `hello.group`: processes sharing a group share the channel's conversations, one serving each. */
    group?: string;
    /**
     * Which of a user turn's `metadata` / `meta` keys (meta wins) reach the engine as
     * the turn's client meta (then `acceptClientMeta`, PROTOCOL.md §6). A key list or
     * a function. Default: none.
     */
    meta?: readonly string[] | ((meta: Record<string, unknown>) => Record<string, unknown> | undefined);
    /** Disconnect a conversation's virtual connection after this long without traffic. Default: 15 minutes. */
    idleMs?: number;
    /** Turns (`text`, `resume`, `genui_event`) running at once across all conversations; the rest queue. Default: unlimited. */
    maxConcurrentTurns?: number;
    /** Conversations whose watermark is remembered for the re-hello after a reconnect. Default: 5000 (Converger's `maxConversations`). */
    maxConversations?: number;
    /** Reconnect backoff bounds (full jitter over an exponential ceiling). Default: 500 ms to 30 s. */
    reconnect?: { minMs?: number; maxMs?: number };
    /** Persistent frames buffered while the socket is down. Default: 10 000. */
    maxBuffered?: number;
    /** Transport problems: a dropped socket, a refused token, a hub error about a conversation. */
    onError?: (err: Error) => void;
    /** Custom fetch for `secret` mode (tests). Default: the global `fetch`. */
    fetch?: typeof fetch;
}

export interface ConvergerHandle {
    /** Resolves on the first `welcome`; rejects if the transport stops before it. */
    readonly ready: Promise<void>;
    /** Whether the socket is open and welcomed. */
    readonly connected: boolean;
    /** Live virtual connections (conversations being served). */
    readonly conversations: number;
    /** Disconnect every conversation and close the socket. */
    close(): Promise<void>;
}

/** Frames an end user sends that only the bot answers, forwarded by Converger unchanged. */
const FORWARDED = new Set(["resume", "genui_event", "client_tools", "client_skills", "abort"]);
/** Inbound frames that start a turn - the ones `maxConcurrentTurns` meters. */
const TURNS = new Set(["text", "resume", "genui_event"]);
/** Typed frames with `from` that are never a user turn. */
const NOT_A_TURN = new Set(["typing", "event", "conversationUpdate"]);

/** Mint a channel-scoped token with the channel secret (Converger client API). */
export async function generateChannelToken(
    apiUrl: string,
    secret: string,
    fetchImpl: typeof fetch = fetch,
): Promise<{ token: string; expiresIn?: number }> {
    const res = await fetchImpl(new URL("/api/v1/converger/tokens/generate", apiUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ scope: "channel" }),
    });
    if (!res.ok) throw new Error(`converger token generation failed: HTTP ${res.status}`);
    const body = (await res.json()) as { token?: unknown; expires_in?: unknown };
    if (typeof body.token !== "string") throw new Error("converger token generation returned no token");
    return { token: body.token, ...(typeof body.expires_in === "number" ? { expiresIn: body.expires_in } : {}) };
}

/** Serve a `MekikApp` behind Converger. The app must use the external-transcript profile. */
export function connectConverger(app: MekikApp, options: ConvergerOptions): ConvergerHandle {
    return new ConvergerTransport(app, options);
}

class VirtualConnection implements Connection {
    readonly id: string;
    private readonly transport: ConvergerTransport;
    private readonly conversationId: string;
    constructor(transport: ConvergerTransport, conversationId: string) {
        this.transport = transport;
        this.conversationId = conversationId;
        this.id = `converger-${randomBytes(8).toString("base64url")}`;
    }
    send(frame: OutgoingFrame): void {
        // `welcome` answers the synthesised hello; Converger has its own handshake.
        if (frame.type === "welcome") return;
        this.transport.emit(this.conversationId, frame);
    }
    close(): void {
        // Only an auth rejection closes a connection; drop this conversation.
        this.transport.evict(this.conversationId);
    }
}

interface Virtual {
    conn: VirtualConnection;
    /** The handshake; every frame is delivered after it. */
    ready: Promise<void>;
    inflight: number;
    timer: ReturnType<typeof setTimeout> | null;
}

class ConvergerTransport implements ConvergerHandle {
    readonly ready: Promise<void>;
    private readonly app: MekikApp;
    private readonly opts: ConvergerOptions;
    private readonly transcript: ExternalTranscript;
    private readonly virtuals = new Map<string, Virtual>();
    /** convId → highest hub seq seen; insertion order is recency (LRU). */
    private readonly watermarks = new Map<string, number>();
    private readonly outbox: string[] = [];
    private readonly turnQueue: Array<() => void> = [];
    private turnsRunning = 0;
    private ws: WebSocket | null = null;
    private welcomed = false;
    private closing = false;
    private attempt = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private resolveReady!: () => void;
    private rejectReady!: (err: Error) => void;
    private readySettled = false;

    constructor(app: MekikApp, opts: ConvergerOptions) {
        if (!(app.history instanceof ExternalTranscriptHistoryStore)) {
            throw new Error("connectConverger needs the external-transcript profile: mekik({ graph, ...externalTranscript() })");
        }
        if (opts.token === undefined && opts.secret === undefined) throw new Error("connectConverger needs `token` or `secret`");
        this.app = app;
        this.opts = opts;
        this.transcript = app.history.transcript;
        this.ready = new Promise<void>((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        this.ready.catch(() => {}); // a caller that never awaits it must not crash the process
        void this.open();
    }

    get connected(): boolean {
        return this.welcomed;
    }

    get conversations(): number {
        return this.virtuals.size;
    }

    async close(): Promise<void> {
        this.closing = true;
        this.stopTimers();
        if (this.retryTimer) clearTimeout(this.retryTimer);
        for (const id of [...this.virtuals.keys()]) this.evict(id);
        this.settleReady(new Error("converger transport closed"));
        const ws = this.ws;
        this.ws = null;
        if (ws && ws.readyState !== ws.CLOSED) {
            await new Promise<void>((resolve) => {
                ws.once("close", () => resolve());
                ws.close(1000, "closing");
                setTimeout(() => {
                    ws.terminate();
                    resolve();
                }, 2000).unref();
            });
        }
    }

    // ── the socket ────────────────────────────────────────────────────────────

    private async open(): Promise<void> {
        if (this.closing) return;
        let token: string;
        try {
            token = await this.token();
        } catch (err) {
            this.report(err);
            this.scheduleReconnect();
            return;
        }
        if (this.closing) return;

        const ws = new WebSocket(this.opts.url, { headers: { authorization: `Bearer ${token}` } });
        this.ws = ws;
        ws.on("open", () => ws.send(JSON.stringify(this.hello())));
        ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => this.onMessage(raw.toString()));
        ws.on("error", (err: Error) => this.report(err));
        ws.on("close", (code: number) => {
            if (this.ws !== ws) return;
            this.ws = null;
            this.welcomed = false;
            this.stopTimers();
            if (this.closing) return;
            // A fixed token Converger refused cannot get better by retrying.
            if (code === 4401 && !this.renewable) {
                const err = new Error("converger refused the token (close 4401); pass `secret` or a token function to renew it");
                this.report(err);
                this.closing = true;
                this.settleReady(err);
                return;
            }
            this.report(new Error(`converger socket closed (${code}); reconnecting`));
            this.scheduleReconnect();
        });
    }

    private scheduleReconnect(): void {
        if (this.closing) return;
        const min = this.opts.reconnect?.minMs ?? 500;
        const max = this.opts.reconnect?.maxMs ?? 30_000;
        const ceiling = Math.min(max, min * 2 ** this.attempt++);
        // Full jitter: a fleet of mekik processes does not reconnect in lockstep.
        const delay = Math.max(min / 2, Math.random() * ceiling);
        this.retryTimer = setTimeout(() => void this.open(), delay);
        this.retryTimer.unref();
    }

    /** A token function or the secret can mint a new token; a fixed string cannot. */
    private get renewable(): boolean {
        return typeof this.opts.token === "function" || this.opts.secret !== undefined;
    }

    private async token(): Promise<string> {
        const t = this.opts.token;
        if (typeof t === "function") return await t();
        if (this.opts.secret !== undefined) {
            const apiUrl = this.opts.apiUrl ?? httpOrigin(this.opts.url);
            return (await generateChannelToken(apiUrl, this.opts.secret, this.opts.fetch ?? fetch)).token;
        }
        return t!;
    }

    /** One bare hello; every conversation still remembered resumes from its watermark. */
    private hello(): Record<string, unknown> {
        return {
            type: "hello",
            protocol: CONVERGER_PROTOCOL,
            ...(this.opts.group !== undefined ? { group: this.opts.group } : {}),
            ...(this.watermarks.size > 0 ? { watermarks: Object.fromEntries(this.watermarks) } : {}),
        };
    }

    private send(text: string): boolean {
        const ws = this.ws;
        if (!ws || !this.welcomed || ws.readyState !== ws.OPEN) return false;
        ws.send(text);
        return true;
    }

    /** A frame the engine produced for one conversation, sent in its envelope. */
    emit(conversationId: string, frame: OutgoingFrame): void {
        const text = JSON.stringify({ conversationId, frame });
        if (this.send(text)) return;
        // Socket down: keep what Converger must store, drop what is live-only
        // (a stale `run{started}` would mislead a UI after the reconnect).
        if (!isPersistent(frame)) return;
        this.outbox.push(text);
        const max = this.opts.maxBuffered ?? 10_000;
        if (this.outbox.length > max) {
            this.outbox.shift();
            this.report(new Error("converger outbox full; dropped the oldest buffered frame"));
        }
    }

    // ── inbound ───────────────────────────────────────────────────────────────

    private onMessage(text: string): void {
        let msg: unknown;
        try {
            msg = JSON.parse(text);
        } catch {
            return;
        }
        if (!isRecord(msg)) return;
        if (typeof msg.type === "string") return this.onConnectionFrame(msg);
        // The envelope has no `type`: that is how it differs from a bare frame.
        if (typeof msg.conversationId === "string" && isRecord(msg.frame)) this.onConversationFrame(msg.conversationId, msg.frame);
    }

    private onConnectionFrame(frame: Record<string, unknown>): void {
        const data = isRecord(frame.data) ? frame.data : {};
        switch (frame.type) {
            case "welcome": {
                this.welcomed = true;
                this.attempt = 0;
                const limits = isRecord(data.limits) ? data.limits : {};
                const idle = typeof limits.idleTimeoutMs === "number" ? limits.idleTimeoutMs : 60_000;
                // Converger closes a silent connection after idleTimeoutMs (4408).
                this.pingTimer = setInterval(() => this.send(JSON.stringify({ type: "ping" })), Math.max(1000, idle / 2));
                this.pingTimer.unref();
                this.scheduleRefresh(data.expiresAt);
                for (const queued of this.outbox.splice(0)) this.send(queued);
                this.settleReady();
                return;
            }
            case "tokenRefreshed":
                this.scheduleRefresh(data.expiresAt);
                return;
            case "error":
                this.report(new Error(`converger: ${String(data.code ?? "error")}: ${String(data.message ?? "")}`));
                return;
        }
    }

    /** Renew the token a minute before it expires (only a token function or a secret can). */
    private scheduleRefresh(expiresAt: unknown): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        if (typeof expiresAt !== "number" || !this.renewable) return;
        const delay = Math.max(1000, expiresAt - Date.now() - 60_000);
        this.refreshTimer = setTimeout(() => {
            this.token().then(
                (token) => void this.send(JSON.stringify({ type: "auth", token })),
                (err) => this.report(err),
            );
        }, delay);
        this.refreshTimer.unref();
    }

    private onConversationFrame(conversationId: string, frame: Record<string, unknown>): void {
        const type = frame.type;
        const seq = typeof frame.seq === "number" && Number.isFinite(frame.seq) ? frame.seq : undefined;
        if (typeof type !== "string") return;

        if (type === "ack") {
            // Our own stored message: it will not come back, but it moves the resume point.
            if (seq !== undefined) this.advance(conversationId, seq);
            return;
        }
        if (type === "error") {
            const data = isRecord(frame.data) ? frame.data : {};
            this.report(new Error(`converger (${conversationId}): ${String(data.code ?? "error")}: ${String(data.message ?? "")}`));
            return;
        }
        if (seq !== undefined) {
            // A replay overlapping what we already handled (a reconnect race).
            if (seq <= (this.watermarks.get(conversationId) ?? 0)) return;
            this.advance(conversationId, seq);
        }

        if (FORWARDED.has(type)) {
            this.deliver(conversationId, frame, undefined);
            return;
        }
        if (frame.from === "user" && !NOT_A_TURN.has(type) && isRecord(frame.data) && typeof frame.data.text === "string") {
            // A user turn of any message type, from any channel, is a mekik/1 text turn.
            const meta = this.turnMeta(frame);
            const turn = { type: "text", data: { text: frame.data.text }, ...(meta !== undefined ? { meta } : {}) };
            this.deliver(conversationId, turn, frame);
        }
        // Everything else (the bot's and agents' frames, receipts, typing, presence) is not mekik's to answer.
    }

    private turnMeta(frame: Record<string, unknown>): Record<string, unknown> | undefined {
        const allow = this.opts.meta;
        if (allow === undefined) return undefined;
        const merged = { ...(isRecord(frame.metadata) ? frame.metadata : {}), ...(isRecord(frame.meta) ? frame.meta : {}) };
        if (typeof allow === "function") return allow(merged);
        const picked: Record<string, unknown> = {};
        for (const key of allow) if (key in merged) picked[key] = merged[key];
        return Object.keys(picked).length > 0 ? picked : undefined;
    }

    private advance(conversationId: string, seq: number): void {
        const prev = this.watermarks.get(conversationId) ?? 0;
        this.watermarks.delete(conversationId); // re-insert: most recent last
        this.watermarks.set(conversationId, Math.max(prev, seq));
        const max = this.opts.maxConversations ?? 5000;
        while (this.watermarks.size > max) {
            const oldest = this.watermarks.keys().next().value;
            if (oldest === undefined || this.virtuals.has(oldest)) break;
            this.watermarks.delete(oldest);
        }
    }

    // ── virtual connections ───────────────────────────────────────────────────

    /** Hand one inner frame to the conversation's virtual connection, connecting it first if needed. */
    private deliver(conversationId: string, inner: Record<string, unknown>, userTurn: Record<string, unknown> | undefined): void {
        let v = this.virtuals.get(conversationId);
        if (!v) v = this.connectVirtual(conversationId, userTurn);
        const virtual = v;
        virtual.inflight++;
        this.disarm(virtual);
        const run = (): Promise<void> => this.app.receive(virtual.conn, inner);
        // Frames of one conversation enter the engine in arrival order, after the
        // handshake; they are not serialised behind each other's runs, so an
        // `abort` reaches a running turn and a second turn draws `busy`.
        virtual.ready
            .then(() => (TURNS.has(String(inner.type)) ? this.metered(run) : run()))
            .catch((err: unknown) => this.report(err))
            .finally(() => {
                virtual.inflight--;
                this.arm(conversationId, virtual);
            });
    }

    private connectVirtual(conversationId: string, userTurn: Record<string, unknown> | undefined): Virtual {
        const sender = userTurn && isRecord(userTurn.sender) ? userTurn.sender : undefined;
        const userId =
            (typeof sender?.id === "string" && sender.id.length > 0 ? sender.id : undefined) ??
            this.transcript.owner(conversationId) ??
            "anonymous";
        // The engine continues the hub's numbering: the turn that brought the
        // conversation in has seq N, so mekik's own (unsent) copy of it is N and
        // its first reply N+1 - exactly what Converger will assign if nothing else
        // is written in between. Only a hint; Converger renumbers on persistence.
        // A conversation first seen through a forwarded frame (a resume after a
        // restart) already has history: at least 1, so it is not greeted again.
        const turnSeq = typeof userTurn?.seq === "number" ? userTurn.seq : undefined;
        const seq = turnSeq !== undefined ? turnSeq - 1 : Math.max(1, this.watermarks.get(conversationId) ?? 0);
        this.transcript.observe(conversationId, { userId, seq });

        const auth: Record<string, unknown> = { userId };
        if (typeof sender?.role === "string") auth.role = sender.role;
        if (typeof sender?.name === "string") auth.name = sender.name;
        const conn = new VirtualConnection(this, conversationId);
        // Registered before connecting, so a refusal (conn.close) finds it to evict.
        const v: Virtual = { conn, ready: Promise.resolve(), inflight: 0, timer: null };
        this.virtuals.set(conversationId, v);
        v.ready = this.app.connect(conn, {
            hello: { userId, conversationId, watermark: seq, meta: { auth } },
            credential: { meta: { auth } },
        });
        return v;
    }

    /** Disconnect a conversation's virtual connection (idle, auth refusal, close). */
    evict(conversationId: string): void {
        const v = this.virtuals.get(conversationId);
        if (!v) return;
        this.virtuals.delete(conversationId);
        this.disarm(v);
        this.transcript.forget(conversationId);
        void v.ready.then(
            () => this.app.disconnect(v.conn),
            () => this.app.disconnect(v.conn),
        );
    }

    private arm(conversationId: string, v: Virtual): void {
        this.disarm(v);
        if (v.inflight > 0 || this.virtuals.get(conversationId) !== v) return;
        v.timer = setTimeout(() => {
            v.timer = null;
            if (v.inflight === 0) this.evict(conversationId);
        }, this.opts.idleMs ?? 15 * 60_000);
        v.timer.unref();
    }

    private disarm(v: Virtual): void {
        if (v.timer) clearTimeout(v.timer);
        v.timer = null;
    }

    /** Run a turn under `maxConcurrentTurns`; the rest wait their turn in arrival order. */
    private async metered(run: () => Promise<void>): Promise<void> {
        const max = this.opts.maxConcurrentTurns ?? Infinity;
        // A finishing turn hands its slot straight to the next waiter, so a newcomer
        // can never slip in between and exceed the limit.
        if (this.turnsRunning >= max) await new Promise<void>((resolve) => this.turnQueue.push(resolve));
        else this.turnsRunning++;
        try {
            await run();
        } finally {
            const next = this.turnQueue.shift();
            if (next) next();
            else this.turnsRunning--;
        }
    }

    // ── plumbing ──────────────────────────────────────────────────────────────

    private stopTimers(): void {
        if (this.pingTimer) clearInterval(this.pingTimer);
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.pingTimer = null;
        this.refreshTimer = null;
    }

    private settleReady(err?: Error): void {
        if (this.readySettled) return;
        this.readySettled = true;
        if (err) this.rejectReady(err);
        else this.resolveReady();
    }

    private report(err: unknown): void {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
}

/** `wss://host/socket/...` → `https://host`. */
function httpOrigin(url: string): string {
    const u = new URL(url);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    return u.origin;
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
