using Ilmek;

namespace Mekik;

/// <summary>
/// Typed emitters for the GenUI components chativa's <c>@chativa/genui</c> package
/// registers out of the box (<c>genui-card</c>, <c>genui-table</c>, …) — mirror of
/// the TypeScript <c>mekik.genui</c> catalog.
///
/// <para>mekik still ships no components: on the wire a component is a
/// client-registry <i>name</i> plus a props JSON object, exactly what
/// <see cref="Shuttle.Ui"/> emits. These methods only bind the name and type the
/// props (named optional parameters in, camelCase dictionary keys out — the
/// dictionary shape keeps canonical-JSON parity with TypeScript exact, see
/// docs/LANGUAGES.md divergence #2). For a component of your own, call
/// <see cref="Shuttle.Ui"/> with its registry name, or build a <c>UiRef</c> with
/// <see cref="Ref"/>.</para>
///
/// <para>Every emitter takes an optional <c>id</c> — the chunk's client-side key,
/// same id ⇒ update in place. For a managed handle use
/// <see cref="Shuttle.Mount"/> with the component's registry name (the TS
/// catalog's per-component <c>.mount</c> has no typed .NET counterpart).</para>
/// </summary>
public static class GenUI
{
    /// <summary>The registry names chativa's built-ins are registered under —
    /// for <see cref="Shuttle.Mount"/> / <see cref="Shuttle.Ui"/> call sites.</summary>
    public static class Names
    {
        public const string Text = "genui-text";
        public const string Card = "genui-card";
        public const string Form = "genui-form";
        public const string Alert = "genui-alert";
        public const string QuickReplies = "genui-quick-replies";
        public const string List = "genui-list";
        public const string Table = "genui-table";
        public const string Rating = "genui-rating";
        public const string Progress = "genui-progress";
        public const string DatePicker = "genui-date-picker";
        public const string Chart = "genui-chart";
        public const string Steps = "genui-steps";
        public const string ImageGallery = "genui-image-gallery";
    }

    private static Dictionary<string, object?> Props(params (string Key, object? Value)[] pairs)
    {
        var props = new Dictionary<string, object?>();
        foreach (var (key, value) in pairs)
        {
            if (value is not null) props[key] = value;
        }
        return props;
    }

    // ── emitters ──────────────────────────────────────────────────────────────

    /// <summary>A markdown-capable text block (<c>genui-text</c>).</summary>
    public static void Text(IContext ctx, string content, object? id = null) =>
        Shuttle.Ui(ctx, Names.Text, Props(("content", content)), id);

    /// <summary>A card with optional image and action buttons (<c>genui-card</c>).
    /// Build <paramref name="actions"/> with <see cref="CardAction"/>.</summary>
    public static void Card(
        IContext ctx,
        string? title = null,
        string? description = null,
        string? image = null,
        IReadOnlyList<object>? actions = null,
        object? id = null) =>
        Shuttle.Ui(ctx, Names.Card, Props(("title", title), ("description", description), ("image", image), ("actions", actions)), id);

    /// <summary>An input form; submit reaches the server as a <c>genui_event</c>
    /// (<c>genui-form</c>). Build <paramref name="fields"/> with <see cref="Field"/>.
    /// To attach a form to an interrupt instead, use <see cref="FormRef"/>.</summary>
    public static void Form(
        IContext ctx,
        IReadOnlyList<object> fields,
        string? title = null,
        string? buttonText = null,
        object? id = null) =>
        Shuttle.Ui(ctx, Names.Form, Props(("fields", fields), ("title", title), ("buttonText", buttonText)), id);

    /// <summary>A callout banner (<c>genui-alert</c>).
    /// <paramref name="variant"/>: <c>info</c> | <c>success</c> | <c>warning</c> | <c>error</c>.</summary>
    public static void Alert(
        IContext ctx,
        string message,
        string? variant = null,
        string? title = null,
        string? icon = null,
        object? id = null) =>
        Shuttle.Ui(ctx, Names.Alert, Props(("message", message), ("variant", variant), ("title", title), ("icon", icon)), id);

    /// <summary>Tappable quick-reply chips (<c>genui-quick-replies</c>).
    /// Build <paramref name="items"/> with <see cref="QuickReply"/>. For chips that
    /// pause the run and resume with the pick, use <c>Shuttle.Choose</c> instead.</summary>
    public static void QuickReplies(
        IContext ctx,
        IReadOnlyList<object> items,
        string? label = null,
        object? id = null) =>
        Shuttle.Ui(ctx, Names.QuickReplies, Props(("items", items), ("label", label)), id);

    /// <summary>An ordered or bulleted list (<c>genui-list</c>).
    /// Build <paramref name="items"/> with <see cref="Item"/>.</summary>
    public static void List(
        IContext ctx,
        IReadOnlyList<object> items,
        string? title = null,
        bool? ordered = null,
        object? id = null) =>
        Shuttle.Ui(ctx, Names.List, Props(("items", items), ("title", title), ("ordered", ordered)), id);

    /// <summary>A data table (<c>genui-table</c>). <paramref name="rows"/> are cell
    /// lists, one per row, in <paramref name="columns"/> order.</summary>
    public static void Table(
        IContext ctx,
        IReadOnlyList<string> columns,
        IReadOnlyList<IReadOnlyList<object?>> rows,
        string? title = null,
        object? id = null) =>
        Shuttle.Ui(ctx, Names.Table, Props(("columns", columns), ("rows", rows), ("title", title)), id);

