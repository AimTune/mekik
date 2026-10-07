// RedisTurnLock and RedisBackplane at their edges, over an in-memory fake that
// records every command: a lease lost to its TTL and then stale-released, the
// self-renewing heartbeat and its loss callback, reference-counted SUBSCRIBE,
// hostile payloads on the channel, connection ownership on close — and two
// real mekik engines fanned out and locked through the Redis ports.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { channel, END, graph, InMemoryCheckpointer, START } from "@ilmek/core";
import {
    InMemoryConversationStore,
    InMemoryHistoryStore,
    mekik,
    type BackplaneMessage,
    type Connection,
    type OutgoingFrame,
} from "@mekik/core";

import { RedisBackplane, RedisTurnLock, type RedisClient } from "../src/index.ts";

// ── a recording fake Redis ────────────────────────────────────────────────────

class Server {
    readonly store = new Map<string, string>();
    readonly commands: string[] = [];
    readonly subscribers = new Set<Conn>();
    /** Simulate the key's TTL lapsing. */
    expire(key: string): void {
        this.store.delete(key);
    }
}

class Conn implements RedisClient {
    readonly channels = new Set<string>();
    readonly listeners = new Set<(c: string, m: string) => void>();
    failEval = false;
    quit_ = false;
    duplicated = 0;
    readonly server: Server;
    constructor(server: Server) {
        this.server = server;
    }

