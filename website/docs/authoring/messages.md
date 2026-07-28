---
sidebar_position: 4
title: Rich messages
description: Send standalone transcript entries — images, cards, buttons, carousels — as rich message frames, with a worked example of every message type chativa renders out of the box.
---

# Rich messages

A chativa conversation is rendered out of **messages**, each dispatched to a renderer by its `type`: `"image"`, `"card"`, `"buttons"`, `"carousel"`, and so on (chativa's `MessageTypeRegistry`). mekik carries one as a **rich message frame** — the `text` frame's envelope under the renderer's name, with the renderer's payload as `data`:

```jsonc
{ "type": "image", "id": "msg-7", "seq": 12, "from": "bot",
  "data": { "src": "https://…/receipt.png", "caption": "Your receipt" },
  "timestamp": 1750000000000 }
```

These frames are **persistent**: same `seq`, transcript, replay, and watermark rules as `text` (PROTOCOL.md §4.5). They are the one open extension to the persistent-frame list — a client with no renderer for the `type` simply ignores the frame.

## Messages or components?

Both render UI; they differ in what they *are*.

| | [**Components**](./components.md) (`genui`) | **Messages** (this page) |
| --- | --- | --- |
| lives | inside one turn's evolving message | as its own transcript entry |
| updatable | yes — re-emit the same chunk id | no — it's a transcript entry |
| use for | progress bars, charts the node fills in, forms the run waits on | images, cards, carousels, file attachments |

Rule of thumb: **a component** when the thing evolves with the turn, **a message** when it stands on its own in the conversation.

## Emitting one

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
// The low-level form: any renderer name + its payload.
mekik.message(ctx, "image", { src: receiptUrl, caption: "Your receipt" });
mekik.message(ctx, "image", { src: receiptUrl }, { id: "receipt-ORD-42" }); // a stable message id

// Bind a custom type once, so its data is compiler-checked at every call site.
const receipt = mekik.messageKind<{ orderId: string; totalCents: number }>("receipt");
receipt(ctx, { orderId: "ORD-42", totalCents: 24990 });
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
// The low-level form: any renderer name + its payload.
Shuttle.Message(ctx, "image", new Dictionary<string, object?>
{
    ["src"] = receiptUrl,
    ["caption"] = "Your receipt",
});

// …with a stable message id
Shuttle.Message(ctx, "image", props, id: "receipt-ORD-42");
```

</TabItem>
</Tabs>

Omit the id and mekik mints one; supply it when you want messages deterministically addressable (keyed by an order id, say).

Two rules to know before reaching for a message:

- **Reserved types are refused.** The `type` may not be one of the protocol's own frame types (`genui`, `interrupt`, `run`, `welcome`, `typing`, …) — the helper throws. `"text"` is the deliberate exception: it emits a regular `text` frame, so the text renderer's extras (like `urls` for link previews) go in `data`.
- **Interaction comes back as input, not as a special frame.** A tapped button, chip, or card action arrives as the **next user turn** — the action's `value`, or its label when there is none. To pause the run *on* the buttons and resume with the pick, use [`mekik.choose`](./human-in-the-loop.md#buttons-typed-no-hand-written-json) instead.

## chativa's built-in message types

`mekik.messages.*` / `Messages.*` bind the types chativa renders out of the box.

### Text (with link previews)

The plain text message — worth using explicitly when you want link previews under the bubble. `previewVariant`: `compact` (default) | `expanded`.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.messages.text(ctx, {
  text: "Here's the policy you asked about:",
  urls: ["https://example.com/returns-policy"],
  previewVariant: "expanded",
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
Messages.Text(ctx,
    "Here's the policy you asked about:",
    urls: ["https://example.com/returns-policy"],
    previewVariant: "expanded");
```

</TabItem>
</Tabs>

### Image

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.messages.image(ctx, {
  src: "https://cdn.example/receipts/ORD-42.png",
  alt: "Refund receipt for ORD-42",
  caption: "Your receipt",
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
Messages.Image(ctx,
    "https://cdn.example/receipts/ORD-42.png",
    alt: "Refund receipt for ORD-42",
    caption: "Your receipt");
```

</TabItem>
</Tabs>

### Card

A hero card with an optional image and action buttons. A tapped button sends its `value` as the next user turn.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.messages.card(ctx, {
  title: "ORD-42",
  subtitle: "2 items · $249.90 · delivered",
  image: "https://cdn.example/orders/ORD-42.png",
  buttons: [
    { label: "Track", value: "/track ORD-42" },
    { label: "Return", value: "/return ORD-42" },
  ],
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
Messages.Card(ctx,
    title: "ORD-42",
    subtitle: "2 items · $249.90 · delivered",
    image: "https://cdn.example/orders/ORD-42.png",
    buttons: [Messages.Button("Track", "/track ORD-42"), Messages.Button("Return", "/return ORD-42")]);
```

</TabItem>
</Tabs>

### Buttons

A vertical list of full-width buttons under a text bubble. By default the list collapses to the choice once tapped; `persistent` keeps them tappable so the user can change their mind.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.messages.buttons(ctx, {
  text: "What would you like to do?",
  buttons: [
    { label: "Track an order", value: "/track" },
    { label: "Start a return", value: "/return" },
    { label: "Something else" }, // no value → the label is sent
  ],
});

mekik.messages.buttons(ctx, {
  text: "Delivery speed",
  persistent: true, // stays re-selectable
  buttons: [{ label: "Standard", value: "std" }, { label: "Express", value: "exp" }],
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
Messages.Buttons(ctx,
    buttons:
    [
        Messages.Button("Track an order", "/track"),
        Messages.Button("Start a return", "/return"),
        Messages.Button("Something else"), // no value → the label is sent
    ],
    text: "What would you like to do?");

Messages.Buttons(ctx,
    buttons: [Messages.Button("Standard", "std"), Messages.Button("Express", "exp")],
    text: "Delivery speed",
    persistent: true); // stays re-selectable
```

</TabItem>
</Tabs>

### Quick reply

A text bubble with chips. One-time by default; `keepActions` leaves them rendered so the transcript still reads as a record of what was asked and answered.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.messages.quickReply(ctx, {
  text: "Did that solve it?",
  actions: [{ label: "Yes, thanks" }, { label: "No", value: "/agent" }],
  keepActions: true,
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
Messages.QuickReply(ctx,
    "Did that solve it?",
    actions: [Messages.Button("Yes, thanks"), Messages.Button("No", "/agent")],
    keepActions: true);
```

</TabItem>
</Tabs>

### File

A downloadable attachment card. `size` is in bytes; the renderer formats it and picks an icon from the name and MIME type.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.messages.file(ctx, {
  url: "https://cdn.example/invoices/ORD-42.pdf",
  name: "invoice-ORD-42.pdf",
  size: 248_320,
  mimeType: "application/pdf",
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
Messages.File(ctx,
    "https://cdn.example/invoices/ORD-42.pdf",
    "invoice-ORD-42.pdf",
    size: 248_320,
    mimeType: "application/pdf");
```

</TabItem>
</Tabs>

### Video

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.messages.video(ctx, {
  src: "https://cdn.example/howto/return-packing.mp4",
  poster: "https://cdn.example/howto/return-packing.jpg",
  caption: "How to pack your return",
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
Messages.Video(ctx,
    "https://cdn.example/howto/return-packing.mp4",
    poster: "https://cdn.example/howto/return-packing.jpg",
    caption: "How to pack your return");
```

</TabItem>
</Tabs>

### Carousel

A horizontally scrollable row of cards — the natural shape for search results or a product list.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.messages.carousel(ctx, {
  cards: products.map((p) => ({
    title: p.name,
    subtitle: `$${p.price}`,
    image: p.imageUrl,
    buttons: [{ label: "Add to cart", value: `/add ${p.sku}` }],
  })),
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
Messages.Carousel(ctx, products
    .Select(p => (object)Messages.CarouselCard(
        p.Name,
        subtitle: $"${p.Price}",
        image: p.ImageUrl,
        buttons: [Messages.Button("Add to cart", $"/add {p.Sku}")]))
    .ToList());
```

</TabItem>
</Tabs>

## A message-driven turn, end to end

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
.node("order-status", async (s, ctx) => {
  const order = await mekik.tool(ctx, "get_order", { id: s.input }, () => Orders.get(s.input));

  mekik.messages.card(ctx, {
    title: order.id,
    subtitle: `${order.items.length} items · $${order.total}`,
    buttons: [{ label: "Track", value: `/track ${order.id}` }],
  }, { id: `card-${order.id}` });

  if (order.invoiceUrl) {
    mekik.messages.file(ctx, { url: order.invoiceUrl, name: `invoice-${order.id}.pdf`, mimeType: "application/pdf" });
  }

  return { reply: `Here's ${order.id}.` };
})
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
.Node("order-status", async (State s, IContext ctx) =>
{
    var id = s.Get<string>("input");
    var order = await Shuttle.Tool(ctx, "get_order", new Dictionary<string, object?> { ["id"] = id }, () => Orders.Get(id));

    Messages.Card(ctx,
        title: order.Id,
        subtitle: $"{order.Items.Count} items · ${order.Total}",
        buttons: [Messages.Button("Track", $"/track {order.Id}")],
        id: $"card-{order.Id}");

    if (order.InvoiceUrl is not null)
    {
        Messages.File(ctx, order.InvoiceUrl, $"invoice-{order.Id}.pdf", mimeType: "application/pdf");
    }

    return Update.Of("reply", $"Here's {order.Id}.");
})
```

</TabItem>
</Tabs>

Each message lands as its own persistent frame, in emit order, before the turn's consolidated reply — and all of them replay on reconnect.

## Where to go next

- [**Typed components**](./components.md) — the other rendering path, for UI that evolves with the turn.
- [**Human-in-the-loop**](./human-in-the-loop.md) — buttons that pause the run and resume with the pick.
- [**Protocol → Frames**](../protocol/frames.md) — where rich message frames sit among the rest.
