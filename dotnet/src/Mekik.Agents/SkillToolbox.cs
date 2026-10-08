using Microsoft.Extensions.AI;

using Ilmek;
using Mekik;

namespace Mekik.Agents;

/// <summary>
/// The tools held under skills for one <see cref="Agent.RunAsync"/> run (each catalog
/// entry's own <see cref="SkillEntry{TTool}.Tools"/> merged with
/// <see cref="AgentRunOptions.SkillTools"/>): which skill owns which wrapped function,
/// and which of them the model may be offered given the skills loaded so far.
/// </summary>
internal sealed class SkillToolbox
{
    // skill name → its wrapped functions, in declaration order
    private readonly Dictionary<string, IReadOnlyList<AIFunction>> _bySkill = new(StringComparer.Ordinal);

    // tool name → every skill that holds it (a tool may sit under several skills)
    private readonly Dictionary<string, List<string>> _skillsOf = new(StringComparer.Ordinal);

    /// <summary>Skill name → the names of its tools, for the <c>load_skill</c> observation.</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<string>> ToolNames =>
        _bySkill.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)kv.Value.Select(f => f.Name).ToList(), StringComparer.Ordinal);

    /// <summary>Every skill-held function (deduplicated by name).</summary>
    public IEnumerable<AIFunction> All => _bySkill.Values.SelectMany(f => f).DistinctBy(f => f.Name);

    public bool Has(string skill) => _bySkill.ContainsKey(skill);

    /// <summary>The functions of the given skills, deduplicated by name.</summary>
    public IEnumerable<AIFunction> ToolsOf(IEnumerable<string> skills) =>
        skills.Where(_bySkill.ContainsKey).SelectMany(s => _bySkill[s]).DistinctBy(f => f.Name);

    /// <summary>
    /// When <paramref name="tool"/> is skill-held and none of its skills is active, the skills
    /// that hold it (any one of them unlocks it); otherwise null.
    /// </summary>
    public IReadOnlyList<string>? LockedSkillsOf(string tool, IReadOnlySet<string> active) =>
        _skillsOf.TryGetValue(tool, out var owners) && !owners.Any(active.Contains) ? owners : null;

    /// <summary>The observation for a call to a skill's tool before any skill holding it is loaded.</summary>
    public static string LockedObservation(string tool, IReadOnlyList<string> owners) =>
        owners.Count == 1
            ? $"Tool {tool} belongs to skill \"{owners[0]}\". Call {SkillFunctions.LoadSkillTool} with name \"{owners[0]}\" first."
            : $"Tool {tool} belongs to skills {string.Join(", ", owners.Select(o => $"\"{o}\""))}. Call {SkillFunctions.LoadSkillTool} with the one that fits the task first.";

    /// <summary>
    /// Collect the tools each visible skill owns (<see cref="SkillEntry{TTool}"/> with
    /// <see cref="AIFunction"/> tools) plus the explicit <see cref="AgentRunOptions.SkillTools"/>
    /// for the same skill, and wrap them with <see cref="MekikTools"/> (same policies as the
    /// always-on tools). A skill hidden by the node's tag/source filter is skipped.
    /// </summary>
    /// <exception cref="ArgumentException">
    /// A skill tool shares its name with an always-on tool, or two different functions under
    /// skills share one name — the model could not tell them apart.
    /// </exception>
    public static SkillToolbox Build(IContext ctx, AgentRunOptions options, IReadOnlyList<AIFunction> alwaysOn)
    {
        var box = new SkillToolbox();

        // The entry's own tools first, then the explicit ones for the same skill.
        var held = new Dictionary<string, List<AIFunction>>(StringComparer.Ordinal);
        foreach (var (skill, owned) in Shuttle.SkillTools<AIFunction>(ctx, options.SkillTags, options.SkillSource))
            held[skill] = [.. owned];

        var catalog = Shuttle.Skills(ctx, options.SkillTags, options.SkillSource).Select(s => s.Name).ToList();
        var visible = catalog.ToHashSet(StringComparer.Ordinal);
        foreach (var (skill, extra) in options.SkillTools ?? new Dictionary<string, IReadOnlyList<AIFunction>>())
        {
            if (!visible.Contains(skill) || extra is null || extra.Count == 0) continue;
            if (!held.TryGetValue(skill, out var merged)) held[skill] = merged = [];
            foreach (var fn in extra)
                if (!merged.Contains(fn)) merged.Add(fn);
        }

        var baseNames = alwaysOn.Select(t => t.Name).ToHashSet(StringComparer.Ordinal);
        var originals = new Dictionary<string, AIFunction>(StringComparer.Ordinal);

        foreach (var (skill, functions) in held)
        {
            if (functions.Count == 0) continue;
            foreach (var fn in functions)
            {
                if (baseNames.Contains(fn.Name))
                    throw new ArgumentException($"Tool \"{fn.Name}\" is both always-on and held under skill \"{skill}\".", nameof(options));
                if (originals.TryGetValue(fn.Name, out var seen) && !ReferenceEquals(seen, fn))
                    throw new ArgumentException($"Two different tools named \"{fn.Name}\" are held under skills.", nameof(options));
                originals[fn.Name] = fn;
                if (!box._skillsOf.TryGetValue(fn.Name, out var owners)) box._skillsOf[fn.Name] = owners = [];
                if (!owners.Contains(skill)) owners.Add(skill);
            }

            box._bySkill[skill] = MekikTools.Wrap(ctx, functions, options.Policies, options.DefaultPolicy).ToList();
        }

        // Owners in catalog order, however they were declared (entry tools first, then
        // SkillTools), so a premature call's refusal lists them the way the prompt does.
        var rank = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var i = 0; i < catalog.Count; i++) rank.TryAdd(catalog[i], i);
        foreach (var owners in box._skillsOf.Values)
            owners.Sort((a, b) => rank.GetValueOrDefault(a).CompareTo(rank.GetValueOrDefault(b)));

        return box;
    }
}
