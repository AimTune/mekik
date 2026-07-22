/**
 * mekik - the realtime serving layer for ilmek graphs.
 *
 * PROTOCOL.md is the normative wire spec (`mekik/1`); this module is its
 * TypeScript surface. A graph becomes a live conversation:
 *
 * ```ts
 * import { graph, channel, START, END } from "@ilmek/core";
 * import { mekik, serveWs } from "@mekik/core"; // serveWs from @mekik/ws
 *
 * const g = graph("greeter")
 *     .channel("input", channel.lastWrite<string>())
 *     .channel("reply", channel.lastWrite<string>())
 *     .node("greet", (s, ctx) => {
 *         mekik.ui(ctx, "hello-card", { name: s.input });
 *         return { reply: `Hi, ${s.input}!` };
 *     })
 *     .edge(START, "greet").edge("greet", END)
 *     .compile();
 *
 * const app = mekik({ graph: g, reply: (s) => s.reply as string });
 * serveWs(app, { port: 8800, path: "/ws" });
 * ```
 *
 * The single export `mekik` is both the app factory (`mekik({ graph })`) and
 * the node-authoring helpers (`mekik.ui(ctx, …)`, `mekik.approve(ctx, …)`).
 */

import { createMekikApp } from "./app.ts";
import { approve, event, text, tool, ui } from "./helpers.ts";

/** The app factory with the authoring helpers attached (PROTOCOL.md §6). */
export const mekik = Object.assign(createMekikApp, { text, ui, event, tool, approve });

export { MekikApp } from "./app.ts";
export type { MekikOptions } from "./app.ts";

export { ConversationEngine, randomMinter } from "./engine.ts";
export type { Connection, ConnectParams, EngineConfig } from "./engine.ts";

export { IlmekAdapter } from "./adapter.ts";
export type { RunContext } from "./adapter.ts";

export { TurnMapper, eventToFrames, unwrapInterrupt, interruptFrameData } from "./mapper.ts";
export type { IdMinter, TurnMapperDeps } from "./mapper.ts";

// The helpers are also available as named imports, for callers who prefer them.
export { approve, event, text, tool, ui } from "./helpers.ts";
export type { ApproveOptions } from "./helpers.ts";

// Low-level trace primitives, for integrations that execute tools themselves
// (see @mekik/langchain).
export { nextToolCallId, toolTrace } from "./helpers.ts";

export {
    AUTH_CLOSE_CODE,
    canonicalize,
    isPersistent,
    parseIncoming,
    PERSISTENT_FRAME_TYPES,
    PROTOCOL_VERSION,
    ProtocolError,
} from "./protocol.ts";
export type {
    AIChunk,
    ErrorFrame,
    Frame,
    GenUIEventFrame,
    GenUIFrame,
    HelloFrame,
    IncomingFrame,
    InterruptFrame,
    InterruptResolvedFrame,
    MessageAction,
    OutgoingFrame,
    PendingView,
    ResumeFrame,
    RunFrame,
    RunStatus,
    TextInFrame,
    TextOutFrame,
    ToolCall,
    ToolCallFrame,
    ToolStatus,
    UiRef,
    WelcomeFrame,
} from "./protocol.ts";

export {
    InMemoryConversationStore,
    InMemoryHistoryStore,
} from "./stores.ts";
export type { ConversationRecord, ConversationStore, HistoryStore, PersistentFrame } from "./stores.ts";

export { LocalTurnLock, NoopBackplane } from "./scaling.ts";
export type { Backplane, BackplaneMessage, Subscription, TurnLease, TurnLock } from "./scaling.ts";

export { StaticTokenAuthenticator } from "./auth.ts";
export type { AuthVerdict, Authenticator, Credential } from "./auth.ts";
