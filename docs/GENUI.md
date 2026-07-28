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
var live = Shuttle.Mount(ctx, "weather", new Dictionary<string, object?> { ["temp"] = 24 });
live.Update(new Dictionary<string, object?> { ["temp"] = 25 });
await Shuttle.Approve<bool>(ctx, payload, ui: GenUI.Ref("weather", props));
```

### Chunk ids — updating in place

Every chunk emitter takes an optional id (`{ id }` in TS, `id:` in .NET).
Same id ⇒ the client updates that element instead of appending a new one.
Omit it and the mapper assigns stream-scoped ids; `mount` mints replay-stable
ones (`taskId` + call order, like tool ids) so a resume pass upserts rather than
duplicating. An explicit id also opts a chunk out of text-run coalescing
(PROTOCOL.md §4.1).

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

Two rules worth knowing before you reach for one:

- **Reserved types.** The `type` may not be one of the protocol's own frame
  types; the helpers throw. `"text"` is the deliberate exception (it emits a
  regular `text` frame, with the text renderer's extras like `urls` in `data`).
- **Interaction is input, not a frame.** A tapped button/chip/card action comes
  back as the **next user turn** (its `value`, or the label) — or as the
  `resume` answer when the run is parked. To pause *on* the buttons, use
  `mekik.choose` (see [HITL.md](HITL.md#buttons-typed-no-hand-written-json)).
