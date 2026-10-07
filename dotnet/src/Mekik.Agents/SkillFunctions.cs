using System.Text.Json;
using Ilmek;
using Microsoft.Extensions.AI;

namespace Mekik.Agents;

/// <summary>
/// The turn's skills as <see cref="AIFunction"/>s — progressive disclosure, wired
/// (PROTOCOL.md §12). The .NET counterpart of <c>@mekik/langchain</c>'s
/// <c>withSkills</c>. Pair it with <see cref="Shuttle.SkillsPrompt"/> in the system
/// prompt: the prompt lists names and descriptions (level 1), and these functions
/// let the model pull one skill's instructions (<c>load_skill</c>) and, when the
/// server's catalog has files behind it, a bundled file (<c>read_skill_resource</c>).
/// </summary>
/// <remarks>
/// Each load surfaces as a <c>skill</c> frame. An unknown name comes back as an
/// error observation (the loop stays alive). The tag/source filter scopes which
/// skills this node exposes, and <c>load_skill</c> refuses a name the filter hides,
/// so the prompt and the function agree on the toolbox. Returns an empty list when
/// the turn has no skills.
/// </remarks>
/// <example><code>
/// var system = basePrompt + "\n\n" + Shuttle.SkillsPrompt(ctx, tags: ["docs"]);
/// var tools = MekikTools.Wrap(ctx, serverFunctions, policies)
///     .Concat(SkillFunctions.Wrap(ctx, tags: ["docs"]))
///     .ToList();
/// </code></example>
public static class SkillFunctions
{
    /// <summary>The function a model calls to read a skill's instructions (level 2).</summary>
    public const string LoadSkillTool = "load_skill";

    /// <summary>The function a model calls to read one of a skill's bundled files (level 3).</summary>
    public const string ReadSkillResourceTool = "read_skill_resource";

    /// <summary>Wrap the turn's skills (optionally tag/source-filtered) as AIFunctions.</summary>
    public static IReadOnlyList<AIFunction> Wrap(IContext ctx, IReadOnlyList<string>? tags = null, string? source = null) =>
        Wrap(ctx, tags, source, toolNames: null, onLoaded: null);

    /// <summary>
    /// Wrap the turn's skills as AIFunctions, naming each skill's tools in the
    /// <c>load_skill</c> observation: loading such a skill tells the model which tools it just
    /// unlocked. The tools a catalog entry owns (<see cref="SkillEntry{TTool}"/>) are named
    /// without being passed; <paramref name="toolNames"/> adds extra ones
    /// (<see cref="AgentRunOptions.SkillTools"/>).
    /// </summary>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="tags">Tag filter, as for <see cref="Shuttle.Skills"/>.</param>
    /// <param name="source">Origin filter (<see cref="SkillOrigin.Server"/> / <see cref="SkillOrigin.Client"/>).</param>
    /// <param name="toolNames">Skill name → the names of extra tools held under it.</param>
    public static IReadOnlyList<AIFunction> Wrap(
        IContext ctx,
        IReadOnlyList<string>? tags,
        string? source,
        IReadOnlyDictionary<string, IReadOnlyList<string>>? toolNames) =>
        Wrap(ctx, tags, source, toolNames, onLoaded: null);

    /// <summary>
    /// <see cref="Wrap(IContext, IReadOnlyList{string}?, string?, IReadOnlyDictionary{string, IReadOnlyList{string}}?)"/>
    /// plus <paramref name="onLoaded"/>: called after <c>load_skill</c> loaded a skill
    /// successfully (never for an unknown or hidden name, or a load that threw) — the hook a
    /// hand-wired loop uses to unlock that skill's tools for its next model call.
    /// </summary>
    public static IReadOnlyList<AIFunction> Wrap(
        IContext ctx,
        IReadOnlyList<string>? tags,
        string? source,
        IReadOnlyDictionary<string, IReadOnlyList<string>>? toolNames,
        Action<string>? onLoaded)
    {
        ArgumentNullException.ThrowIfNull(ctx);
        var visible = Shuttle.Skills(ctx, tags, source);
        if (visible.Count == 0) return [];
        var names = new HashSet<string>(visible.Select(s => s.Name), StringComparer.Ordinal);

        // What a load names: the tools the entry owns, then any extra the caller holds under it.
        var named = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        foreach (var (skill, owned) in Shuttle.SkillTools<AIFunction>(ctx, tags, source))
            named[skill] = owned.Select(f => f.Name).ToList();
        foreach (var (skill, extra) in toolNames ?? new Dictionary<string, IReadOnlyList<string>>())
            named[skill] = (named.GetValueOrDefault(skill) ?? []).Concat(extra).Distinct(StringComparer.Ordinal).ToList();

        var functions = new List<AIFunction> { new LoadSkillFunction(ctx, names, named, onLoaded) };
        if (Shuttle.SkillResourcesAvailable(ctx)) functions.Add(new ReadSkillResourceFunction(ctx, names));
        return functions;
    }

