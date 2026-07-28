---
sidebar_position: 3
title: Typed components
description: Bind a GenUI component name once and let the compiler check its props — mekik.component, mekik.mount, and a worked example of every component chativa registers out of the box.
---

# Typed components

[Generative UI](./generative-ui.md) sends a component as two values: a **name the client registered** and a **props JSON object**. That is all the wire ever carries. What this page adds is a typed view over that pair, so the props are checked at compile time instead of at render time — plus a worked example of each of the 13 components chativa's `@chativa/genui` package registers out of the box.

## Bind your own component

`mekik.component<Props>(name)` binds a registry name once and returns something callable. In .NET there is no per-component factory; you pass the name to `Shuttle.Ui` / `Shuttle.Mount` (the props dictionary is the parity-exact shape — see [Parity → Languages](../parity/languages.md)).

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
// Declare once, next to wherever you document the component's props.
const weather = mekik.component<{ city: string; temp: number }>("weather");

weather(ctx, { city: "İzmir", temp: 24 });          // emit it
weather(ctx, { city: "İzmir", temp: 24 }, { id: "wx" }); // …with an explicit chunk id
weather.name;                                        // "weather"
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
Shuttle.Ui(ctx, "weather", new Dictionary<string, object?> { ["city"] = "İzmir", ["temp"] = 24 });
Shuttle.Ui(ctx, "weather", props, id: "wx"); // …with an explicit chunk id
```

</TabItem>
</Tabs>

A typed component also gives you the other two places a name + props pair travels:

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
// .mount → a handle whose update() re-renders this same instance
const live = weather.mount(ctx, { city: "İzmir", temp: 24 });
live.update({ city: "İzmir", temp: 25 });

// .ref → the UiRef an interrupt mounts as its form
await mekik.approve(ctx, { title: "Correct?" }, { ui: weather.ref({ city: "İzmir", temp: 24 }) });
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
// Shuttle.Mount → a handle whose Update() re-renders this same instance
var live = Shuttle.Mount(ctx, "weather", new Dictionary<string, object?> { ["temp"] = 24 });
live.Update(new Dictionary<string, object?> { ["temp"] = 25 });

// GenUI.Ref → the UiRef an interrupt mounts as its form
await Shuttle.Approve<bool>(ctx, payload, ui: GenUI.Ref("weather", props));
```

</TabItem>
</Tabs>

## Chunk ids: updating in place

Every chunk emitter (`text`, `ui`, `event`) takes an optional id. **The same id updates that element in place** instead of appending a new one — that is how two instances of the *same* component stay distinct and individually updatable, and how a progress bar advances without stacking up thirteen bars.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.ui(ctx, "order-card", { id: "ORD-1", status: "loading" }, { id: "ORD-1" });
mekik.ui(ctx, "order-card", { id: "ORD-2", status: "loading" }, { id: "ORD-2" }); // a second card
mekik.ui(ctx, "order-card", { id: "ORD-1", status: "ready" },   { id: "ORD-1" }); // updates the first
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
Shuttle.Ui(ctx, "order-card", Props("ORD-1", "loading"), id: "ORD-1");
Shuttle.Ui(ctx, "order-card", Props("ORD-2", "loading"), id: "ORD-2"); // a second card
Shuttle.Ui(ctx, "order-card", Props("ORD-1", "ready"),   id: "ORD-1"); // updates the first
```

</TabItem>
</Tabs>

`mount` is the managed form: it mints a **replay-stable** id (`taskId` + call order, exactly like tool ids), so the replay pass after an interrupt re-emits the same id and the client updates the existing element rather than duplicating it. Omit ids entirely and the mapper assigns stream-scoped ones. Note that an explicit id also opts a chunk out of text-run coalescing ([Generative UI → stream lifecycle](./generative-ui.md#the-stream-lifecycle)).

## chativa's built-in components

`mekik.genui.*` / `GenUI.*` are the same factory applied to the components chativa registers out of the box — no client-side registration needed. Each is a full [typed component](#bind-your-own-component): callable, `.mount`-able, `.ref`-able (TS); in .NET the emitters live on `GenUI`, with `GenUI.Names.*` for the registry names and small builders (`GenUI.Field`, `GenUI.Step`, …) for the nested structures.

### Text block

Markdown-capable prose inside the GenUI stream.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.genui.text(ctx, { content: "**Done.** Your refund is on its way." });
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
GenUI.Text(ctx, "**Done.** Your refund is on its way.");
```

</TabItem>
</Tabs>

### Card

