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

    /// <summary>A text message, optionally with link previews under the bubble.
    /// <paramref name="previewVariant"/>: <c>compact</c> | <c>expanded</c>.</summary>
    public static void Text(
        IContext ctx,
        string text,
        IReadOnlyList<string>? urls = null,
        string? previewVariant = null,
        string? id = null) =>
        Shuttle.Message(ctx, "text", Data(("text", text), ("urls", urls), ("previewVariant", previewVariant)), id);

    /// <summary>An image bubble with optional caption.</summary>
    public static void Image(IContext ctx, string src, string? alt = null, string? caption = null, string? id = null) =>
        Shuttle.Message(ctx, "image", Data(("src", src), ("alt", alt), ("caption", caption)), id);

    /// <summary>A hero card with optional image and action buttons.
    /// Build <paramref name="buttons"/> with <see cref="Button"/>.</summary>
    public static void Card(
        IContext ctx,
        string title,
        string? subtitle = null,
        string? image = null,
        IReadOnlyList<object>? buttons = null,
        string? id = null) =>
        Shuttle.Message(ctx, "card", Data(("title", title), ("subtitle", subtitle), ("image", image), ("buttons", buttons)), id);

    /// <summary>A vertical list of full-width action buttons. With
    /// <paramref name="persistent"/> the buttons stay tappable after a selection.</summary>
    public static void Buttons(
        IContext ctx,
        IReadOnlyList<object> buttons,
        string? text = null,
        bool? persistent = null,
        string? id = null) =>
        Shuttle.Message(ctx, "buttons", Data(("buttons", buttons), ("text", text), ("persistent", persistent)), id);

    /// <summary>A text bubble with one-time quick-reply chips. With
    /// <paramref name="keepActions"/> the chips stay rendered after the tap.</summary>
    public static void QuickReply(
        IContext ctx,
        string text,
        IReadOnlyList<object> actions,
        bool? keepActions = null,
        string? id = null) =>
        Shuttle.Message(ctx, "quick-reply", Data(("text", text), ("actions", actions), ("keepActions", keepActions)), id);

    /// <summary>A downloadable file card. <paramref name="size"/> in bytes.</summary>
    public static void File(
        IContext ctx,
        string url,
        string name,
        long? size = null,
        string? mimeType = null,
        string? id = null) =>
        Shuttle.Message(ctx, "file", Data(("url", url), ("name", name), ("size", size), ("mimeType", mimeType)), id);

    /// <summary>A native video player with optional poster and caption.</summary>
    public static void Video(IContext ctx, string src, string? poster = null, string? caption = null, string? id = null) =>
        Shuttle.Message(ctx, "video", Data(("src", src), ("poster", poster), ("caption", caption)), id);

    /// <summary>A horizontal card carousel. Build <paramref name="cards"/> with
    /// <see cref="CarouselCard"/>.</summary>
    public static void Carousel(IContext ctx, IReadOnlyList<object> cards, string? id = null) =>
        Shuttle.Message(ctx, "carousel", Data(("cards", cards)), id);
}
