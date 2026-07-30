// Server-defined GenUI components — the catalog the client registers on connect.
//
// Until now a `ui` chunk named a component the *client* had already registered:
// the backend could only reference widgets someone had compiled into the page.
// A server-defined component inverts that. The graph author writes the widget
// here — markup, styles, prop defaults — and the engine ships it as metadata in
// a `genui_components` frame; chativa turns each definition into a custom
// element and mounts it by name from then on. No client build, no redeploy to
// add a widget.
//
// What travels is markup, never code: the template language is `{{value}}`,
// `{{#if}}` and `{{#each}}` (PROTOCOL.md §10.3), every interpolation is escaped,
// and the client sanitizes the result again before it reaches the DOM.
//
// The catalog is versioned by a hash so it is sent once, not on every connect:
// the client stores `{ hash, components }`, hands the hash back in `hello`, and
// the server answers `unchanged` when nothing moved (PROTOCOL.md §10.2).

import { createHash } from "node:crypto";

import type { Context } from "@ilmek/core";

import { component, type UiComponent } from "./genui.ts";
import { canonicalize, type GenUiComponentDefinition } from "./protocol.ts";
import type { ChunkOptions } from "./helpers.ts";

/** What a component author writes: the widget's name, markup and prop defaults. */
export interface ComponentSpec<P extends object = Record<string, unknown>> {
    /** Registry name a `ui` chunk mounts by, e.g. `"order-card"`. */
    name: string;
    /** Markup with `{{…}}` placeholders (PROTOCOL.md §10.3). */
    template: string;
    /** Optional CSS, scoped to the component's shadow root on the client. */
    css?: string;
    /**
     * Prop defaults. Doubles as the declaration the client makes reactive, so a
     * prop that a chunk may set must appear here — with the value it should have
     * when the chunk omits it.
     */
    props?: P;
    /** Bump when the markup changes in a way older cached copies must not keep. */
    version?: string;
    /** Custom element tag on the client. Derived from `name` when omitted. */
    tag?: string;
}

/**
 * A component authored as a class — the shape `mekik({ components: [...] })`
 * accepts alongside plain specs.
 *
 * @example
 * ```ts
 * class OrderCard extends GenUiComponent<{ id: string; title: string }> {
 *     readonly name = "order-card";
 *     readonly template = `<div class="card">
 *         <h3>{{title}}</h3>
 *         <button data-event="track_order" data-payload='{"id":"{{id}}"}'>Track</button>
 *     </div>`;
 *     override readonly css = `.card { border: 1px solid #e2e8f0; padding: 12px; }`;
 *     override readonly props = { id: "", title: "" };
 * }
 *
 * const app = mekik({ graph: g, components: [new OrderCard()] });
 * ```
 */
export abstract class GenUiComponent<P extends object = Record<string, unknown>> {
    abstract readonly name: string;
    abstract readonly template: string;
    readonly css?: string;
    readonly props?: P;
    readonly version?: string;
    readonly tag?: string;

    /** Emit this component into the turn's stream — the typed `mekik.ui`. */
    emit(ctx: Context<any>, props: P, opts?: ChunkOptions): void {
        component<P>(this.name)(ctx, props, opts);
    }

    /** The wire metadata for this component. */
    definition(): GenUiComponentDefinition {
        return toDefinition(this);
    }
}

/** Anything `mekik({ components })` accepts. */
export type ComponentSource =
    | ComponentSpec
    | GenUiComponent<any>
    | DefinedComponent<any>
    | (new () => GenUiComponent<any>);

/** What {@link defineComponent} returns: the typed emitter, plus its metadata. */
export interface DefinedComponent<P extends object> extends UiComponent<P> {
    /** The wire metadata the engine ships to the client. */
    readonly definition: GenUiComponentDefinition;
}

/** Strip undefined fields so an absent `css` and `css: undefined` hash alike. */
function toDefinition(spec: ComponentSpec | GenUiComponent<any>): GenUiComponentDefinition {
    const def: GenUiComponentDefinition = { name: spec.name, template: spec.template };
    if (spec.css !== undefined) def.css = spec.css;
    if (spec.props !== undefined) def.props = spec.props as Record<string, unknown>;
    if (spec.version !== undefined) def.version = spec.version;
    if (spec.tag !== undefined) def.tag = spec.tag;
    return def;
}

/**
 * Define a server-owned component: one call yields both the typed emitter and
 * the metadata the client registers.
 *
 * @remarks
 * The emitter is exactly `mekik.component<P>(name)` — nothing new travels per
 * chunk. What the definition adds is the *registration*, sent once per catalog
 * version rather than per turn.
 *
 * @example
 * ```ts
 * export const orderCard = defineComponent({
 *     name: "order-card",
 *     template: `<h3>{{title}}</h3>{{#each lines}}<p>{{this.label}}</p>{{/each}}`,
 *     props: { title: "", lines: [] as Array<{ label: string }> },
 * });
 *
 * const app = mekik({ graph: g, components: [orderCard] });
 *
 * // …inside a node, compiler-checked:
 * orderCard(ctx, { title: "Order #123", lines: [{ label: "Tea" }] });
 * ```
 */
export function defineComponent<P extends object>(spec: ComponentSpec<P>): DefinedComponent<P> {
    const emitter = component<P>(spec.name);
    return Object.assign(emitter, { definition: toDefinition(spec as ComponentSpec) }) as DefinedComponent<P>;
}

function isClass(source: ComponentSource): source is new () => GenUiComponent<any> {
    return typeof source === "function" && source.prototype instanceof GenUiComponent;
}

/** Normalize any accepted authoring form to its wire metadata. */
export function toComponentDefinition(source: ComponentSource): GenUiComponentDefinition {
    if (isClass(source)) return toDefinition(new source());
    if (source instanceof GenUiComponent) return source.definition();
    if (typeof source === "function") return (source as DefinedComponent<any>).definition;
    return toDefinition(source);
}

/**
 * The server's component catalog: the definitions plus the hash that versions
 * them.
 *
 * The hash is `sha256` over the canonical JSON of the definitions sorted by
 * name — the same canonicalization the golden fixtures use, so the TypeScript
 * and .NET servers mint identical hashes for identical catalogs and a client
 * can move between them without re-downloading.
 */
export class ComponentCatalog {
    readonly definitions: readonly GenUiComponentDefinition[];
    readonly hash: string;

    constructor(sources: readonly ComponentSource[] = []) {
        const seen = new Map<string, GenUiComponentDefinition>();
        for (const source of sources) {
            const def = toComponentDefinition(source);
            if (!def.name || typeof def.template !== "string") {
                throw new Error(`mekik: a component needs a name and a template (got ${JSON.stringify(def.name)})`);
            }
            if (seen.has(def.name)) {
                throw new Error(`mekik: duplicate component name ${JSON.stringify(def.name)}`);
            }
            seen.set(def.name, def);
        }
        this.definitions = [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        this.hash = this.definitions.length === 0 ? "" : hashDefinitions(this.definitions);
    }

    get isEmpty(): boolean {
        return this.definitions.length === 0;
    }
}

/** `sha256(canonical JSON)`, hex — identical in every mekik implementation. */
export function hashDefinitions(definitions: readonly GenUiComponentDefinition[]): string {
    return createHash("sha256").update(canonicalize(definitions), "utf8").digest("hex");
}