    async set(key: string, value: string, px: "PX", ttl: number, nx: "NX"): Promise<string | null> {
        this.server.commands.push(`SET ${key} ${px} ${ttl} ${nx}`);
        if (this.server.store.has(key)) return null;
        this.server.store.set(key, value);
        return "OK";
    }
    async eval(script: string, _n: number, ...args: (string | number)[]): Promise<unknown> {
        const [key, token] = args as [string, string];
        const op = script.includes("pexpire") ? "PEXPIRE" : "DEL";
        this.server.commands.push(`EVAL ${op} ${key}${op === "PEXPIRE" ? ` ${args[2]}` : ""}`);
        if (this.failEval) throw new Error("connection reset");
        if (this.server.store.get(key) !== token) return 0;
        if (op === "DEL") this.server.store.delete(key);
        return 1;
    }
    async publish(ch: string, message: string): Promise<number> {
        this.server.commands.push(`PUBLISH ${ch}`);
        let n = 0;
        for (const s of this.server.subscribers) if (s.channels.has(ch)) (n++, s.listeners.forEach((l) => l(ch, message)));
        return n;
    }
    async subscribe(...chs: string[]): Promise<unknown> {
        this.server.commands.push(`SUBSCRIBE ${chs.join(" ")}`);
        chs.forEach((c) => this.channels.add(c));
        this.server.subscribers.add(this);
        return chs.length;
    }
    async unsubscribe(...chs: string[]): Promise<unknown> {
        this.server.commands.push(`UNSUBSCRIBE ${chs.join(" ")}`);
        chs.forEach((c) => this.channels.delete(c));
        return chs.length;
    }
    on(_e: "message", l: (c: string, m: string) => void): unknown {
        this.listeners.add(l);
        return this;
    }
    off(_e: "message", l: (c: string, m: string) => void): unknown {
        this.listeners.delete(l);
        return this;
    }
    duplicate(): RedisClient {
        this.duplicated++;
        return new Conn(this.server);
    }
    async quit(): Promise<unknown> {
        this.quit_ = true;
        this.server.subscribers.delete(this);
        return "OK";
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (text: string): BackplaneMessage => ({
    originId: "node-x",
    frame: { type: "text", id: "m", seq: 1, from: "bot", data: { text }, timestamp: 0 } as OutgoingFrame,
});

// ── turn lock ─────────────────────────────────────────────────────────────────

describe("RedisTurnLock edges", () => {
    test("acquire is SET key NX PX ttl under the key prefix; the default TTL is 30s", async () => {
        const server = new Server();
        await new RedisTurnLock(new Conn(server)).acquire("c1").then((l) => l?.release());
        await new RedisTurnLock(new Conn(server), { keyPrefix: "app2", ttlMs: 5000 }).acquire("c1").then((l) => l?.release());
        assert.deepEqual(
            server.commands.filter((c) => c.startsWith("SET")),
            ["SET mekik:lock:c1 PX 30000 NX", "SET app2:lock:c1 PX 5000 NX"],
        );
    });

    test("a lease lost to its TTL cannot release the next holder's lock (token-checked DEL)", async () => {
        const server = new Server();
        const a = new RedisTurnLock(new Conn(server));
        const b = new RedisTurnLock(new Conn(server));
        const leaseA = (await a.acquire("c1"))!;
        server.expire("mekik:lock:c1"); // A stalls past its TTL
        const leaseB = await b.acquire("c1");
        assert.ok(leaseB, "B takes the lapsed turn");

        await leaseA.release(); // A wakes up and releases what it thinks it holds
        assert.equal(await a.acquire("c1"), null, "B's lock survived A's stale release");
        await leaseB!.release();
        assert.ok(await a.acquire("c1"), "B's own release frees it");
    });

    test("release is idempotent: the second call sends nothing", async () => {
        const server = new Server();
        const lease = (await new RedisTurnLock(new Conn(server)).acquire("c1"))!;
        await lease.release();
        await lease.release();
        assert.equal(server.commands.filter((c) => c.startsWith("EVAL DEL")).length, 1);
    });

    test("the lease renews itself on the heartbeat with the full TTL until released", async () => {
        const server = new Server();
        const lease = (await new RedisTurnLock(new Conn(server), { ttlMs: 900, heartbeatMs: 10 }).acquire("c1"))!;
        await sleep(45);
        const renewals = server.commands.filter((c) => c === "EVAL PEXPIRE mekik:lock:c1 900").length;
        assert.ok(renewals >= 2, `renewed ${renewals} times`);
        await lease.release();
        const after = server.commands.length;
        await sleep(30);
        assert.equal(server.commands.length, after, "no heartbeat after release");
    });

    test("a heartbeat that finds the key gone reports the loss via onLost", async () => {
        const server = new Server();
        const lost: string[] = [];
        const lease = (await new RedisTurnLock(new Conn(server), { heartbeatMs: 5, onLost: (id) => lost.push(id) }).acquire("c9"))!;
        server.expire("mekik:lock:c9");
        await sleep(25);
        await lease.release();
        assert.ok(lost.length >= 1);
        assert.ok(lost.every((id) => id === "c9"));
    });

    test("an explicit renew on a lost lease reports it; on a held lease it does not", async () => {
        const server = new Server();
        const lost: string[] = [];
        const lease = (await new RedisTurnLock(new Conn(server), { onLost: (id) => lost.push(id) }).acquire("c1"))!;
        await lease.renew();
        assert.deepEqual(lost, []);
        server.expire("mekik:lock:c1");
        await lease.renew();
        assert.deepEqual(lost, ["c1"]);
        await lease.release();
    });

    test("a heartbeat whose EVAL fails is swallowed — no unhandled rejection, the lease still releases", async () => {
        const server = new Server();
        const conn = new Conn(server);
        const unhandled: unknown[] = [];
        const onUnhandled = (e: unknown) => unhandled.push(e);
        process.on("unhandledRejection", onUnhandled);
        try {
            const lease = (await new RedisTurnLock(conn, { heartbeatMs: 5 }).acquire("c1"))!;
            conn.failEval = true;
            await sleep(25);
            conn.failEval = false;
            await lease.release();
            assert.deepEqual(unhandled, []);
            assert.equal(server.store.has("mekik:lock:c1"), false);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});

// ── backplane ─────────────────────────────────────────────────────────────────

describe("RedisBackplane edges", () => {
    test("one SUBSCRIBE per conversation however many handlers; UNSUBSCRIBE only when the last leaves", async () => {
        const server = new Server();
        const bp = new RedisBackplane(new Conn(server), { keyPrefix: "p" });
        const s1 = await bp.subscribe("c1", () => {});
        const s2 = await bp.subscribe("c1", () => {});
        await s1.unsubscribe();
        await s1.unsubscribe(); // idempotent
        assert.deepEqual(server.commands.filter((c) => /SUBSCRIBE/.test(c)), ["SUBSCRIBE p:bp:c1"]);
        await s2.unsubscribe();
        assert.deepEqual(server.commands.filter((c) => /SUBSCRIBE/.test(c)), ["SUBSCRIBE p:bp:c1", "UNSUBSCRIBE p:bp:c1"]);
        await bp.close();
    });

    test("a malformed payload on the channel is dropped; the next good one still arrives", async () => {
        const server = new Server();
        const bp = new RedisBackplane(new Conn(server));
        const got: string[] = [];
        await bp.subscribe("c1", (m) => got.push((m.frame as { data: { text: string } }).data.text));
        const raw = new Conn(server);
        await raw.publish("mekik:bp:c1", "{not json");
        await bp.publish("c1", msg("ok"));
        assert.deepEqual(got, ["ok"]);
        await bp.close();
    });

    test("a message for a conversation with no live handler is ignored", async () => {
        const server = new Server();
        const bp = new RedisBackplane(new Conn(server));
        const got: unknown[] = [];
        const sub = await bp.subscribe("c1", (m) => got.push(m));
        await sub.unsubscribe();
        // The fake still has the connection subscribed to nothing; deliver directly.
        const subscriberConn = [...server.subscribers][0]!;
        subscriberConn.listeners.forEach((l) => l("mekik:bp:c1", JSON.stringify(msg("late"))));
        assert.deepEqual(got, []);
        await bp.close();
    });

    test("close() quits the duplicated subscriber it opened, and only that", async () => {
        const server = new Server();
        const pub = new Conn(server);
        const bp = new RedisBackplane(pub);
        await bp.subscribe("c1", () => {});
        await bp.close();
        assert.equal(pub.duplicated, 1);
        assert.equal(pub.quit_, false, "the shared publisher connection is the caller's");
        assert.equal(server.subscribers.size, 0, "the subscriber connection is gone");
    });

    test("an injected subscriber is never duplicated or quit; after close nothing is delivered", async () => {
        const server = new Server();
        const pub = new Conn(server);
        const sub = new Conn(server);
        const bp = new RedisBackplane(pub, { subscriber: sub });
        const got: unknown[] = [];
        await bp.subscribe("c1", (m) => got.push(m));
        await bp.close();
        await bp.close(); // safe twice
        await pub.publish("mekik:bp:c1", JSON.stringify(msg("after close")));
        assert.equal(pub.duplicated, 0);
        assert.equal(sub.quit_, false);
        assert.deepEqual(got, []);
    });

    test("close() before any subscribe is harmless", async () => {
        const server = new Server();
        await new RedisBackplane(new Conn(server)).close();
    });
});

// ── two engines through the Redis ports ───────────────────────────────────────

describe("a two-node fleet over the Redis ports", () => {
    class Tab implements Connection {
        readonly sent: OutgoingFrame[] = [];
        readonly id: string;
        constructor(id: string) {
            this.id = id;
        }
        send(f: OutgoingFrame): void {
            this.sent.push(f);
        }
        close(): void {}
    }
    const runs = (t: Tab) => t.sent.filter((f) => f.type === "run").map((f) => (f as { data: { status: string } }).data.status);
    const errors = (t: Tab) => t.sent.filter((f) => f.type === "error").map((f) => (f as { data: { code: string } }).data.code);

    test("node B's tab sees node A's turn; a turn on B while A's run holds the lease is busy", async () => {
        const server = new Server();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const g = graph("fleet")
            .channel("input", channel.lastWrite<string>(""))
            .channel("reply", channel.lastWrite<string>(""))
            .node("n", async (s, ctx) => {
                if (s.input === "slow") {
                    ctx.emit({ type: "token", text: "…" });
                    await gate;
                }
                return { reply: `done:${s.input}` };
            })
            .edge(START, "n")
            .edge("n", END)
            .compile();
        const shared = { history: new InMemoryHistoryStore(), conversations: new InMemoryConversationStore(), checkpointer: new InMemoryCheckpointer() };
        const node = () =>
            mekik({
                graph: g,
                reply: (s) => s.reply as string,
                ...shared,
                turnLock: new RedisTurnLock(new Conn(server)),
                backplane: new RedisBackplane(new Conn(server)),
            });
        const nodeA = node();
        const nodeB = node();

        const a = new Tab("tab-a");
        await nodeA.connect(a, { hello: { userId: "u" } });
        const conversationId = (a.sent[0] as { data: { conversationId: string } }).data.conversationId;
        const b = new Tab("tab-b");
        await nodeB.connect(b, { hello: { userId: "u", conversationId } });

        const running = nodeA.receive(a, { type: "text", data: { text: "slow" } });
        for (let i = 0; i < 200 && !b.sent.some((f) => f.type === "genui"); i++) await sleep(1);
        await nodeB.receive(b, { type: "text", data: { text: "me too" } });
        release();
        await running;

        assert.deepEqual(errors(b), ["busy"], "the Redis lease held across nodes");
        assert.deepEqual(runs(b), ["started", "finished"], "B saw A's run through the backplane");
        assert.ok(b.sent.some((f) => f.type === "text" && (f as { from: string }).from === "user"), "including A's user turn");
        assert.deepEqual(runs(a), ["started", "finished"], "no echo of A's own frames back to A");

        await nodeB.receive(b, { type: "text", data: { text: "now" } });
        assert.deepEqual(errors(b), ["busy"], "the lease was released after A's run");
        assert.equal(runs(a).length, 4, "A sees B's turn in return");
    });
});
