# Rendering: components and messages

mekik ships **no** UI. What it ships is the two ways a graph tells a client what
to render, both typed on the authoring side and both plain JSON on the wire:

| | **GenUI components** | **Rich messages** |
| --- | --- | --- |
| helper | `mekik.ui` / `mekik.component` / `mekik.genui` | `mekik.message` / `mekik.messageKind` / `mekik.messages` |
| frame | `genui` chunk in the turn's stream | its own persistent frame (PROTOCOL.md §4.5) |
| client registry | chativa `GenUIRegistry` | chativa `MessageTypeRegistry` |
| lives | inside one turn's evolving message | as its own transcript entry |
| updatable | yes — re-emit the same chunk `id` | no — a message is a transcript entry |

Rule of thumb: **a component** when the thing evolves with the turn (a progress
bar, a chart the node fills in, a form the run is waiting on); **a message** when
it is a standalone entry in the conversation (an image, a card, a carousel).

Both are the same pair of values: a **name the client registered** plus a **JSON
payload**. The typed helpers below only bind the name and check the payload —
they add nothing to the wire.

---

## 1. GenUI components

### Your own component

`mekik.component<Props>(name)` (TS) binds a registry name once and returns a
callable that emits it, `.mount`s it for in-place updates, and `.ref`s it for an
interrupt form. In .NET, call `Shuttle.Ui` / `Shuttle.Mount` / `GenUI.Ref` with
the name.

```ts
const weather = mekik.component<{ city: string; temp: number }>("weather");

weather(ctx, { city: "İzmir", temp: 24 });                 // emit
const live = weather.mount(ctx, { city: "İzmir", temp: 24 }); // emit + handle
live.update({ city: "İzmir", temp: 25 });                   // same chunk id → in place
await mekik.approve(ctx, { title: "Right?" }, { ui: weather.ref({ city: "İzmir", temp: 24 }) });
```

```csharp
Shuttle.Ui(ctx, "weather", new Dictionary<string, object?> { ["city"] = "İzmir", ["temp"] = 24 });
var live = Shuttle.Mount(ctx, "weather", new Dictionary<string, object?> { ["city"] = "İzmir", ["temp"] = 24 });
live.Update(new Dictionary<string, object?> { ["city"] = "İzmir", ["temp"] = 25 });
await Shuttle.Approve<bool>(ctx, payload, ui: GenUI.Ref("weather", props));
```

### A component the server defines

Everything above names a component the **client** already registered. mekik can
also ship the component itself — markup, styles and prop defaults travel once on
connect, chativa registers each definition as a custom element, and a plain `ui`
chunk mounts it from then on. Adding a widget becomes a server deploy.

