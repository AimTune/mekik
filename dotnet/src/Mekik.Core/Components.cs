using System.Security.Cryptography;
using System.Text;
using Ilmek;

namespace Mekik;

/// <summary>
/// A component the server defines itself (PROTOCOL.md §10) — markup, not code.
///
/// <para>Until now a <c>ui</c> chunk named a component the <i>client</i> had already
/// registered: the backend could only reference widgets someone had compiled into
/// the page. A server-defined component inverts that. The graph author writes the
/// widget here, the engine ships it as metadata in a <c>genui_components</c> frame,
/// and chativa turns each definition into a custom element and mounts it by name.
/// No client build, no redeploy to add a widget.</para>
///
/// <para>The template language is <c>{{value}}</c>, <c>{{#if}}</c> and <c>{{#each}}</c>
/// (§10.3); every interpolation is escaped, and the client sanitizes the result again
/// before it reaches the DOM.</para>
/// </summary>
public sealed record ComponentSpec
{
    /// <summary>Registry name a <c>ui</c> chunk mounts by, e.g. <c>"order-card"</c>.</summary>
    public required string Name { get; init; }
    /// <summary>Markup with <c>{{…}}</c> placeholders (§10.3).</summary>
    public required string Template { get; init; }
    /// <summary>Optional CSS, scoped to the component's shadow root on the client.</summary>
    public string? Css { get; init; }
    /// <summary>
    /// Prop defaults. Doubles as the declaration the client makes reactive, so a prop
    /// a chunk may set must appear here — with the value it should have when omitted.
    /// </summary>
    public IReadOnlyDictionary<string, object?>? Props { get; init; }
    /// <summary>Bump when the markup changes in a way older cached copies must not keep.</summary>
    public string? Version { get; init; }
    /// <summary>Custom element tag on the client. Derived from <see cref="Name"/> when omitted.</summary>
    public string? Tag { get; init; }
}

/// <summary>
/// A component authored as a class — the form <see cref="MekikOptions.Components"/>
/// accepts alongside <see cref="ComponentSpec"/>.
/// </summary>
/// <example><code>
/// public sealed class OrderCard : GenUiComponent
/// {
///     public override string Name =&gt; "order-card";
///     public override string Template =&gt; """
///         &lt;h3&gt;{{title}}&lt;/h3&gt;
///         &lt;button data-event="track_order" data-payload='{"id":"{{id}}"}'&gt;Track&lt;/button&gt;
///         """;
///     public override string? Css =&gt; ".card { padding: 12px; }";
///     public override IReadOnlyDictionary&lt;string, object?&gt;? Props =&gt;
///         new Dictionary&lt;string, object?&gt; { ["id"] = "", ["title"] = "" };
/// }
///
/// var app = new MekikApp(new MekikOptions { Graph = g, Components = [new OrderCard()] });
/// </code></example>
public abstract class GenUiComponent
{
    public abstract string Name { get; }
    public abstract string Template { get; }
    public virtual string? Css => null;
    public virtual IReadOnlyDictionary<string, object?>? Props => null;
    public virtual string? Version => null;
    public virtual string? Tag => null;

    /// <summary>Emit this component into the turn's stream — the typed <see cref="Shuttle.Ui"/>.</summary>
    public void Emit(IContext ctx, IReadOnlyDictionary<string, object?> props, object? id = null) =>
        Shuttle.Ui(ctx, Name, props, id);

    /// <summary>The wire metadata for this component.</summary>
    public ComponentSpec ToSpec() => new()
    {
        Name = Name,
        Template = Template,
        Css = Css,
        Props = Props,
        Version = Version,
        Tag = Tag,
    };
}

/// <summary>
/// The server's component catalog: the definitions plus the hash that versions them.
///
/// <para>The hash is <c>sha256</c> over the canonical JSON (<see cref="Json.Canonicalize"/>)
/// of the definitions sorted by name — the same canonicalization the golden fixtures
/// use, so the .NET and TypeScript servers mint identical hashes for identical
/// catalogs and a client can move between them without re-downloading (§10.2).</para>
/// </summary>
public sealed class ComponentCatalog
{
    /// <summary>Definitions as wire dictionaries, sorted by name.</summary>
    public IReadOnlyList<IReadOnlyDictionary<string, object?>> Definitions { get; }

    /// <summary>The catalog's version token; empty when the catalog is empty.</summary>
    public string Hash { get; }

    public bool IsEmpty => Definitions.Count == 0;

    public ComponentCatalog(IEnumerable<object>? sources = null)
    {
        var seen = new Dictionary<string, IReadOnlyDictionary<string, object?>>(StringComparer.Ordinal);
        foreach (var source in sources ?? [])
        {
            var spec = ToSpec(source);
            if (string.IsNullOrEmpty(spec.Name) || spec.Template is null)
                throw new ArgumentException($"mekik: a component needs a name and a template (got \"{spec.Name}\")");
            if (seen.ContainsKey(spec.Name))
                throw new ArgumentException($"mekik: duplicate component name \"{spec.Name}\"");
            seen[spec.Name] = ToDefinition(spec);
        }

        Definitions = seen.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => kv.Value).ToList();
        Hash = Definitions.Count == 0 ? "" : HashDefinitions(Definitions);
    }

    /// <summary>Normalize any accepted authoring form to its spec.</summary>
    private static ComponentSpec ToSpec(object source) => source switch
    {
        ComponentSpec spec => spec,
        GenUiComponent component => component.ToSpec(),
        Type type when typeof(GenUiComponent).IsAssignableFrom(type) =>
            ((GenUiComponent)Activator.CreateInstance(type)!).ToSpec(),
        _ => throw new ArgumentException($"mekik: {source.GetType().Name} is not a component spec or a GenUiComponent"),
    };

    /// <summary>
    /// The wire shape. Absent optional fields are omitted rather than sent as null,
    /// so an unset <c>css</c> hashes identically in both implementations.
    /// </summary>
    private static IReadOnlyDictionary<string, object?> ToDefinition(ComponentSpec spec)
    {
        var def = new Dictionary<string, object?> { ["name"] = spec.Name, ["template"] = spec.Template };
        if (spec.Css is not null) def["css"] = spec.Css;
        if (spec.Props is not null) def["props"] = spec.Props;
        if (spec.Version is not null) def["version"] = spec.Version;
        if (spec.Tag is not null) def["tag"] = spec.Tag;
        return def;
    }

    /// <summary><c>sha256(canonical JSON)</c>, lowercase hex — identical in every mekik implementation.</summary>
    public static string HashDefinitions(IEnumerable<IReadOnlyDictionary<string, object?>> definitions)
    {
        var canonical = Json.Canonicalize(definitions.Cast<object?>().ToList());
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
    }
}
