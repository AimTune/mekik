// The persistence ports (PROTOCOL.md §1, §2) and their in-memory defaults.
//
// These are mekik's own state - the transcript and the conversation registry.
// They are deliberately separate from ilmek's checkpointer: ilmek owns graph
// state and open interrupts; mekik owns what a client sees and replays. v1
// ships only in-memory implementations; the ports exist so a durable backend
// (Redis, Postgres) can drop in later without touching the engine.

import type { OutgoingFrame } from "./protocol.ts";
import { PERSISTENT_FRAME_TYPES } from "./protocol.ts";

/** A persistent server→client frame (carries `seq`). */
export type PersistentFrame = Extract<OutgoingFrame, { seq: number }>;

/**
 * The transcript port. Stores the persistent frames of a conversation in `seq`
 * order and replays the tail after a watermark. `seq` is assigned by the engine
 * (it owns the monotonic counter); the store only persists and ranges.
 */
export interface HistoryStore {
    /** Persist an already-seq-stamped persistent frame. */
    record(conversationId: string, frame: PersistentFrame): Promise<void>;
    /** Persistent frames with `seq > watermark`, ascending - the reconnect replay. */
    after(conversationId: string, watermark: number): Promise<PersistentFrame[]>;
    /** Highest `seq` stored for the conversation, or 0 - used to seed the engine's counter. */
    currentSeq(conversationId: string): Promise<number>;
}

export class InMemoryHistoryStore implements HistoryStore {
    private readonly byConversation = new Map<string, PersistentFrame[]>();

    async record(conversationId: string, frame: PersistentFrame): Promise<void> {
        if (!(PERSISTENT_FRAME_TYPES as readonly string[]).includes(frame.type)) {
            throw new Error(`refusing to record a transient ${frame.type} frame in the transcript`);
        }
        const list = this.byConversation.get(conversationId) ?? [];
        list.push(frame);
        this.byConversation.set(conversationId, list);
    }

    async after(conversationId: string, watermark: number): Promise<PersistentFrame[]> {
        const list = this.byConversation.get(conversationId) ?? [];
        // Stored in append order, which is seq order - but filter by seq rather
        // than slice, so a store that ever reorders stays correct.
        return list.filter((f) => f.seq > watermark);
    }

    async currentSeq(conversationId: string): Promise<number> {
        const list = this.byConversation.get(conversationId);
        return list && list.length > 0 ? list[list.length - 1]!.seq : 0;
    }
}

// ── conversations ─────────────────────────────────────────────────────────────

export interface ConversationRecord {
    conversationId: string;
    /** The user who owns the conversation. */
    userId: string;
    createdAt: number;
    meta: Record<string, unknown>;
}

/** The conversation registry - owner and metadata. Open interrupts live in ilmek, not here. */
export interface ConversationStore {
    get(conversationId: string): Promise<ConversationRecord | null>;
    create(record: ConversationRecord): Promise<void>;
}

export class InMemoryConversationStore implements ConversationStore {
    private readonly byId = new Map<string, ConversationRecord>();

    async get(conversationId: string): Promise<ConversationRecord | null> {
        return this.byId.get(conversationId) ?? null;
    }

    async create(record: ConversationRecord): Promise<void> {
        this.byId.set(record.conversationId, record);
    }
}
