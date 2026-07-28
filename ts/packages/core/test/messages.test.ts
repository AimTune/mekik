// Unit tests for the typed rich-message layer: `message`, `messageKind`, and the
// chativa built-in catalog. The mapper side (custom payload → persistent frame,
// reserved-type drop, id override) is pinned cross-language by the
// `rich-message` golden fixture; these tests cover the author-facing surface.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import type { Context } from "@ilmek/core";

import { message, messageKind, messages } from "../src/messages.ts";

function recordingCtx() {
    const emitted: Array<Record<string, unknown>> = [];
    const ctx = { emit: (p: unknown) => emitted.push(p as Record<string, unknown>) } as unknown as Context<any>;
    return { ctx, emitted };
}

describe("mekik.message / messageKind", () => {
    test("emits the $mekik message payload, with the id only when given", () => {
        const { ctx, emitted } = recordingCtx();

        message(ctx, "image", { src: "https://x/y.png" });
        message(ctx, "image", { src: "https://x/y.png" }, { id: "receipt-1" });

        assert.deepEqual(emitted, [
            { $mekik: "message", messageType: "image", data: { src: "https://x/y.png" } },
            { $mekik: "message", messageType: "image", data: { src: "https://x/y.png" }, id: "receipt-1" },
        ]);
    });

    test("reserved protocol frame types are rejected; text is the allowed overlap", () => {
        const { ctx, emitted } = recordingCtx();

        for (const reserved of ["genui", "interrupt", "run", "welcome", "typing"]) {
            assert.throws(() => message(ctx, reserved, {}), TypeError);
        }
        message(ctx, "text", { text: "hi", urls: ["https://example.test"] });

        assert.equal(emitted.length, 1);
        assert.equal(emitted[0]?.messageType, "text");
    });

    test("messageKind binds a custom type once, typed at the call site", () => {
        const { ctx, emitted } = recordingCtx();
        const receipt = messageKind<{ orderId: string; totalCents: number }>("receipt");

        receipt(ctx, { orderId: "ORD-42", totalCents: 24990 });

        assert.equal(receipt.type, "receipt");
        assert.deepEqual(emitted, [
            { $mekik: "message", messageType: "receipt", data: { orderId: "ORD-42", totalCents: 24990 } },
        ]);
    });
});

describe("mekik.messages (chativa built-ins)", () => {
    test("every catalog entry is bound to chativa's registered message type", () => {
        assert.deepEqual(
            Object.fromEntries(Object.entries(messages).map(([key, m]) => [key, m.type])),
            {
                text: "text",
                image: "image",
                card: "card",
                buttons: "buttons",
                quickReply: "quick-reply",
                file: "file",
                video: "video",
                carousel: "carousel",
            },
        );
    });

    test("typed data passes through untouched", () => {
        const { ctx, emitted } = recordingCtx();

        messages.buttons(ctx, {
            text: "Choose an option:",
            persistent: true,
            buttons: [{ label: "Option A" }, { label: "Option B", value: "/b" }],
        });
        messages.carousel(ctx, { cards: [{ title: "Kettle", image: "https://x/k.png" }] }, { id: "catalog" });

        assert.deepEqual(emitted, [
            {
                $mekik: "message",
                messageType: "buttons",
                data: {
                    text: "Choose an option:",
                    persistent: true,
                    buttons: [{ label: "Option A" }, { label: "Option B", value: "/b" }],
                },
            },
            {
                $mekik: "message",
                messageType: "carousel",
                data: { cards: [{ title: "Kettle", image: "https://x/k.png" }] },
                id: "catalog",
            },
        ]);
    });
});
