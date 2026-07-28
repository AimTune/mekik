// Unit tests for the typed GenUI layer: `component<P>(name)` and the chativa
// built-in catalog. The contract under test is thin by design — everything must
// compile down to the exact `$mekik:"genui"` ui-chunk payloads `mekik.ui` emits
// (component name + props JSON; nothing new on the wire).

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import type { Context } from "@ilmek/core";

import { component, genui } from "../src/genui.ts";

function recordingCtx() {
    const emitted: Array<Record<string, unknown>> = [];
    const ctx = { emit: (p: unknown) => emitted.push(p as Record<string, unknown>) } as unknown as Context<any>;
    return { ctx, emitted };
}

describe("mekik.component", () => {
    test("emits a plain ui chunk with the bound name and typed props", () => {
        const { ctx, emitted } = recordingCtx();
        const weather = component<{ city: string; temp: number }>("weather");

        weather(ctx, { city: "İzmir", temp: 24 });
        weather(ctx, { city: "İzmir", temp: 25 }, { id: "wx" });

        assert.equal(weather.name, "weather");
        assert.deepEqual(emitted, [
            { $mekik: "genui", chunk: { type: "ui", component: "weather", props: { city: "İzmir", temp: 24 } } },
            { $mekik: "genui", chunk: { type: "ui", component: "weather", props: { city: "İzmir", temp: 25 }, id: "wx" } },
        ]);
    });

    test("mount returns a typed handle that updates the same chunk id", () => {
        const { ctx, emitted } = recordingCtx();
        const weather = component<{ temp: number }>("weather");

        const live = weather.mount(ctx, { temp: 20 });
        live.update({ temp: 21 });

        const ids = emitted.map((e) => (e.chunk as { id?: unknown }).id);
        assert.equal(ids.length, 2);
        assert.equal(ids[0], ids[1]);
        assert.equal(ids[0], live.id);
    });

    test("ref builds the UiRef an interrupt mounts as its form", () => {
        const form = component<{ fields: string[] }>("booking-form");
        assert.deepEqual(form.ref({ fields: ["date"] }), {
            component: "booking-form",
            props: { fields: ["date"] },
        });
    });
});

describe("mekik.genui (chativa built-ins)", () => {
    test("every catalog entry is bound to chativa's registered component name", () => {
        assert.deepEqual(
            Object.fromEntries(Object.entries(genui).map(([key, c]) => [key, c.name])),
            {
                text: "genui-text",
                card: "genui-card",
                form: "genui-form",
                alert: "genui-alert",
                quickReplies: "genui-quick-replies",
                list: "genui-list",
                table: "genui-table",
                rating: "genui-rating",
                progress: "genui-progress",
                datePicker: "genui-date-picker",
                chart: "genui-chart",
                steps: "genui-steps",
                imageGallery: "genui-image-gallery",
            },
        );
    });

    test("props pass through untouched — the client stays the schema authority", () => {
        const { ctx, emitted } = recordingCtx();

        genui.table(ctx, { title: "Orders", columns: ["id", "total"], rows: [["ORD-1", 249.9]] });
        genui.steps(ctx, { steps: [{ label: "Paid", status: "done" }, { label: "Shipped", status: "active" }] });

        assert.deepEqual(
            emitted.map((e) => e.chunk),
            [
                {
                    type: "ui",
                    component: "genui-table",
                    props: { title: "Orders", columns: ["id", "total"], rows: [["ORD-1", 249.9]] },
                },
                {
                    type: "ui",
                    component: "genui-steps",
                    props: { steps: [{ label: "Paid", status: "done" }, { label: "Shipped", status: "active" }] },
                },
            ],
        );
    });

    test("a mounted progress bar updates in place by its stable id", () => {
        const { ctx, emitted } = recordingCtx();

        const bar = genui.progress.mount(ctx, { label: "Deploying", value: 0 });
        bar.update({ label: "Deploying", value: 60, caption: "rolling out" });

        const chunks = emitted.map((e) => e.chunk as Record<string, unknown>);
        assert.equal(chunks[0]?.component, "genui-progress");
        assert.equal(chunks[0]?.id, chunks[1]?.id);
        assert.deepEqual(chunks[1]?.props, { label: "Deploying", value: 60, caption: "rolling out" });
    });
});