    private static string Arg(AIFunctionArguments arguments, string key) =>
        arguments.GetValueOrDefault(key) switch
        {
            string s => s,
            JsonElement { ValueKind: JsonValueKind.String } je => je.GetString() ?? "",
            null => "",
            var other => other.ToString() ?? "",
        };

    /// <summary>The <c>load_skill</c> observation: the instructions, plus the tools the load unlocked.</summary>
    internal static string LoadObservation(string name, string instructions, IReadOnlyList<string>? tools)
    {
        var body = instructions.Length > 0 ? instructions : $"(skill {name} has no instructions)";
        return tools is { Count: > 0 }
            ? $"{body}\n\nTools now available from skill {name}: {string.Join(", ", tools)}."
            : body;
    }

    private sealed class LoadSkillFunction(
        IContext ctx,
        HashSet<string> names,
        IReadOnlyDictionary<string, IReadOnlyList<string>> toolNames,
        Action<string>? onLoaded) : AIFunction
    {
        private static readonly JsonElement Schema = JsonDocument.Parse("""
            {"type":"object","properties":{"name":{"type":"string","description":"The skill's name, exactly as listed in <available_skills>."}},"required":["name"]}
            """).RootElement;

        public override string Name => LoadSkillTool;
        public override string Description =>
            "Load the full instructions of one of the available skills by name. Call this before acting on a task that matches a skill's description.";
        public override JsonElement JsonSchema => Schema;

        protected override ValueTask<object?> InvokeCoreAsync(AIFunctionArguments arguments, CancellationToken cancellationToken)
        {
            var name = Arg(arguments, "name");
            if (!names.Contains(name))
                return new ValueTask<object?>($"Unknown skill \"{name}\". Available: {string.Join(", ", names)}.");
            try
            {
                var skill = Shuttle.LoadSkill(ctx, name);
                onLoaded?.Invoke(name);
                return new ValueTask<object?>(LoadObservation(name, skill.Instructions, toolNames.GetValueOrDefault(name)));
            }
            catch (Exception ex)
            {
                return new ValueTask<object?>($"Error loading skill {name}: {ex.Message}");
            }
        }
    }

    private sealed class ReadSkillResourceFunction(IContext ctx, HashSet<string> names) : AIFunction
    {
        private static readonly JsonElement Schema = JsonDocument.Parse("""
            {"type":"object","properties":{"name":{"type":"string","description":"The skill's name."},"path":{"type":"string","description":"The bundled file's path, e.g. references/forms.md."}},"required":["name","path"]}
            """).RootElement;

        public override string Name => ReadSkillResourceTool;
        public override string Description =>
            "Read one file bundled with a loaded skill, by the path the skill's instructions give (relative to the skill).";
        public override JsonElement JsonSchema => Schema;

        protected override async ValueTask<object?> InvokeCoreAsync(AIFunctionArguments arguments, CancellationToken cancellationToken)
        {
            var name = Arg(arguments, "name");
            var path = Arg(arguments, "path");
            if (!names.Contains(name)) return $"Unknown skill \"{name}\".";
            try
            {
                return await Shuttle.SkillResourceAsync(ctx, name, path, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                return $"Error reading {path} from skill {name}: {ex.Message}";
            }
        }
    }
}
