using Ilmek;

namespace Mekik;

/// <summary>
/// Typed emitters for chativa's built-in message types (<c>image</c>, <c>card</c>,
/// <c>buttons</c>, <c>carousel</c>, …) — mirror of the TypeScript
/// <c>mekik.messages</c> catalog.
///
/// <para>These are <i>messages</i>, not GenUI: persistent transcript entries
/// rendered by chativa's message components — they replay on reconnect and
/// advance the watermark, like <c>text</c>. Each method builds the renderer's
/// camelCase data dictionary and hands it to <see cref="Shuttle.Message"/>
/// (the dictionary shape keeps canonical-JSON parity with TypeScript exact). For
/// a custom message type of your own, call <see cref="Shuttle.Message"/> with its
/// registered name.</para>
///
/// <para>Every type comes in two forms: <c>Card(ctx, …)</c> <b>emits</b> from a node,
/// and <c>CardSpec(…)</c> <b>describes</b> the same message as a value, for the places
/// that send one without a <c>ctx</c> — the greeting (<see cref="MekikOptions.Greeting"/>)
/// being the standing example. The TypeScript sibling is <c>messages.card.spec(…)</c>.</para>
///
/// <para>A tapped button/chip/card action arrives back as the <b>next user
/// turn</b> (its value — or label — as the turn's text), or as the <c>resume</c>
/// answer when the run is parked on an interrupt; for buttons that pause the run
/// use <c>Shuttle.Choose</c>.</para>
/// </summary>
public static class Messages
{
    private static Dictionary<string, object?> Data(params (string Key, object? Value)[] pairs)
    {
        var data = new Dictionary<string, object?>();
        foreach (var (key, value) in pairs)
        {
            if (value is not null) data[key] = value;
        }
        return data;
    }

    /// <summary>
    /// Describe a rich message without emitting it — <c>{ type, data, id? }</c>, the value
    /// form of <see cref="Shuttle.Message"/>. Mirror of TypeScript <c>mekik.messageSpec</c>.
    /// </summary>
    /// <remarks>
    /// Same rules as <see cref="Shuttle.Message"/>: <c>"text"</c> is allowed (it describes a
    /// regular text frame); the protocol's other frame types are reserved and throw.
    /// </remarks>
    /// <param name="type">The client message-renderer name.</param>
    /// <param name="data">The renderer's payload.</param>
    /// <param name="id">Optional stable message id; omit and mekik mints one.</param>
    public static IReadOnlyDictionary<string, object?> Spec(
        string type,
        IReadOnlyDictionary<string, object?> data,
        string? id = null)
    {
        if (Protocol.ReservedFrameTypes.Contains(type) && type != "text")
            throw new ArgumentException($"\"{type}\" is a reserved protocol frame type, not a message type", nameof(type));
        var spec = new Dictionary<string, object?> { ["type"] = type, ["data"] = data };
        if (id is not null) spec["id"] = id;
        return spec;
    }

    /// <summary>Emit a spec built by one of the <c>…Spec</c> builders.</summary>
    private static void Emit(IContext ctx, IReadOnlyDictionary<string, object?> spec) =>
        Shuttle.Message(
            ctx,
            (string)spec["type"]!,
            (IReadOnlyDictionary<string, object?>)spec["data"]!,
            spec.GetValueOrDefault("id") as string);

    // ── item builders ─────────────────────────────────────────────────────────

    /// <summary>One message-level button: <c>{ label, value? }</c>. The value
    /// (default: the label) comes back as the next user turn's text.</summary>
    public static IReadOnlyDictionary<string, object?> Button(string label, string? value = null) =>
        Data(("label", label), ("value", value));

    /// <summary>One carousel card. Build <paramref name="buttons"/> with <see cref="Button"/>.</summary>
    public static IReadOnlyDictionary<string, object?> CarouselCard(
        string title,
        string? subtitle = null,
        string? image = null,
        IReadOnlyList<object>? buttons = null) =>
        Data(("title", title), ("subtitle", subtitle), ("image", image), ("buttons", buttons));

    // ── the message types: <Type>Spec describes, <Type> emits ─────────────────

    /// <summary>Describe a text message, optionally with link previews under the bubble.
    /// <paramref name="previewVariant"/>: <c>compact</c> | <c>expanded</c>.</summary>
    public static IReadOnlyDictionary<string, object?> TextSpec(
        string text,
        IReadOnlyList<string>? urls = null,
        string? previewVariant = null,
        string? id = null) =>
        Spec("text", Data(("text", text), ("urls", urls), ("previewVariant", previewVariant)), id);

    /// <summary>Emit a text message. See <see cref="TextSpec"/>.</summary>
    public static void Text(
        IContext ctx,
        string text,
        IReadOnlyList<string>? urls = null,
        string? previewVariant = null,
        string? id = null) =>
        Emit(ctx, TextSpec(text, urls, previewVariant, id));

