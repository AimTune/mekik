using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Mekik;

/// <summary>Where a skill came from: the server's catalog, or a client's declaration (PROTOCOL.md §12.3).</summary>
public static class SkillOrigin
{
    public const string Server = "server";
    public const string Client = "client";
}

/// <summary>
/// Level 1 of a skill — what a model sees before choosing one (PROTOCOL.md
/// §12.1). This is what the <c>skills</c> catalog frame carries and what
/// <see cref="Shuttle.Skills"/> returns. Mirror of TypeScript's <c>SkillSummary</c>.
/// </summary>
public record SkillSummary
{
    /// <summary>1–64 lowercase letters, digits and single hyphens (the Agent Skills name rule).</summary>
    public required string Name { get; init; }

    /// <summary>What the skill does and when to use it — the whole trigger surface.</summary>
    public required string Description { get; init; }

    /// <summary>
    /// Server-side filter labels, the same rule as client tool tags (§11.2): an
    /// untagged skill is unrestricted, a tagged one is returned only by queries
    /// whose tags intersect its own.
    /// </summary>
    public IReadOnlyList<string>? Tags { get; init; }

    /// <summary>Stamped by the turn snapshot (<see cref="SkillOrigin"/>); null on a source's own entries.</summary>
    public string? Source { get; init; }

    /// <summary>The wire shape of this summary: <c>{name, description, tags?, source?}</c>.</summary>
    public Dictionary<string, object?> ToWire()
    {
        var d = new Dictionary<string, object?> { ["name"] = Name, ["description"] = Description };
        if (Tags is { Count: > 0 }) d["tags"] = Tags.Cast<object?>().ToList();
        if (Source is not null) d["source"] = Source;
        return d;
    }
}

/// <summary>Level 2 — a skill with its instructions, as a source hands it back.</summary>
public sealed record SkillEntry : SkillSummary
{
    /// <summary>The markdown a model reads once it has chosen the skill.</summary>
    public required string Instructions { get; init; }

    /// <summary>The level-1 view of this entry.</summary>
    public SkillSummary ToSummary() => new() { Name = Name, Description = Description, Tags = Tags, Source = Source };
}

/// <summary>
/// Where skills come from, as a node sees them — progressive disclosure in three
/// levels (PROTOCOL.md §12). <see cref="List"/> is what a model sees before
/// choosing (level 1), <see cref="Get"/> is one skill's instructions (level 2),
/// and <see cref="ReadResourceAsync"/> is a bundled file (level 3) when
/// <see cref="HasResources"/>.
/// </summary>
/// <remarks>
/// <c>Ilmek.Skills</c>' <c>SkillCatalog</c> is the natural backing: map its
/// skills into <see cref="SkillEntry"/> records with <see cref="SkillSources.Inline(IEnumerable{SkillEntry})"/>,
/// or implement this interface over it directly.
/// </remarks>
public interface ISkillSource
{
    /// <summary>Every skill's level-1 summary, in catalog order (by name).</summary>
    IReadOnlyList<SkillSummary> List();

    /// <summary>The whole skill, instructions included, or null for an unknown name.</summary>
    SkillEntry? Get(string name);

    /// <summary>True when the source can serve bundled files (level 3).</summary>
    bool HasResources => false;

    /// <summary>The text of one bundled file. Throws <see cref="NotSupportedException"/> unless <see cref="HasResources"/>.</summary>
    Task<string> ReadResourceAsync(string name, string path, CancellationToken ct = default) =>
        throw new NotSupportedException($"skill \"{name}\" has no resources");
}

/// <summary>An in-memory <see cref="ISkillSource"/> over a fixed list — inline and test skills.</summary>
public sealed class StaticSkillSource : ISkillSource
{
    private readonly SortedDictionary<string, SkillEntry> _byName = new(StringComparer.Ordinal);

    public StaticSkillSource(IEnumerable<SkillEntry> entries)
    {
        foreach (var e in entries)
        {
            if (_byName.ContainsKey(e.Name)) throw new ArgumentException($"two skills are named \"{e.Name}\"", nameof(entries));
            _byName[e.Name] = e;
        }
    }

    public IReadOnlyList<SkillSummary> List() => _byName.Values.Select(e => e.ToSummary()).ToList();

    public SkillEntry? Get(string name) => _byName.GetValueOrDefault(name);
}

