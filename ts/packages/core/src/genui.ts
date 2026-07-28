// Typed generative-UI components — `mekik.component` and the `mekik.genui` catalog.
//
// mekik still ships no components: on the wire a component is a client-registry
// *name* plus a props JSON object, exactly what `mekik.ui` emits. What this
// module adds is the typed view over that pair — `component<Props>(name)` turns
// a name into a callable whose props the compiler checks, and `genui` is that
// factory applied to the 13 components chativa's `@chativa/genui` package
// registers out of the box (`genui-card`, `genui-table`, …). The prop shapes
// mirror chativa's own component property declarations.

import type { Context } from "@ilmek/core";

import { mount, ui, type ChunkOptions } from "./helpers.ts";
import type { UiRef } from "./protocol.ts";

/** A `UiHandle` whose `update` keeps the component's prop type. */
export interface TypedUiHandle<P extends object> {
    /** The chunk id keying this instance on the client. */
    readonly id: string | number;
    /** Re-emit the component with new props — the client updates it in place. */
    update(props: P): void;
}

/**
 * A typed GenUI component — the callable emits it, and the companions cover the
 * other places a component name + props pair travels.
 *
 * @see {@link component} to create one; {@link genui} for chativa's built-ins.
 */
export interface UiComponent<P extends object> {
    /** Emit the component — a typed `mekik.ui(ctx, name, props, opts)`. */
    (ctx: Context<any>, props: P, opts?: ChunkOptions): void;
    /** The client-registry name this renders as. */
    readonly name: string;
    /** Mount and get a typed handle for in-place updates (see `mekik.mount`). */
    mount(ctx: Context<any>, props: P, opts?: ChunkOptions): TypedUiHandle<P>;
    /** A typed `UiRef` — for `mekik.approve(ctx, q, { ui: form.ref(props) })`. */
    ref(props: P): UiRef;
}

/**
 * Define a typed GenUI component from its client-registry name — component name
 * and props JSON in, compiler-checked call sites out.
 *
 * @remarks
 * Nothing new travels on the wire: the callable is `mekik.ui` with the name
 * pre-bound and the props typed. Use it once per custom component your client
 * registers, next to where you document that component's props.
 *
 * @typeParam P - The component's props shape (the client is the authority).
 * @param name - The name the client registered the component under.
 *
 * @example
 * ```ts
 * const weather = mekik.component<{ city: string; temp: number }>("weather");
 * weather(ctx, { city: "İzmir", temp: 24 });
 * const live = weather.mount(ctx, { city: "İzmir", temp: 24 });
 * live.update({ city: "İzmir", temp: 25 });
 * ```
 */
export function component<P extends object>(name: string): UiComponent<P> {
    const emit = (ctx: Context<any>, props: P, opts: ChunkOptions = {}): void =>
        ui(ctx, name, props as Record<string, unknown>, opts);
    // `name` is a function's own (configurable) property, so Object.assign can't
    // set it — define it instead. Bonus: stack traces show the component name.
    Object.defineProperty(emit, "name", { value: name });
    return Object.assign(emit, {
        mount: (ctx: Context<any>, props: P, opts: ChunkOptions = {}): TypedUiHandle<P> => {
            const handle = mount(ctx, name, props as Record<string, unknown>, opts);
            return { id: handle.id, update: (next: P) => handle.update(next as Record<string, unknown>) };
        },
        ref: (props: P): UiRef => ({ component: name, props: props as Record<string, unknown> }),
    }) as UiComponent<P>;
}

// ── chativa's built-in component catalog ──────────────────────────────────────
// Prop shapes mirror @chativa/genui's component declarations; chativa registers
// these names out of the box, so no client-side registration is needed.

export interface GenUITextProps {
    content: string;
}

export interface GenUICardAction {
    label: string;
    value: string;
}
export interface GenUICardProps {
    title?: string;
    description?: string;
    image?: string;
    actions?: GenUICardAction[];
}