```ts
const orderCard = defineComponent({
    name: "order-card",
    template: `<h3>{{title}}</h3>
        {{#each lines}}<p>{{this.label}} — {{this.price}} ₺</p>{{/each}}
        <button data-event="track_order" data-payload='{"id":"{{id}}"}'>Track</button>`,
    css: `h3 { margin: 0 0 8px; }`,
    props: { id: "", title: "", lines: [] as Array<{ label: string; price: number }> },
});

const app = mekik({ graph, components: [orderCard] });
orderCard(ctx, { id: "ORD-42", title: "Order ORD-42", lines });  // typed emitter
```

```csharp
sealed class OrderCard : GenUiComponent
{
    public override string Name => "order-card";
    public override string Template => "<h3>{{title}}</h3>";
    public override IReadOnlyDictionary<string, object?>? Props =>
        new Dictionary<string, object?> { ["title"] = "" };
}

var app = new MekikApp(new MekikOptions { Graph = graph, Components = [new OrderCard()] });
new OrderCard().Emit(ctx, new Dictionary<string, object?> { ["title"] = "Order ORD-42" });
```

The catalog is versioned by a hash the client caches and hands back in `hello`, so
the markup travels once and an unchanged catalog costs one tiny frame. Templates
support `{{value}}`, `{{#if}}` and `{{#each}}`; every interpolation is escaped and
the client sanitizes the result. Full rules: PROTOCOL.md §10. Runnable:
`ts/examples/server-components.ts`, `dotnet/examples/Mekik.ServerComponents`.

### Making a component's buttons do something

A button in a definition's markup declares who it is talking to, and that attribute
is the whole routing model:

| markup | who receives it |
| --- | --- |
| `component-event="rate_delivery"` | the node parked on `onEvent` / `OnEvent` waiting for that name — nothing else |
| `mekik-event="track_order"` | the app's `onGenUiEvent` / `OnGenUiEvent`, which may start a turn |
| `data-event="…"` | tries the component route first, then the graph one (the original form, still supported) |

Neither one does anything on its own: a frame nobody is waiting for and no handler
claims is accepted and dropped. A decorative button costs nothing.

#### `component-event` — a node waiting on its own widget

`onEvent` is `approve` for widgets. The run parks, but a button on a component
already on screen answers it instead of chips in the chat:

```ts
deliveryCard(ctx, props, { id: "card-1" });                 // mount it first
const rating = await mekik.onEvent<{ stars: number }>(ctx, "rate_delivery");
```

```csharp
Shuttle.Ui(ctx, "delivery-card", props, id: "card-1");
var rating = await Shuttle.OnEvent<IReadOnlyDictionary<string, object?>>(ctx, "rate_delivery");
```

It is an ordinary interrupt, so it inherits everything a pause already gives you:
the thread is checkpointed, the wait survives a disconnect or restart, and
`welcome.pending` re-announces it on reconnect. The `interrupt` frame carries
`data.event` — the name it waits for — so the client knows to wait for the widget
rather than render Approve/Cancel. The node re-runs from the top on resume, so
journal your side effects and use literal chunk ids, exactly as around any other
pause.

The pause the node is holding *is* the binding, so nothing has to carry an interrupt
id — which is what makes this different from mounting a form on an interrupt's `ui`.

#### `mekik-event` — a click the graph should answer

For the other case: a widget whose turn is long over, and a click that should start a
new one.

```ts
mekik({
    graph,
    components: [orderCard],
    onGenUiEvent: (ev) =>
        ev.eventType === "track_order" ? { input: `track ${(ev.payload as { id: string }).id}` } : undefined,
});
```

```csharp
new MekikOptions
{
    Graph = graph,
    Components = [new OrderCard()],
    OnGenUiEvent = ev => ev switch
    {
        { EventType: "track_order", Payload: IReadOnlyDictionary<string, object?> p }
            when p.GetValueOrDefault("id") is string id =>
                new Dictionary<string, object?> { ["input"] = $"track {id}" },
        _ => null,
    },
};
```

Return an input update to run a turn on the interaction; return `undefined`/`null`
to ignore it. This is `input` for components — a mapper, not a place to do work.
Side effects belong in the node the turn reaches, where the journal makes them
exactly-once.

The turn plays by the ordinary rules: one at a time (`error{busy}`), never over an
open pause (`error{interrupted}`), and no `text` frame is written on the user's
behalf — a click is not something they said. One interaction never reaches the
handler at all: a `submit` whose payload `id` names an open interrupt is coerced to a
`resume` (PROTOCOL.md §4.4), which is how a form mounted by an `interrupt` answers
that interrupt. That direct address outranks the scope.

Both examples show all three routes end to end: `ts/examples/server-components.ts`,
`dotnet/examples/Mekik.ServerComponents`.

### Chunk ids — updating in place

Every chunk emitter takes an optional id (`{ id }` in TS, `id:` in .NET).
Same id ⇒ the client updates that element instead of appending a new one.
Omit it and the mapper assigns stream-scoped ids; `mount` mints replay-stable
ones (`taskId` + call order, like tool ids) so a resume pass upserts rather than
duplicating. An explicit id also opts a chunk out of text-run coalescing
(PROTOCOL.md §4.1).

Two practical rules once a component is meant to *change* while the user watches:

- **Pace the updates.** Chunks emitted back-to-back render as one state: the
  element appears already finished. Put real time between them if the movement
  is the point.
- **Journal emissions that precede a pause.** A resume replays the node from the
  top, and emitting is a side effect — wrap each beat in `ctx.step` /
  `ctx.StepAsync` so the replay does not walk the client back through states it
  already rendered, and use literal chunk ids across the pause (a counter-minted
  id drifts once its call site stops running).

A mounted component outlives an interrupt: it stays on screen while the chips
render, so the human's answer can re-render the very widget they are looking at.
That pattern — progress, pause, answer, update in place — is
`ts/examples/server-components.ts` and `dotnet/examples/Mekik.ServerComponents`.

### chativa's built-in components

`mekik.genui.*` (TS) / `GenUI.*` (.NET) cover the 13 components chativa's
`@chativa/genui` registers out of the box — no client-side registration needed.

| helper | registry name |
| --- | --- |
| `genui.text` / `GenUI.Text` | `genui-text` |
| `genui.card` / `GenUI.Card` | `genui-card` |
| `genui.form` / `GenUI.Form` | `genui-form` |
| `genui.alert` / `GenUI.Alert` | `genui-alert` |
| `genui.quickReplies` / `GenUI.QuickReplies` | `genui-quick-replies` |
| `genui.list` / `GenUI.List` | `genui-list` |
| `genui.table` / `GenUI.Table` | `genui-table` |
| `genui.rating` / `GenUI.Rating` | `genui-rating` |
| `genui.progress` / `GenUI.Progress` | `genui-progress` |
| `genui.datePicker` / `GenUI.DatePicker` | `genui-date-picker` |
| `genui.chart` / `GenUI.Chart` | `genui-chart` |
| `genui.steps` / `GenUI.Steps` | `genui-steps` |
| `genui.imageGallery` / `GenUI.ImageGallery` | `genui-image-gallery` |

A worked example of every one lives in the website guide,
[Authoring → Components](../website/docs/authoring/components.md).

---

## 2. Rich messages

A rich message is a persistent frame whose `type` names a client **message
renderer** and whose `data` is that renderer's payload (PROTOCOL.md §4.5). It
joins the transcript, replays on reconnect, and advances the watermark — like
`text`.

```ts
mekik.message(ctx, "image", { src: receiptUrl, caption: "Your receipt" });
const receipt = mekik.messageKind<{ orderId: string }>("receipt"); // your own type
receipt(ctx, { orderId: "ORD-42" });
```

```csharp
Shuttle.Message(ctx, "image", new Dictionary<string, object?> { ["src"] = receiptUrl });
```

`mekik.messages.*` / `Messages.*` cover chativa's built-in message renderers:
`text`, `image`, `card`, `buttons`, `quickReply`, `file`, `video`, `carousel`.
Again, every one is worked through in
[Authoring → Messages](../website/docs/authoring/messages.md).

Every type also has a **describe** form for the places that send a message
without a node's `ctx` — the greeting being the standing example, since it fires
on connect, outside any run:

```ts
mekik({ graph, greeting: (conv) => [
    `Hi ${conv.userId}!`,
    mekik.messages.buttons.spec({ buttons: [{ label: "Track an order", value: "/track" }] }),
]});
```

```csharp
new MekikApp(new MekikOptions { Graph = g, Greeting = conv => new object[]
{
    $"Hi {conv.UserId}!",
    Messages.ButtonsSpec([Messages.Button("Track an order", "/track")]),
}});
```

`messages.card.spec(data)` / `Messages.CardSpec(…)` — same parameters as the
emitter, minus the `ctx`. A greeting takes a string, one spec, or a list mixing
both, delivered in order; each lands as its own persistent frame. GenUI
components are deliberately not accepted there: a chunk belongs to a turn's
stream, and there is no stream on connect.

Two rules worth knowing before you reach for one:

- **Reserved types.** The `type` may not be one of the protocol's own frame
  types; the helpers throw. `"text"` is the deliberate exception (it emits a
  regular `text` frame, with the text renderer's extras like `urls` in `data`).
- **Interaction is input, not a frame.** A tapped button/chip/card action comes
  back as the **next user turn** (its `value`, or the label) — or as the
  `resume` answer when the run is parked. To pause *on* the buttons, use
  `mekik.choose` (see [HITL.md](HITL.md#buttons-typed-no-hand-written-json)).