/// <summary>Constructors for <see cref="ISkillSource"/>s.</summary>
public static class SkillSources
{
    /// <summary>A source over a fixed list of skills — the .NET spelling of TypeScript's plain-array <c>skills</c> option.</summary>
    public static ISkillSource Inline(IEnumerable<SkillEntry> entries) => new StaticSkillSource(entries);

    /// <summary>A source over a fixed list of skills.</summary>
    public static ISkillSource Inline(params SkillEntry[] entries) => new StaticSkillSource(entries);
}

/// <summary>
/// One skill the <b>client</b> declares (PROTOCOL.md §12.4): instructions the
/// frontend wants the model to follow when a task matches. Inline, because a
/// client has no folder to serve. Accepted only when
/// <see cref="MekikOptions.ClientSkills"/> opts in — the default is off.
/// </summary>
public sealed record ClientSkillDefinition
{
    public required string Name { get; init; }
    public required string Description { get; init; }
    public required string Instructions { get; init; }
    public IReadOnlyList<string>? Tags { get; init; }
}

/// <summary>
/// Whether — and which — client-declared skills the server accepts (PROTOCOL.md
/// §12.4). The delegate sees the sanitized declarations and returns the subset
/// to accept (null for none). Assign <see cref="ClientSkills.AcceptAll"/> to
/// accept every well-formed declaration; leave <see cref="MekikOptions.ClientSkills"/>
/// null and declarations are ignored entirely — a skill is text a model will follow.
/// </summary>
public delegate IReadOnlyList<ClientSkillDefinition>? ClientSkillsPolicy(
    IReadOnlyList<ClientSkillDefinition> skills,
    (string ConversationId, string UserId) conv);

/// <summary>Helpers for client skill declarations (PROTOCOL.md §12.4).</summary>
public static class ClientSkills
{
    /// <summary>The accept-everything policy — the .NET spelling of TypeScript's <c>clientSkills: true</c>.</summary>
    public static readonly ClientSkillsPolicy AcceptAll = (skills, _) => skills;