    /// <summary>A star rating; a submit reaches the server as a <c>genui_event</c>
    /// (<c>genui-rating</c>).</summary>
    public static void Rating(
        IContext ctx,
        string? title = null,
        int? maxStars = null,
        bool? readOnly = null,
        double? value = null,
        object? id = null) =>
        Shuttle.Ui(ctx, Names.Rating, Props(("title", title), ("maxStars", maxStars), ("readonly", readOnly), ("value", value)), id);

    /// <summary>A progress bar, 0–100 (<c>genui-progress</c>). Re-emit with the same
    /// <paramref name="id"/> to advance it in place.
    /// <paramref name="variant"/>: <c>default</c> | <c>success</c> | <c>warning</c> | <c>error</c>.</summary>
    public static void Progress(
        IContext ctx,
        double value,
        string? label = null,
        string? caption = null,
        string? variant = null,
        object? id = null) =>
        Shuttle.Ui(ctx, Names.Progress, Props(("value", value), ("label", label), ("caption", caption), ("variant", variant)), id);

    /// <summary>A date picker; a pick reaches the server as a <c>genui_event</c>
    /// (<c>genui-date-picker</c>). Dates are ISO <c>YYYY-MM-DD</c> strings.</summary>
    public static void DatePicker(
        IContext ctx,
        string? label = null,
        string? min = null,
        string? max = null,
        string? value = null,
        bool? disabled = null,
        object? id = null) =>
        Shuttle.Ui(ctx, Names.DatePicker, Props(("label", label), ("min", min), ("max", max), ("value", value), ("disabled", disabled)), id);

    /// <summary>A bar/line/pie chart (<c>genui-chart</c>).
    /// Build <paramref name="datasets"/> with <see cref="Dataset"/>.</summary>
    public static void Chart(
        IContext ctx,
        string? type = null,
        string? title = null,
        IReadOnlyList<string>? labels = null,
        IReadOnlyList<object>? datasets = null,
        object? id = null) =>
        Shuttle.Ui(ctx, Names.Chart, Props(("type", type), ("title", title), ("labels", labels), ("datasets", datasets)), id);

    /// <summary>A step tracker (<c>genui-steps</c>). Build <paramref name="steps"/>
    /// with <see cref="Step"/>; re-emit with the same <paramref name="id"/> to advance.</summary>
    public static void Steps(IContext ctx, IReadOnlyList<object> steps, object? id = null) =>
        Shuttle.Ui(ctx, Names.Steps, Props(("steps", steps)), id);

    /// <summary>An image grid (<c>genui-image-gallery</c>).
    /// Build <paramref name="images"/> with <see cref="Image"/>.</summary>
    public static void ImageGallery(
        IContext ctx,
        IReadOnlyList<object> images,
        int? columns = null,
        object? id = null) =>
        Shuttle.Ui(ctx, Names.ImageGallery, Props(("images", images), ("columns", columns)), id);

    // ── item builders ─────────────────────────────────────────────────────────

    /// <summary>One card action button: <c>{ label, value }</c>.</summary>
    public static IReadOnlyDictionary<string, object?> CardAction(string label, string value) =>
        Props(("label", label), ("value", value));

    /// <summary>One form field. <paramref name="type"/> is an HTML input type
    /// (<c>text</c>, <c>email</c>, <c>number</c>, <c>date</c>, …).</summary>
    public static IReadOnlyDictionary<string, object?> Field(
        string name,
        string label,
        string type,
        string? placeholder = null,
        string? value = null,
        bool? required = null,
        bool? disabled = null) =>
        Props(("name", name), ("label", label), ("type", type), ("placeholder", placeholder), ("value", value), ("required", required), ("disabled", disabled));

    /// <summary>One quick-reply chip: <c>{ label, value }</c>.</summary>
    public static IReadOnlyDictionary<string, object?> QuickReply(string label, string value) =>
        Props(("label", label), ("value", value));

    /// <summary>One list entry.</summary>
    public static IReadOnlyDictionary<string, object?> Item(string text, string? icon = null, string? secondary = null) =>
        Props(("text", text), ("icon", icon), ("secondary", secondary));

    /// <summary>One chart dataset.</summary>
    public static IReadOnlyDictionary<string, object?> Dataset(
        IReadOnlyList<double> data,
        string? label = null,
        string? color = null) =>
        Props(("data", data), ("label", label), ("color", color));

    /// <summary>One tracker step. <paramref name="status"/>: <c>done</c> | <c>active</c> | <c>pending</c>.</summary>
    public static IReadOnlyDictionary<string, object?> Step(string label, string status, string? description = null) =>
        Props(("label", label), ("status", status), ("description", description));

    /// <summary>One gallery image.</summary>
    public static IReadOnlyDictionary<string, object?> Image(string src, string? alt = null, string? caption = null) =>
        Props(("src", src), ("alt", alt), ("caption", caption));

    // ── UiRefs (for Shuttle.Approve's ui) ─────────────────────────────────────

    /// <summary>A <c>UiRef</c> — <c>{ component, props }</c> — for mounting any
    /// component as an interrupt's form via <c>Shuttle.Approve(ctx, payload, ui: …)</c>.</summary>
    public static IReadOnlyDictionary<string, object?> Ref(string component, IReadOnlyDictionary<string, object?>? props = null) =>
        props is null
            ? new Dictionary<string, object?> { ["component"] = component }
            : new Dictionary<string, object?> { ["component"] = component, ["props"] = props };

    /// <summary>The <c>genui-form</c> <c>UiRef</c> — the common interrupt form case.
    /// Build <paramref name="fields"/> with <see cref="Field"/>.</summary>
    public static IReadOnlyDictionary<string, object?> FormRef(
        IReadOnlyList<object> fields,
        string? title = null,
        string? buttonText = null) =>
        Ref(Names.Form, Props(("fields", fields), ("title", title), ("buttonText", buttonText)));
}
