// The external-transcript deployment profile (PROTOCOL.md "Running behind a hub").
//
// When a hub such as Converger owns the transcript and the seq space, mekik stops
// being either: it keeps no frames, replays nothing, trusts the hub's identity and
// does not echo the user's own turn (the hub already delivered it). The wire mekik
// produces is unchanged — the engine still stamps `seq`, but the hub renumbers it
// on persistence, so the value is a hint. All opt-in:
//
//   import { mekik, externalTranscript } from "@mekik/core";
//   const app = mekik({ graph, ...externalTranscript() });
//   connectConverger(app, { url, secret });          // @mekik/converger

import type { Authenticator, AuthVerdict, Credential } from "./auth.ts";
import type { ConversationRecord, ConversationStore, HistoryStore, PersistentFrame } from "./stores.ts";

/** What the hub transport learned about one conversation it is serving. */
interface HubFacts {
    /** The user the conversation's virtual connection speaks for (first one sticks). */
    userId?: string;
    /** The seq the engine should continue from: the hub's head just before the turn that brought the conversation in. */
    seq: number;
}

/**
 * The shared notebook between a hub transport and the profile's ports: the
 * transport records what the hub said about a conversation before it connects
 * the conversation's virtual connection; the stores read it back.
 */
export class ExternalTranscript {
    private readonly byId = new Map<string, HubFacts>();

    /** Record what the hub said: the owner (the first one sticks) and the seq to continue from. */
    observe(conversationId: string, facts: { userId?: string; seq?: number }): void {
        const prev = this.byId.get(conversationId);
        const userId = prev?.userId ?? facts.userId;
        const seq = facts.seq ?? prev?.seq ?? 0;
        this.byId.set(conversationId, { ...(userId !== undefined ? { userId } : {}), seq });
    }

    /** The user the hub reported for the conversation, if any. */
    owner(conversationId: string): string | undefined {
        return this.byId.get(conversationId)?.userId;
    }

    /** The seq to continue from (0 when the hub said nothing). */
    seq(conversationId: string): number {
        return this.byId.get(conversationId)?.seq ?? 0;
    }

    /** Drop a conversation the transport stopped serving (idle eviction). */
    forget(conversationId: string): void {
        this.byId.delete(conversationId);
    }

    /** How many conversations are being served. */
    get size(): number {
        return this.byId.size;
    }
}

/**
 * The transcript port when the hub is the transcript: `record` keeps nothing,
 * `after` replays nothing (the hub replays its own transcript to its clients),
 * and `currentSeq` seeds the engine's counter from what the hub reported.
 */
export class ExternalTranscriptHistoryStore implements HistoryStore {
    readonly transcript: ExternalTranscript;

    constructor(transcript: ExternalTranscript = new ExternalTranscript()) {
        this.transcript = transcript;
    }

    async record(_conversationId: string, _frame: PersistentFrame): Promise<void> {
        // The hub persists the frame when the transport forwards it.
    }

    async after(_conversationId: string, _watermark: number): Promise<PersistentFrame[]> {
        return [];
    }

    async currentSeq(conversationId: string): Promise<number> {
        return this.transcript.seq(conversationId);
    }
}

/**
 * The conversation registry when the hub owns conversations: `get` answers from
 * what the transport observed (the hub already checked access), `create` is a
 * no-op — a hub transport never asks the engine to mint a conversation.
 */
export class HubConversationStore implements ConversationStore {
    readonly transcript: ExternalTranscript;

    constructor(transcript: ExternalTranscript) {
        this.transcript = transcript;
    }

    async get(conversationId: string): Promise<ConversationRecord | null> {
        const userId = this.transcript.owner(conversationId);
        return userId === undefined ? null : { conversationId, userId, createdAt: 0, meta: {} };
    }

    async create(_record: ConversationRecord): Promise<void> {}
}

/**
 * Trusts the identity the hub verified at its edge, which the hub transport puts
 * at `credential.meta.auth` (`{ userId, role?, name? }`). The whole object becomes
 * the claims (`ctx.meta.auth`). Anti-spoofing is the hub's job; this only works
 * with a transport that synthesises the hello itself, never with `@mekik/ws`.
 */
export class HubAuthenticator implements Authenticator {
    authenticate(credential: Credential): AuthVerdict {
        const auth = credential.meta?.auth;
        if (typeof auth !== "object" || auth === null || Array.isArray(auth)) {
            return { ok: false, reason: "no hub-verified identity" };
        }
        const userId = (auth as { userId?: unknown }).userId;
        if (typeof userId !== "string" || userId.length === 0) return { ok: false, reason: "no hub-verified identity" };
        return { ok: true, userId, claims: { ...(auth as Record<string, unknown>) } };
    }
}

/** The options `externalTranscript()` sets — spread them into `mekik({ … })`. */
export interface ExternalTranscriptOptions {
    history: ExternalTranscriptHistoryStore;
    conversations: HubConversationStore;
    authenticator: HubAuthenticator;
    echoUserTurns: false;
}

/**
 * The external-transcript profile in one call. Spread the result into `mekik()`;
 * a hub transport finds the shared {@link ExternalTranscript} through
 * `app.history.transcript`.
 *
 * @example
 * ```ts
 * const app = mekik({ graph, reply: (s) => s.reply as string, ...externalTranscript() });
 * ```
 */
export function externalTranscript(transcript: ExternalTranscript = new ExternalTranscript()): ExternalTranscriptOptions {
    return {
        history: new ExternalTranscriptHistoryStore(transcript),
        conversations: new HubConversationStore(transcript),
        authenticator: new HubAuthenticator(),
        echoUserTurns: false,
    };
}
