namespace Mekik;

/// <summary>
/// One tool the <b>client</b> declares it can execute (PROTOCOL.md §11.1): a UI
/// capability — render a card, open a picker, read the device — described well
/// enough for a server-side model to call it. Declared in <c>hello.tools</c> or
/// a <c>client_tools</c> frame; the engine snapshots the accepted declarations
/// into <c>ctx.Meta["clientTools"]</c> per turn (only when
/// <see cref="MekikOptions.ClientTools"/> opts in — the default is off).
/// </summary>
/// <remarks>
/// A declaration is <b>capability, not authority</b>: it changes what the server
/// may ask the client to do, never what the server itself does. Authorization
/// and side effects stay server-side.
/// </remarks>
public sealed record ClientToolDefinition
{
    /// <summary>Unique per connection; a redeclared name replaces the earlier one.</summary>
    public required string Name { get; init; }

    /// <summary>What the tool does — this is what a model reads.</summary>
    public string? Description { get; init; }

    /// <summary>JSON Schema for the tool's parameters (a model's <c>input_schema</c>).</summary>
    public IReadOnlyDictionary<string, object?>? Parameters { get; init; }

    /// <summary>
    /// Server-side filter labels (PROTOCOL.md §11.2). A tool with no tags is
    /// unrestricted — every <see cref="Shuttle.ClientTools"/> query returns it; a
    /// tagged tool is returned only by queries whose tags intersect its own.
    /// </summary>
    public IReadOnlyList<string>? Tags { get; init; }

    /// <summary>Invocation mode: <c>"call"</c> (round-trip, default) or <c>"notify"</c> (fire-and-forget).</summary>
    public string? Mode { get; init; }
}

/// <summary>
/// Whether — and which — client-declared tools the server accepts (PROTOCOL.md
/// §11.1). The delegate sees the sanitized declarations and returns the subset
/// to accept (null for none). Assign <see cref="ClientTools.AcceptAll"/> to
/// accept every well-formed declaration; leave <see cref="MekikOptions.ClientTools"/>
/// null and declarations are ignored entirely — the same opt-in posture as
/// <see cref="MekikOptions.AcceptClientMeta"/>, because a declaration is
/// client-controlled input a model will read.
/// </summary>
public delegate IReadOnlyList<ClientToolDefinition>? ClientToolsPolicy(
    IReadOnlyList<ClientToolDefinition> tools,
    (string ConversationId, string UserId) conv);

/// <summary>Helpers for client tool declarations (PROTOCOL.md §11).</summary>
public static class ClientTools
{
    /// <summary>The accept-everything policy — the .NET spelling of TypeScript's <c>clientTools: true</c>.</summary>
    public static readonly ClientToolsPolicy AcceptAll = (tools, _) => tools;

    /// <summary>
    /// Sanitize a client-declared tool list (PROTOCOL.md §11.1): drop anything
    /// that is not an object with a non-empty string <c>name</c>, keep only the
    /// known, correctly-typed fields, and dedupe by name — the last declaration
    /// of a name wins, keeping the position of its first appearance. Mirror of
    /// TypeScript's <c>sanitizeClientTools</c>.
    /// </summary>
    public static IReadOnlyList<ClientToolDefinition> Sanitize(object? value)
    {
        if (value is not System.Collections.IEnumerable seq || value is string)
            return [];

        var order = new List<string>();
        var byName = new Dictionary<string, ClientToolDefinition>();
        foreach (var entry in seq)
        {
            if (entry is not IReadOnlyDictionary<string, object?> e) continue;
            if (e.GetValueOrDefault("name") is not string name || name.Length == 0) continue;

            var def = new ClientToolDefinition
            {
                Name = name,
                Description = e.GetValueOrDefault("description") as string,
                Parameters = e.GetValueOrDefault("parameters") as IReadOnlyDictionary<string, object?>,
                Tags = ReadTags(e.GetValueOrDefault("tags")),
                Mode = e.GetValueOrDefault("mode") is "call" or "notify" ? (string)e["mode"]! : null,
            };
            if (!byName.ContainsKey(name)) order.Add(name);
            byName[name] = def;
        }
        return order.Select(n => byName[n]).ToList();
    }

    private static IReadOnlyList<string>? ReadTags(object? value)
    {
        if (value is not System.Collections.IEnumerable seq || value is string) return null;
        var tags = seq.Cast<object?>().OfType<string>().Where(t => t.Length > 0).Distinct().ToList();
        return tags.Count > 0 ? tags : null;
    }
}
