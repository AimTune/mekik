// Unit tests for server-defined GenUI components (PROTOCOL.md §10): the
// authoring forms, the catalog, its hash, and the connect-time frame.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import type { Context } from "@ilmek/core";

import {
    ComponentCatalog,
    GenUiComponent,
    defineComponent,
    hashDefinitions,
    toComponentDefinition,
} from "../src/components.ts";
import { canonicalize } from "../src/protocol.ts";

const SPEC = {
    name: "order-card",
    template: `<h3>{{title}}</h3><button data-event="track_order">Track</button>`,
    css: ".card { padding: 12px; }",
    props: { title: "" },
};

class OrderCard extends GenUiComponent<{ id: string; title: string }> {
    readonly name = "order-card";
    readonly template = SPEC.template;
    override readonly css = SPEC.css;
    override readonly props = { id: "", title: "" };
}

function recordingCtx() {
    const emitted: Array<Record<string, unknown>> = [];
    const ctx = { emit: (p: unknown) => emitted.push(p as Record<string, unknown>) } as unknown as Context<any>;
    return { ctx, emitted };
}

describe("authoring forms", () => {
    test("a plain spec becomes its wire definition", () => {
        assert.deepEqual(toComponentDefinition(SPEC), {
            name: "order-card",
            template: SPEC.template,
            css: SPEC.css,
            props: { title: "" },
        });
    });

    test("absent optional fields are omitted, not sent as undefined", () => {
        const def = toComponentDefinition({ name: "bare", template: "<p>x</p>" });
        assert.deepEqual(Object.keys(def).sort(), ["name", "template"]);
    });

    test("a class instance and its constructor produce the same definition", () => {
        assert.deepEqual(toComponentDefinition(new OrderCard()), toComponentDefinition(OrderCard));
    });

    test("defineComponent yields both a typed emitter and the definition", () => {
        const orderCard = defineComponent(SPEC);
        const { ctx, emitted } = recordingCtx();

        orderCard(ctx, { title: "Order #123" });

        assert.equal(orderCard.definition.name, "order-card");
        assert.deepEqual(emitted, [
            { $mekik: "genui", chunk: { type: "ui", component: "order-card", props: { title: "Order #123" } } },
        ]);
    });

    test("a class emits through the same ui-chunk path", () => {
        const { ctx, emitted } = recordingCtx();
        new OrderCard().emit(ctx, { id: "A1", title: "Order #123" });

        assert.deepEqual(emitted, [
            {
                $mekik: "genui",
                chunk: { type: "ui", component: "order-card", props: { id: "A1", title: "Order #123" } },
            },
        ]);
    });
});

describe("ComponentCatalog", () => {
    test("is empty by default and mints no hash", () => {
        const catalog = new ComponentCatalog();
        assert.equal(catalog.isEmpty, true);
        assert.equal(catalog.hash, "");
    });

    test("sorts definitions by name, so declaration order cannot change the hash", () => {
        const a = new ComponentCatalog([SPEC, { name: "a-card", template: "<p>a</p>" }]);
        const b = new ComponentCatalog([{ name: "a-card", template: "<p>a</p>" }, SPEC]);

        assert.deepEqual(a.definitions.map((d) => d.name), ["a-card", "order-card"]);
        assert.equal(a.hash, b.hash);
    });

    test("the hash is sha256 over the canonical JSON of the definitions", () => {
        const catalog = new ComponentCatalog([SPEC]);
        assert.equal(catalog.hash, hashDefinitions(catalog.definitions));
        assert.match(catalog.hash, /^[0-9a-f]{64}$/);
        // Canonicalization is what makes the hash reproducible across languages.
        assert.equal(canonicalize(catalog.definitions), canonicalize([toComponentDefinition(SPEC)]));
    });

    /**
     * Pinned cross-language: the .NET port asserts the same canonical string and
     * hash for this catalog (dotnet/test/Mekik.Core.Tests/ComponentsTests.cs). A
     * drift here means a client re-downloads the catalog whenever it moves
     * between a TypeScript and a .NET server.
     */
    test("hashes identically to the .NET port", () => {
        const catalog = new ComponentCatalog([SPEC]);

        assert.equal(
            canonicalize(catalog.definitions),
            '[{"css":".card { padding: 12px; }","name":"order-card","props":{"title":""},' +
                '"template":"<h3>{{title}}</h3><button data-event=\\"track_order\\">Track</button>"}]',
        );
        assert.equal(catalog.hash, "d8a1c30060008da9bc3ec56223be3e43d4c1340178460381bb60d9e1bc170847");
    });

    test("a changed template changes the hash", () => {
        const before = new ComponentCatalog([SPEC]).hash;
        const after = new ComponentCatalog([{ ...SPEC, template: "<p>new</p>" }]).hash;
        assert.notEqual(before, after);
    });

    test("a changed version changes the hash", () => {
        assert.notEqual(new ComponentCatalog([SPEC]).hash, new ComponentCatalog([{ ...SPEC, version: "2" }]).hash);
    });

    test("rejects a duplicate name", () => {
        assert.throws(() => new ComponentCatalog([SPEC, { ...SPEC, template: "<p>other</p>" }]), /duplicate component name/);
    });

    test("rejects a component without a template", () => {
        assert.throws(
            () => new ComponentCatalog([{ name: "broken" } as never]),
            /needs a name and a template/,
        );
    });

    test("mixes authoring forms in one catalog", () => {
        const catalog = new ComponentCatalog([
            { name: "a-card", template: "<p>a</p>" },
            OrderCard,
            defineComponent({ name: "z-card", template: "<p>z</p>" }),
        ]);
        assert.deepEqual(catalog.definitions.map((d) => d.name), ["a-card", "order-card", "z-card"]);
    });
});
