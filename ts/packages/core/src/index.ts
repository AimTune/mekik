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
import { message, messageKind, messageSpec, messages } from "./messages.ts";
import {
    action,
    approve,
    authClaims,
    callClientTool,
    choose,
    claimStrings,
    clientTools,
    event,
    loadSkill,
    mount,
    nextToolCallId,
    onEvent,
    skillResource,
    skillResourcesAvailable,
    skills,
    skillsPrompt,
    skillTools,
    skillTrace,
    streamText,
    text,
    tool,
    toolTrace,
    ui,
} from "./helpers.ts";

/** The app factory with the authoring helpers attached (PROTOCOL.md §6). */
export const mekik = Object.assign(createMekikApp, {
    text,
    streamText,
    ui,
    mount,
    event,
    tool,
    approve,
    onEvent,
    action,
    choose,
    clientTools,
    callClientTool,
    skills,
    skillsPrompt,
    skillTools,
    loadSkill,
    skillResource,
    skillResourcesAvailable,
    // The low-level trace primitives, as on .NET's Shuttle — for integrations that
    // run tools or resolve skills themselves.
    toolTrace,
    nextToolCallId,
    skillTrace,
    component,
    genui,
    message,
    messageKind,
    messageSpec,
    messages,
    authClaims,
    claimStrings,
});

export { MekikApp } from "./app.ts";
export type { MekikOptions } from "./app.ts";

export { GenUiComponent, ComponentCatalog, defineComponent, toComponentDefinition, hashDefinitions } from "./components.ts";
export type { ComponentSpec, ComponentSource, DefinedComponent } from "./components.ts";

export { ConversationEngine, randomMinter } from "./engine.ts";
export type { ClientSkillsPolicy, ClientToolsPolicy, Connection, ConnectParams, EngineConfig, GenUiEvent, Greeting } from "./engine.ts";

// mekik as an MCP server (PROTOCOL.md §13): a graph as tools another agent calls.
export { driveTurn, JSON_RPC, MCP_PROTOCOL_VERSIONS, McpArgumentError, MekikMcpServer, summarize as summarizeMcpTurn } from "./mcp.ts";
export type { JsonRpcRequest, JsonRpcResponse, McpCallToolResult, McpPendingView, McpServerOptions, McpToolDefinition, McpTurnResult } from "./mcp.ts";

// mekik as an A2A agent (PROTOCOL.md §14): the graph behind an Agent Card, turns as tasks.
export { A2A_ERRORS, A2A_PROTOCOL_VERSION, A2aRequestError, answersFor, InMemoryA2aTaskStore, MekikA2aServer, parseMessage, stateOf as a2aStateOf, textOf as a2aTextOf } from "./a2a.ts";
export type {
    A2aAgentCard,
    A2aAgentSkill,
    A2aArtifact,
    A2aJsonRpcResponse,
    A2aMessage,
    A2aPart,
    A2aServerOptions,
    A2aTask,
    A2aTaskState,
    A2aTaskStatus,
    A2aTaskStore,
} from "./a2a.ts";

// Skills (PROTOCOL.md §12): the source port, the prompt renderer, the catalog hash.
export { DEFAULT_SKILLS_INTRO, hashSkills, renderSkillsPrompt, StaticSkillSource, summaryOf, toSkillSource, TurnSkills } from "./skills.ts";
export type { SkillSource, SkillsInput, SkillsPromptOptions } from "./skills.ts";

export { IlmekAdapter } from "./adapter.ts";
export type { RunContext } from "./adapter.ts";

export { TurnMapper, eventToFrames, unwrapInterrupt, interruptFrameData } from "./mapper.ts";
export type { IdMinter, TurnMapperDeps } from "./mapper.ts";

// The helpers are also available as named imports, for callers who prefer them.
export {
    action,
    approve,
    authClaims,
    callClientTool,
    choose,
    claimStrings,
    clientTools,
    event,
    loadSkill,
    mount,
    onEvent,
    skillResource,
    skillResourcesAvailable,
    skills,
    skillsPrompt,
    skillTools,
    skillTrace,
    streamText,
    text,
    tool,
    ui,
} from "./helpers.ts";
export type {
    ActionOf,
    ApproveOptions,
    CallClientToolOptions,
    ChoiceOption,
    ChoiceValue,
    ChooseOptions,
    ChunkOptions,
    ClientToolFilter,
    OnEventOptions,
    SkillFilter,
    UiHandle,
} from "./helpers.ts";

// Typed rich messages: the factory and chativa's built-in message types.
export { message, messageKind, messageSpec, messages } from "./messages.ts";
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
    MessageSpec,
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
    CLIENT_TOOL_EVENT,
    isMessageFrame,
    isPersistent,
    isValidSkillName,
    parseIncoming,
    PERSISTENT_FRAME_TYPES,
    PROTOCOL_VERSION,
    ProtocolError,
    RESERVED_FRAME_TYPES,
    sanitizeClientSkills,
    sanitizeClientTools,
    SKILL_DESCRIPTION_MAX,
    SKILL_NAME_MAX,
} from "./protocol.ts";
export type {
    AIChunk,
    ClientSkillDefinition,
    ClientSkillsFrame,
    ClientToolCall,
    ClientToolDefinition,
    ClientToolMode,
    ClientToolsFrame,
    ErrorFrame,
    Frame,
    GenUIEventFrame,
    GenUIEventScope,
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
    SkillEntry,
    SkillFrame,
    SkillOrigin,
    SkillsFrame,
    SkillStatus,
    SkillSummary,
    SkillUse,
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