export interface GenUIFormField {
    name: string;
    label: string;
    /** An HTML input type (`"text"`, `"email"`, `"number"`, …). */
    type: string;
    placeholder?: string;
    value?: string;
    required?: boolean;
    disabled?: boolean;
}
export interface GenUIFormProps {
    title?: string;
    fields: GenUIFormField[];
    buttonText?: string;
}

export type GenUIAlertVariant = "info" | "success" | "warning" | "error";
export interface GenUIAlertProps {
    variant?: GenUIAlertVariant;
    title?: string;
    message: string;
    icon?: string;
}

export interface GenUIQuickReplyItem {
    label: string;
    value: string;
}
export interface GenUIQuickRepliesProps {
    label?: string;
    items: GenUIQuickReplyItem[];
}

export interface GenUIListItem {
    text: string;
    icon?: string;
    secondary?: string;
}
export interface GenUIListProps {
    title?: string;
    ordered?: boolean;
    items: GenUIListItem[];
}

export interface GenUITableProps {
    title?: string;
    columns: string[];
    rows: (string | number)[][];
}

export interface GenUIRatingProps {
    title?: string;
    maxStars?: number;
    readonly?: boolean;
    value?: number;
}

export type GenUIProgressVariant = "default" | "success" | "warning" | "error";
export interface GenUIProgressProps {
    label?: string;
    /** 0–100. */
    value: number;
    caption?: string;
    variant?: GenUIProgressVariant;
}

export interface GenUIDatePickerProps {
    label?: string;
    /** ISO date (`YYYY-MM-DD`). */
    min?: string;
    max?: string;
    value?: string;
    disabled?: boolean;
}

export interface GenUIChartDataset {
    label?: string;
    data: number[];
    color?: string;
}
export interface GenUIChartProps {
    type?: "bar" | "line" | "pie";
    title?: string;
    labels?: string[];
    datasets?: GenUIChartDataset[];
}

export interface GenUIStep {
    label: string;
    description?: string;
    status: "done" | "active" | "pending";
}
export interface GenUIStepsProps {
    steps: GenUIStep[];
}

export interface GenUIImage {
    src: string;
    alt?: string;
    caption?: string;
}
export interface GenUIImageGalleryProps {
    images: GenUIImage[];
    columns?: number;
}

/**
 * Typed emitters for the GenUI components chativa registers out of the box —
 * pick the component, let the compiler check the props.
 *
 * @remarks
 * Every entry is a {@link UiComponent}: call it to emit, `.mount` it for a
 * handle that updates in place, `.ref` it to attach as an interrupt form.
 *
 * @example
 * ```ts
 * mekik.genui.table(ctx, { title: "Orders", columns: ["id", "total"], rows: [["ORD-1", 249.9]] });
 *
 * const bar = mekik.genui.progress.mount(ctx, { label: "Deploying", value: 0 });
 * bar.update({ label: "Deploying", value: 60 });
 *
 * const booked = await mekik.approve(ctx, { title: "Book a slot" }, {
 *     ui: mekik.genui.form.ref({ fields: [{ name: "date", label: "Date", type: "date" }] }),
 * });
 * ```
 */
export const genui = {
    text: component<GenUITextProps>("genui-text"),
    card: component<GenUICardProps>("genui-card"),
    form: component<GenUIFormProps>("genui-form"),
    alert: component<GenUIAlertProps>("genui-alert"),
    quickReplies: component<GenUIQuickRepliesProps>("genui-quick-replies"),
    list: component<GenUIListProps>("genui-list"),
    table: component<GenUITableProps>("genui-table"),
    rating: component<GenUIRatingProps>("genui-rating"),
    progress: component<GenUIProgressProps>("genui-progress"),
    datePicker: component<GenUIDatePickerProps>("genui-date-picker"),
    chart: component<GenUIChartProps>("genui-chart"),
    steps: component<GenUIStepsProps>("genui-steps"),
    imageGallery: component<GenUIImageGalleryProps>("genui-image-gallery"),
} as const;