    /// <summary>
    /// Sanitize a client-declared skill list: keep only entries with a valid
    /// <c>name</c>, a non-empty <c>description</c> of at most 1024 characters and a
    /// string <c>instructions</c>; keep only the known fields; dedupe by name (last
    /// declaration wins, keeping the position of its first appearance). Mirror of
    /// TypeScript's <c>sanitizeClientSkills</c>.
    /// </summary>
    public static IReadOnlyList<ClientSkillDefinition> Sanitize(object? value)
    {
        if (value is not System.Collections.IEnumerable seq || value is string) return [];

        var order = new List<string>();
        var byName = new Dictionary<string, ClientSkillDefinition>();
        foreach (var entry in seq)
        {
            if (entry is not IReadOnlyDictionary<string, object?> e) continue;
            if (e.GetValueOrDefault("name") is not string name || !Skills.IsValidName(name)) continue;
            if (e.GetValueOrDefault("description") is not string rawDescription) continue;
            var description = rawDescription.Trim();
            if (description.Length == 0 || description.Length > Skills.DescriptionMax) continue;
            if (e.GetValueOrDefault("instructions") is not string instructions) continue;

            var def = new ClientSkillDefinition
            {
                Name = name,
                Description = description,
                Instructions = instructions,
                Tags = ReadTags(e.GetValueOrDefault("tags")),
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

/// <summary>
/// Skills (PROTOCOL.md §12) — the name rule, the catalog hash, and level 1
/// rendered as text. Mirror of TypeScript's <c>skills.ts</c>.
/// </summary>
public static class Skills
{
    public const int NameMax = 64;
    public const int DescriptionMax = 1024;
    private static readonly Regex NamePattern = new("^[a-z0-9]+(?:-[a-z0-9]+)*$", RegexOptions.Compiled);

    /// <summary>The Agent Skills name rule: lowercase letters, digits and single hyphens, 1–64 characters.</summary>
    public static bool IsValidName(string name) => name.Length > 0 && name.Length <= NameMax && NamePattern.IsMatch(name);

    /// <summary>
    /// The hash that versions the server's skill catalog for the handshake (§12.2):
    /// sha256 over the canonical JSON of the summaries — <c>name</c>, <c>description</c>,
    /// <c>tags</c> — sorted by name. Identical to TypeScript's <c>hashSkills</c>.
    /// </summary>
    public static string Hash(IEnumerable<SkillSummary> summaries)
    {
        var list = summaries.ToList();
        if (list.Count == 0) return "";
        var sorted = list
            .OrderBy(s => s.Name, StringComparer.Ordinal)
            .Select(s => (object?)(s with { Source = null }).ToWire())
            .ToList();
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Json.Canonicalize(sorted))));
    }

    /// <summary>What a model is told about the <c>&lt;available_skills&gt;</c> block, unless the app says otherwise.</summary>
    public const string DefaultIntro =
        "You have the following skills available. Each entry gives a skill's name and what it is for. " +
        "When a task matches a skill, load that skill's full instructions by name before you act on the task.";

    /// <summary>
    /// Render level 1 for a system prompt — the same text <c>Ilmek.Skills</c>'
    /// <c>SkillPrompt.Render</c> and <c>@ilmek/skills</c>' <c>renderSkillsPrompt</c>
    /// produce. Returns <c>""</c> for an empty list. Pass <c>intro: null</c> to
    /// render the block alone.
    /// </summary>
    public static string RenderPrompt(IEnumerable<SkillSummary> skills, string? intro = DefaultIntro)
    {
        var list = skills as IReadOnlyList<SkillSummary> ?? skills.ToList();
        if (list.Count == 0) return "";
        var lines = new List<string>();
        if (!string.IsNullOrEmpty(intro))
        {
            lines.Add(intro);
            lines.Add("");
        }
        lines.Add("<available_skills>");
        foreach (var s in list)
        {
            lines.Add("  <skill>");
            lines.Add($"    <name>{Escape(s.Name)}</name>");
            lines.Add($"    <description>{Escape(s.Description)}</description>");
            lines.Add("  </skill>");
        }
        lines.Add("</available_skills>");
        return string.Join("\n", lines);
    }

    private static string Escape(string text) =>
        new StringBuilder(text).Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").ToString();
}

/// <summary>
/// What one turn sees at <c>ctx.Meta["skills"]</c> (PROTOCOL.md §12.3): the
/// server's catalog plus the client-declared skills the app accepted, each
/// summary stamped with its <see cref="SkillSummary.Source"/>. A client skill whose
/// name collides with a server skill is <b>dropped</b> — the server's definition
/// is authoritative. Mirror of TypeScript's <c>TurnSkills</c>.
/// </summary>
public sealed class TurnSkillSource : ISkillSource
{
    private readonly ISkillSource? _server;
    private readonly HashSet<string> _serverNames;
    private readonly List<ClientSkillDefinition> _client;

    public TurnSkillSource(ISkillSource? server, IReadOnlyList<ClientSkillDefinition>? client = null)
    {
        _server = server;
        _serverNames = new HashSet<string>(server?.List().Select(s => s.Name) ?? [], StringComparer.Ordinal);
        _client = (client ?? []).Where(c => !_serverNames.Contains(c.Name)).ToList();
    }

    public IReadOnlyList<SkillSummary> List()
    {
        var list = new List<SkillSummary>();
        foreach (var s in _server?.List() ?? []) list.Add(s with { Source = SkillOrigin.Server });
        foreach (var c in _client) list.Add(new SkillSummary { Name = c.Name, Description = c.Description, Tags = c.Tags, Source = SkillOrigin.Client });
        return list;
    }

    public SkillEntry? Get(string name)
    {
        if (_server?.Get(name) is { } server) return server with { Source = SkillOrigin.Server };
        var client = _client.FirstOrDefault(c => c.Name == name);
        return client is null
            ? null
            : new SkillEntry { Name = client.Name, Description = client.Description, Tags = client.Tags, Instructions = client.Instructions, Source = SkillOrigin.Client };
    }

    /// <summary>Level 3 exists only when the server source has files behind it; client skills travel inline.</summary>
    public bool HasResources => _server?.HasResources ?? false;

    public Task<string> ReadResourceAsync(string name, string path, CancellationToken ct = default)
    {
        if (_server is null || !_server.HasResources || !_serverNames.Contains(name))
            throw new NotSupportedException($"skill \"{name}\" has no resources");
        return _server.ReadResourceAsync(name, path, ct);
    }
}