Title, optional image and description, optional action buttons.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.genui.card(ctx, {
  title: "ORD-42",
  description: "2 items · $249.90",
  image: "https://cdn.example/orders/ORD-42.png",
  actions: [{ label: "Track", value: "/track ORD-42" }],
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
GenUI.Card(ctx,
    title: "ORD-42",
    description: "2 items · $249.90",
    image: "https://cdn.example/orders/ORD-42.png",
    actions: [GenUI.CardAction("Track", "/track ORD-42")]);
```

</TabItem>
</Tabs>

### Form

Input fields with a submit button. A submit reaches the server as a `genui_event` — and when the form was mounted by an interrupt, it answers the pause ([Human-in-the-loop](./human-in-the-loop.md#answering)).

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.genui.form(ctx, {
  title: "Where should we ship it?",
  buttonText: "Save",
  fields: [
    { name: "address", label: "Address", type: "text", required: true },
    { name: "note", label: "Delivery note", type: "text", placeholder: "Optional" },
  ],
});

// …or as an interrupt's form, so the run waits for it:
const shipping = await mekik.approve<{ address: string }>(
  ctx,
  { title: "Shipping details" },
  { ui: mekik.genui.form.ref({ fields: [{ name: "address", label: "Address", type: "text" }] }) },
);
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
GenUI.Form(ctx,
    fields:
    [
        GenUI.Field("address", "Address", "text", required: true),
        GenUI.Field("note", "Delivery note", "text", placeholder: "Optional"),
    ],
    title: "Where should we ship it?",
    buttonText: "Save");

// …or as an interrupt's form, so the run waits for it:
var shipping = await Shuttle.Approve<Dictionary<string, object?>>(
    ctx,
    new Dictionary<string, object?> { ["title"] = "Shipping details" },
    ui: GenUI.FormRef([GenUI.Field("address", "Address", "text")]));
```

</TabItem>
</Tabs>

### Alert

A callout banner. `variant`: `info` | `success` | `warning` | `error`.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.genui.alert(ctx, {
  variant: "warning",
  title: "Partial refund",
  message: "One item is past its return window and was excluded.",
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
GenUI.Alert(ctx,
    message: "One item is past its return window and was excluded.",
    variant: "warning",
    title: "Partial refund");
```

</TabItem>
</Tabs>

### Quick replies

Tappable chips inside the stream. Tapping one sends its `value` as the next user turn. To *pause the run* on the chips instead, use [`mekik.choose`](./human-in-the-loop.md#buttons-typed-no-hand-written-json).

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.genui.quickReplies(ctx, {
  label: "Anything else?",
  items: [
    { label: "Track my order", value: "/track" },
    { label: "Talk to a human", value: "/agent" },
  ],
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
GenUI.QuickReplies(ctx,
    items: [GenUI.QuickReply("Track my order", "/track"), GenUI.QuickReply("Talk to a human", "/agent")],
    label: "Anything else?");
```

</TabItem>
</Tabs>

### List

An ordered or bulleted list, each entry with an optional icon and secondary line.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.genui.list(ctx, {
  title: "What happens next",
  ordered: true,
  items: [
    { text: "We receive the item", secondary: "1–3 business days" },
    { text: "Refund is issued", secondary: "Within 24h of receipt" },
  ],
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
GenUI.List(ctx,
    items:
    [
        GenUI.Item("We receive the item", secondary: "1–3 business days"),
        GenUI.Item("Refund is issued", secondary: "Within 24h of receipt"),
    ],
    title: "What happens next",
    ordered: true);
```

</TabItem>
</Tabs>

### Table

Columns plus rows of cells, in column order.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.genui.table(ctx, {
  title: "Recent orders",
  columns: ["Order", "Date", "Total"],
  rows: [
    ["ORD-42", "2026-07-14", 249.9],
    ["ORD-38", "2026-06-30", 89.0],
  ],
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
GenUI.Table(ctx,
    columns: ["Order", "Date", "Total"],
    rows: [["ORD-42", "2026-07-14", 249.9], ["ORD-38", "2026-06-30", 89.0]],
    title: "Recent orders");
```

</TabItem>
</Tabs>

### Rating

A star rating. A submit reaches the server as a `genui_event`; pass `readonly` to display a score rather than collect one.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.genui.rating(ctx, { title: "How did we do?", maxStars: 5 });
mekik.genui.rating(ctx, { title: "Seller rating", value: 4.5, readonly: true });
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
GenUI.Rating(ctx, title: "How did we do?", maxStars: 5);
GenUI.Rating(ctx, title: "Seller rating", value: 4.5, readOnly: true);
```

</TabItem>
</Tabs>

### Progress

A 0–100 bar. This is the component that most wants an id: mount it once, then advance it.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
const bar = mekik.genui.progress.mount(ctx, { label: "Processing refund", value: 0 });
await mekik.tool(ctx, "verify", { id: order.id }, () => Orders.verify(order.id));
bar.update({ label: "Processing refund", value: 60, caption: "Verified" });
await mekik.tool(ctx, "refund", { id: order.id }, () => Payments.refund(order.id));
bar.update({ label: "Processing refund", value: 100, variant: "success" });
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
GenUI.Progress(ctx, 0, label: "Processing refund", id: "refund-bar");
await Shuttle.Tool(ctx, "verify", p, () => Orders.Verify(order.Id));
GenUI.Progress(ctx, 60, label: "Processing refund", caption: "Verified", id: "refund-bar");
await Shuttle.Tool(ctx, "refund", p, () => Payments.Refund(order.Id));
GenUI.Progress(ctx, 100, label: "Processing refund", variant: "success", id: "refund-bar");
```

</TabItem>
</Tabs>

### Date picker

A date input; a pick reaches the server as a `genui_event`. Dates are ISO `YYYY-MM-DD` strings.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.genui.datePicker(ctx, { label: "Pick a delivery date", min: "2026-08-01", max: "2026-08-31" });
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
GenUI.DatePicker(ctx, label: "Pick a delivery date", min: "2026-08-01", max: "2026-08-31");
```

</TabItem>
</Tabs>

### Chart

Bar, line, or pie, with one or more datasets.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.genui.chart(ctx, {
  type: "line",
  title: "Spend, last 6 months",
  labels: ["Feb", "Mar", "Apr", "May", "Jun", "Jul"],
  datasets: [{ label: "You", data: [120, 90, 140, 80, 260, 249], color: "#7c3aed" }],
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
GenUI.Chart(ctx,
    type: "line",
    title: "Spend, last 6 months",
    labels: ["Feb", "Mar", "Apr", "May", "Jun", "Jul"],
    datasets: [GenUI.Dataset([120, 90, 140, 80, 260, 249], label: "You", color: "#7c3aed")]);
```

</TabItem>
</Tabs>

### Steps

A tracker whose entries are `done` | `active` | `pending`. Re-emit with the same id to advance it.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
const tracker = mekik.genui.steps.mount(ctx, {
  steps: [
    { label: "Requested", status: "done" },
    { label: "In review", status: "active", description: "Usually under an hour" },
    { label: "Refunded", status: "pending" },
  ],
});
// later in the same turn
tracker.update({
  steps: [
    { label: "Requested", status: "done" },
    { label: "In review", status: "done" },
    { label: "Refunded", status: "active" },
  ],
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
GenUI.Steps(ctx,
[
    GenUI.Step("Requested", "done"),
    GenUI.Step("In review", "active", description: "Usually under an hour"),
    GenUI.Step("Refunded", "pending"),
], id: "tracker");

// later in the same turn
GenUI.Steps(ctx,
[
    GenUI.Step("Requested", "done"),
    GenUI.Step("In review", "done"),
    GenUI.Step("Refunded", "active"),
], id: "tracker");
```

</TabItem>
</Tabs>

### Image gallery

A grid of images with optional captions.

<Tabs groupId="lang">
<TabItem value="ts" label="TypeScript">

```ts
mekik.genui.imageGallery(ctx, {
  columns: 3,
  images: [
    { src: "https://cdn.example/kettle-1.png", alt: "Kettle, front", caption: "Front" },
    { src: "https://cdn.example/kettle-2.png", alt: "Kettle, side" },
  ],
});
```

</TabItem>
<TabItem value="dotnet" label=".NET">

```csharp
GenUI.ImageGallery(ctx,
    images:
    [
        GenUI.Image("https://cdn.example/kettle-1.png", alt: "Kettle, front", caption: "Front"),
        GenUI.Image("https://cdn.example/kettle-2.png", alt: "Kettle, side"),
    ],
    columns: 3);
```

</TabItem>
</Tabs>

## Where to go next

- [**Messages**](./messages.md) — the other rendering path: standalone transcript entries (image, card, carousel…).
- [**Human-in-the-loop**](./human-in-the-loop.md) — mounting a form as an interrupt's `ui`, and `mekik.choose` for typed buttons that pause the run.
- [**Generative UI**](./generative-ui.md) — the chunk model these components ride on.
