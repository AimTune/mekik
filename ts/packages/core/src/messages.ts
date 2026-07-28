// Typed rich messages — `mekik.message` and the `mekik.messages` catalog.
//
// chativa renders a conversation out of *messages*, each dispatched to a
// renderer by its `type` ("image", "card", "carousel", …; MessageTypeRegistry).
// mekik/1 carries one as a rich message frame (PROTOCOL.md §4.5): the `text`
// frame's envelope under the renderer's name, with the renderer's payload as
// `data`. This module is the typed view over that pair — `message` emits any
// type + JSON data, `messageKind<Data>(type)` binds a type once so call sites
// are compiler-checked, and `messages` is that factory applied to chativa's
// built-in message renderers. The data shapes mirror chativa's own components.
//
// Messages are persistent: they join the transcript, replay on reconnect, and
// advance the watermark — unlike GenUI text chunks, they are not turn-transient.
// A tapped button/chip/card action arrives back as the *next user turn* (its
// `value` — or label — as `data.text`), or as the `resume` answer when the run
// is parked on an interrupt; see `mekik.choose` for the interrupt-bound form.

import type { Context } from "@ilmek/core";

import { RESERVED_FRAME_TYPES } from "./protocol.ts";

const MEKIK_KEY = "$mekik";

export interface MessageOptions {
    /**
     * The message's id on the wire. Omit and mekik mints one (the engine's
     * `IdMinter`). Supply one when you want messages deterministically
     * addressable — e.g. keyed by an order id.
     */
    id?: string;
}

/**
 * Emit one rich message — message type + JSON data, the low-level form.
 *
 * @remarks
 * The type names a message renderer on the client (chativa's
 * `MessageTypeRegistry`); the data is that renderer's payload, delivered as the
 * frame's `data`. Prefer the typed {@link messages} catalog for chativa's
 * built-ins, and {@link messageKind} to bind your own custom type once.
 *
 * `"text"` is allowed (it emits a regular text frame); the protocol's other
 * frame types (`"genui"`, `"interrupt"`, …) are reserved and throw.
 *
 * @param ctx - The ilmek node context.
 * @param type - The client message-renderer name.
 * @param data - The renderer's payload.
 * @param opts - Optional stable message id; see {@link MessageOptions}.
 *
 * @example
 * ```ts
 * mekik.message(ctx, "image", { src: "https://…/receipt.png", caption: "Your receipt" });
 * ```
 */
export function message(ctx: Context<any>, type: string, data: Record<string, unknown>, opts: MessageOptions = {}): void {
    if (RESERVED_FRAME_TYPES.has(type) && type !== "text") {
        throw new TypeError(`mekik.message: "${type}" is a reserved protocol frame type, not a message type`);
    }
    ctx.emit({
        [MEKIK_KEY]: "message",
        messageType: type,
        data,
        ...(opts.id !== undefined ? { id: opts.id } : {}),
    });
}

/** A typed message kind: the callable emits it; `type` is the renderer name. */
export interface MessageKind<D extends object> {
    (ctx: Context<any>, data: D, opts?: MessageOptions): void;
    /** The client message-renderer name this emits as. */
    readonly type: string;
}

/**
 * Bind a message type once, so every call site is compiler-checked — the
 * message-side sibling of `mekik.component`.
 *
 * @example
 * ```ts
 * const receipt = mekik.messageKind<{ orderId: string; totalCents: number }>("receipt");
 * receipt(ctx, { orderId: "ORD-42", totalCents: 24990 });
 * ```
 */
export function messageKind<D extends object>(type: string): MessageKind<D> {
    const emit = (ctx: Context<any>, data: D, opts: MessageOptions = {}): void =>
        message(ctx, type, data as Record<string, unknown>, opts);
    Object.defineProperty(emit, "name", { value: type });
    return Object.assign(emit, { type }) as MessageKind<D>;
}

// ── chativa's built-in message renderers ──────────────────────────────────────
// Data shapes mirror @chativa/ui's message components; these types render out
// of the box, no client-side registration needed.

/** A message-level button; `value` (default: the label) comes back as the next user turn's text. */
export interface MessageButton {
    label: string;
    value?: string;
}

export interface TextMessageData {
    text: string;
    /** Links to preview under the bubble. */
    urls?: string[];
    previewVariant?: "compact" | "expanded";
}

export interface ImageMessageData {
    src: string;
    alt?: string;
    caption?: string;
}

export interface CardMessageData {
    title: string;
    subtitle?: string;
    image?: string;
    buttons?: MessageButton[];
}

export interface ButtonsMessageData {
    text?: string;
    /** Keep the buttons tappable after a selection (re-selectable). */
    persistent?: boolean;
    buttons: MessageButton[];
}

export interface QuickReplyMessageData {
    text: string;
    actions: MessageButton[];
    /** Leave the chips rendered after the tap. */
    keepActions?: boolean;
}

export interface FileMessageData {
    url: string;
    name: string;
    /** Bytes. */
    size?: number;
    mimeType?: string;
}

export interface VideoMessageData {
    src: string;
    poster?: string;
    caption?: string;
}

export interface CarouselCard {
    title: string;
    subtitle?: string;
    image?: string;
    buttons?: MessageButton[];
}
export interface CarouselMessageData {
    cards: CarouselCard[];
}

/**
 * Typed emitters for chativa's built-in message types — pick the message kind,
 * let the compiler check the data.
 *
 * @remarks
 * These are *messages*, not GenUI: persistent transcript entries rendered by
 * chativa's message components. Button values come back as the next user turn.
 * For buttons that pause the run and resume with the pick, use `mekik.choose`.
 *
 * @example
 * ```ts
 * mekik.messages.image(ctx, { src: receiptUrl, caption: "Your receipt" });
 * mekik.messages.card(ctx, {
 *     title: order.id,
 *     subtitle: `$${order.total}`,
 *     buttons: [{ label: "Track", value: `/track ${order.id}` }],
 * });
 * mekik.messages.carousel(ctx, { cards: products.map(toCard) });
 * ```
 */
export const messages = {
    text: messageKind<TextMessageData>("text"),
    image: messageKind<ImageMessageData>("image"),
    card: messageKind<CardMessageData>("card"),
    buttons: messageKind<ButtonsMessageData>("buttons"),
    quickReply: messageKind<QuickReplyMessageData>("quick-reply"),
    file: messageKind<FileMessageData>("file"),
    video: messageKind<VideoMessageData>("video"),
    carousel: messageKind<CarouselMessageData>("carousel"),
} as const;