    /// <summary>Describe an image bubble with optional caption.</summary>
    public static IReadOnlyDictionary<string, object?> ImageSpec(
        string src,
        string? alt = null,
        string? caption = null,
        string? id = null) =>
        Spec("image", Data(("src", src), ("alt", alt), ("caption", caption)), id);

    /// <summary>Emit an image bubble. See <see cref="ImageSpec"/>.</summary>
    public static void Image(IContext ctx, string src, string? alt = null, string? caption = null, string? id = null) =>
        Emit(ctx, ImageSpec(src, alt, caption, id));

    /// <summary>Describe a hero card with optional image and action buttons.
    /// Build <paramref name="buttons"/> with <see cref="Button"/>.</summary>
    public static IReadOnlyDictionary<string, object?> CardSpec(
        string title,
        string? subtitle = null,
        string? image = null,
        IReadOnlyList<object>? buttons = null,
        string? id = null) =>
        Spec("card", Data(("title", title), ("subtitle", subtitle), ("image", image), ("buttons", buttons)), id);

    /// <summary>Emit a hero card. See <see cref="CardSpec"/>.</summary>
    public static void Card(
        IContext ctx,
        string title,
        string? subtitle = null,
        string? image = null,
        IReadOnlyList<object>? buttons = null,
        string? id = null) =>
        Emit(ctx, CardSpec(title, subtitle, image, buttons, id));

    /// <summary>Describe a vertical list of full-width action buttons. With
    /// <paramref name="persistent"/> the buttons stay tappable after a selection.</summary>
    public static IReadOnlyDictionary<string, object?> ButtonsSpec(
        IReadOnlyList<object> buttons,
        string? text = null,
        bool? persistent = null,
        string? id = null) =>
        Spec("buttons", Data(("buttons", buttons), ("text", text), ("persistent", persistent)), id);

    /// <summary>Emit a button list. See <see cref="ButtonsSpec"/>.</summary>
    public static void Buttons(
        IContext ctx,
        IReadOnlyList<object> buttons,
        string? text = null,
        bool? persistent = null,
        string? id = null) =>
        Emit(ctx, ButtonsSpec(buttons, text, persistent, id));

    /// <summary>Describe a text bubble with one-time quick-reply chips. With
    /// <paramref name="keepActions"/> the chips stay rendered after the tap.</summary>
    public static IReadOnlyDictionary<string, object?> QuickReplySpec(
        string text,
        IReadOnlyList<object> actions,
        bool? keepActions = null,
        string? id = null) =>
        Spec("quick-reply", Data(("text", text), ("actions", actions), ("keepActions", keepActions)), id);

    /// <summary>Emit quick-reply chips. See <see cref="QuickReplySpec"/>.</summary>
    public static void QuickReply(
        IContext ctx,
        string text,
        IReadOnlyList<object> actions,
        bool? keepActions = null,
        string? id = null) =>
        Emit(ctx, QuickReplySpec(text, actions, keepActions, id));

    /// <summary>Describe a downloadable file card. <paramref name="size"/> in bytes.</summary>
    public static IReadOnlyDictionary<string, object?> FileSpec(
        string url,
        string name,
        long? size = null,
        string? mimeType = null,
        string? id = null) =>
        Spec("file", Data(("url", url), ("name", name), ("size", size), ("mimeType", mimeType)), id);

    /// <summary>Emit a file card. See <see cref="FileSpec"/>.</summary>
    public static void File(
        IContext ctx,
        string url,
        string name,
        long? size = null,
        string? mimeType = null,
        string? id = null) =>
        Emit(ctx, FileSpec(url, name, size, mimeType, id));

    /// <summary>Describe a native video player with optional poster and caption.</summary>
    public static IReadOnlyDictionary<string, object?> VideoSpec(
        string src,
        string? poster = null,
        string? caption = null,
        string? id = null) =>
        Spec("video", Data(("src", src), ("poster", poster), ("caption", caption)), id);

    /// <summary>Emit a video. See <see cref="VideoSpec"/>.</summary>
    public static void Video(IContext ctx, string src, string? poster = null, string? caption = null, string? id = null) =>
        Emit(ctx, VideoSpec(src, poster, caption, id));

    /// <summary>Describe a horizontal card carousel. Build <paramref name="cards"/>
    /// with <see cref="CarouselCard"/>.</summary>
    public static IReadOnlyDictionary<string, object?> CarouselSpec(IReadOnlyList<object> cards, string? id = null) =>
        Spec("carousel", Data(("cards", cards)), id);

    /// <summary>Emit a carousel. See <see cref="CarouselSpec"/>.</summary>
    public static void Carousel(IContext ctx, IReadOnlyList<object> cards, string? id = null) =>
        Emit(ctx, CarouselSpec(cards, id));
}
