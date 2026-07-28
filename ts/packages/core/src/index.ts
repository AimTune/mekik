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
import { component, genui } from "./genui.ts";
import { message, messageKind, messages } from "./messages.ts";
import { action, approve, authClaims, choose, claimStrings, event, mount, streamText, text, tool, ui } from "./helpers.ts";

/** The app factory with the authoring helpers attached (PROTOCOL.md §6). */
export const mekik = Object.assign(createMekikApp, {
    text,
    streamText,
    ui,
    mount,
    event,
    tool,
    approve,
    action,
    choose,
    component,
    genui,
    message,
    messageKind,
    messages,
    authClaims,
    claimStrings,
});

export { MekikApp } from "./app.ts";
export type { MekikOptions } from "./app.ts";

export { ConversationEngine, randomMinter } from "./engine.ts";
export type { Connection, ConnectParams, EngineConfig } from "./engine.ts";

export { IlmekAdapter } from "./adapter.ts";
export type { RunContext } from "./adapter.ts";

export { TurnMapper, eventToFrames, unwrapInterrupt, interruptFrameData } from "./mapper.ts";
export type { IdMinter, TurnMapperDeps } from "./mapper.ts";

// The helpers are also available as named imports, for callers who prefer them.
export { action, approve, authClaims, choose, claimStrings, event, mount, streamText, text, tool, ui } from "./helpers.ts";
export type { ActionOf, ApproveOptions, ChoiceOption, ChoiceValue, ChooseOptions, ChunkOptions, UiHandle } from "./helpers.ts";

// Typed rich messages: the factory and chativa's built-in message types.
export { message, messageKind, messages } from "./messages.ts";
export type {
    ButtonsMessageData,
    CardMessageData,
    CarouselCard,
    CarouselMessageData,
    FileMessageData,
    ImageMessageData,
    MessageButton,
    MessageKind,
    MessageOptions,
    QuickReplyMessageData,
    TextMessageData,
    VideoMessageData,
} from "./messages.ts";

// Typed GenUI components: the factory and chativa's built-in catalog.
export { component, genui } from "./genui.ts";
export type {
    GenUIAlertProps,
    GenUIAlertVariant,
    GenUICardAction,
    GenUICardProps,
    GenUIChartDataset,
    GenUIChartProps,
    GenUIDatePickerProps,
    GenUIFormField,
    GenUIFormProps,
    GenUIImage,
    GenUIImageGalleryProps,
    GenUIListItem,
    GenUIListProps,
    GenUIProgressProps,
    GenUIProgressVariant,
    GenUIQuickRepliesProps,
    GenUIQuickReplyItem,
    GenUIRatingProps,
    GenUIStep,
    GenUIStepsProps,
    GenUITableProps,
    GenUITextProps,
    TypedUiHandle,
    UiComponent,
} from "./genui.ts";

// Low-level trace primitives, for integrations that execute tools themselves
// (see @mekik/langchain).
export { nextToolCallId, toolTrace } from "./helpers.ts";

export {
    AUTH_CLOSE_CODE,
    canonicalize,
    isMessageFrame,
    isPersistent,
    parseIncoming,
    PERSISTENT_FRAME_TYPES,
    PROTOCOL_VERSION,
    ProtocolError,
    RESERVED_FRAME_TYPES,
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
    MessageOutFrame,
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
