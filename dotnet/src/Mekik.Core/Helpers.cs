using System.Runtime.CompilerServices;
using System.Text;
using Ilmek;

namespace Mekik;

/// <summary>
/// Author-facing helpers (PROTOCOL.md §6), mirror of the TypeScript `mekik.*`
/// namespace. Each takes ilmek's <see cref="IContext"/> and emits the custom
/// payloads <see cref="TurnMapper"/> recognises — no ambient storage, because
/// ilmek already threads <c>ctx</c> through every node.
///
/// <para>Named <c>Shuttle</c>, not <c>Mekik</c>: a static class sharing its
/// namespace's name binds ambiguously (the same reason ilmek uses
/// <c>IlmekRuntime</c>). "Shuttle" is what <i>mekik</i> means — the loom part that
/// carries the thread across, which is exactly this layer's job. Call sites read
/// <c>Shuttle.Ui(ctx, …)</c>, <c>Shuttle.Approve(ctx, …)</c>.</para>
/// </summary>
public static class Shuttle
{
    private const string MekikKey = "$mekik";

    // Per-ctx tool counter, so repeated tool calls get stable, replay-safe ids.
    private static readonly ConditionalWeakTable<IContext, StrongBox<int>> ToolCounters = new();

    private static string NextToolId(IContext ctx)
    {
        var box = ToolCounters.GetValue(ctx, _ => new StrongBox<int>(0));
        var n = box.Value++;
        // Stable across replay: taskId is unchanged and call order is deterministic,
        // so the resume pass mints the same id and its re-emitted trace upserts.
        return $"{(string.IsNullOrEmpty(ctx.TaskId) ? "task" : ctx.TaskId)}:tool:{n}";
    }

    /// <summary>
    /// Emit one `tool_call` frame. The low-level primitive behind <see cref="Tool{T}(IContext, string, IReadOnlyDictionary{string, object}, Func{ValueTask{T}})"/>,
    /// public so an integration that does its own execution (e.g. Mekik.Agents,
    /// where the model invokes the function) can still produce the same trace
    /// without re-deriving the reserved <c>$mekik</c> payload shape. Traces upsert
    /// by <c>call["id"]</c>, so re-emitting the same id is how a
    /// running→completed pair is expressed.
    /// </summary>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="call">The trace record: <c>{ id, name, status, params?, result?, error? }</c>.</param>
    /// <seealso cref="NextToolCallId"/>
    public static void ToolTrace(IContext ctx, IReadOnlyDictionary<string, object?> call) =>
        ctx.Emit(new Dictionary<string, object?> { [MekikKey] = "tool", ["call"] = call });

    /// <summary>Mint a replay-stable <c>tool_call</c> id for this ctx — stable across an
    /// interrupt/resume, so a re-emitted trace upserts instead of duplicating.</summary>
    /// <param name="ctx">The ilmek node context.</param>
    /// <returns>A deterministic id for the next tool call on this context.</returns>
    /// <seealso cref="ToolTrace"/>
    public static string NextToolCallId(IContext ctx) => NextToolId(ctx);

    // ── skills (PROTOCOL.md §12) ──────────────────────────────────────────────

    // Per-ctx skill counter — same replay-stability story as the tool counter.
    private static readonly ConditionalWeakTable<IContext, StrongBox<int>> SkillCounters = new();

    private static string NextSkillId(IContext ctx)
    {
        var box = SkillCounters.GetValue(ctx, _ => new StrongBox<int>(0));
        var n = box.Value++;
        return $"{(string.IsNullOrEmpty(ctx.TaskId) ? "task" : ctx.TaskId)}:skill:{n}";
    }

    /// <summary>The turn's skill source (§12.3), or null when the app configured no skills and accepted none.</summary>
    private static ISkillSource? SkillSourceOf(IContext ctx) => ctx.Meta?.GetValueOrDefault("skills") as ISkillSource;

    /// <summary>
    /// The skills this turn may load (PROTOCOL.md §12.3) — level 1: the summaries a
    /// model reads before choosing. The server's catalog (<see cref="MekikOptions.Skills"/>)
    /// plus whatever client-declared skills the app accepted, each stamped with its
    /// <see cref="SkillSummary.Source"/>. Empty when the app configured neither.
    /// </summary>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="tags">
    /// Tag filter — the client-tool rule (§11.2): an untagged skill is unrestricted and
    /// matches every query; a tagged skill matches only when its tags intersect these.
    /// </param>
    /// <param name="source">Keep only skills of one origin: <see cref="SkillOrigin.Server"/> or <see cref="SkillOrigin.Client"/>.</param>
    /// <example><code>var system = basePrompt + "\n\n" + Shuttle.SkillsPrompt(ctx, tags: ["billing"]);</code></example>
    public static IReadOnlyList<SkillSummary> Skills(IContext ctx, IReadOnlyList<string>? tags = null, string? source = null)
    {
        if (SkillSourceOf(ctx) is not { } src) return [];
        IEnumerable<SkillSummary> query = src.List();
        if (source is not null) query = query.Where(s => s.Source == source);
        if (tags is not null)
        {
            var wanted = new HashSet<string>(tags, StringComparer.Ordinal);
            query = query.Where(s => s.Tags is null || s.Tags.Count == 0 || s.Tags.Any(wanted.Contains));
        }
        return query.ToList();
    }

    /// <summary>
    /// Level 1 as text: the <c>&lt;available_skills&gt;</c> block for a system prompt, over
    /// <see cref="Skills"/> with the same filter. <c>""</c> when there is nothing to list —
    /// safe to append unconditionally.
    /// </summary>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="tags">Which skills to list; see <see cref="Skills"/>.</param>
    /// <param name="source">Which origin to list; see <see cref="Skills"/>.</param>
    /// <param name="intro">The intro sentence; <see cref="Mekik.Skills.DefaultIntro"/> unless given, null for the block alone.</param>
    public static string SkillsPrompt(IContext ctx, IReadOnlyList<string>? tags = null, string? source = null, string? intro = Mekik.Skills.DefaultIntro) =>
        Mekik.Skills.RenderPrompt(Skills(ctx, tags, source), intro);

    /// <summary>
    /// The tools the visible <b>server</b> skills own (<see cref="SkillEntry{TTool}.Tools"/>,
    /// PROTOCOL.md §12.6), keyed by skill name — what an agent loop holds back until the
    /// model loads each skill. Same filter as <see cref="Skills"/>; a skill without tools is
    /// absent, and a client-declared skill never contributes (declarations carry no tools).
    /// Reads the catalog without emitting a <c>skill</c> frame. Mirror of TypeScript's
    /// <c>mekik.skillTools</c>.
    /// </summary>
    /// <typeparam name="TTool">The agent framework's tool type, e.g. <c>AIFunction</c>.</typeparam>
    /// <exception cref="InvalidOperationException">A skill owns a tool that is not a <typeparamref name="TTool"/>.</exception>
    public static IReadOnlyDictionary<string, IReadOnlyList<TTool>> SkillTools<TTool>(
        IContext ctx, IReadOnlyList<string>? tags = null, string? source = null)
    {
        var result = new Dictionary<string, IReadOnlyList<TTool>>(StringComparer.Ordinal);
        if (SkillSourceOf(ctx) is not { } src) return result;
        foreach (var summary in Skills(ctx, tags, source))
        {
            if (summary.Source == SkillOrigin.Client) continue;
            if (src.Get(summary.Name) is not { } entry || entry.Source == SkillOrigin.Client) continue;
            var owned = entry.ToolObjects;
            if (owned.Count == 0) continue;
            var typed = new List<TTool>(owned.Count);
            foreach (var t in owned)
            {
                if (t is not TTool tool)
                    throw new InvalidOperationException(
                        $"Skill \"{summary.Name}\" owns a tool of type {t?.GetType().Name ?? "null"}, not {typeof(TTool).Name}.");
                typed.Add(tool);
            }
            result[summary.Name] = typed;
        }
        return result;
    }

    /// <summary>
    /// Emit a single <c>skill</c> frame — the low-level primitive behind
    /// <see cref="LoadSkill"/>, public for integrations that resolve skills themselves.
    /// Upserts by <c>use["id"]</c>.
    /// </summary>
    public static void SkillTrace(IContext ctx, IReadOnlyDictionary<string, object?> use) =>
        ctx.Emit(new Dictionary<string, object?> { [MekikKey] = "skill", ["use"] = use });

    /// <summary>
    /// Load one skill's instructions — level 2 (PROTOCOL.md §12.5) — and surface the use
    /// as a <c>skill</c> frame so the conversation shows which skill the agent is following.
    /// </summary>
    /// <remarks>
    /// Loading is a catalog read, not a side effect, so it is not journaled; the trace id
    /// is replay-stable (<c>TaskId</c> + call order), so a resume pass upserts the same
    /// frame. An unknown name emits a <c>status: "error"</c> trace and <b>throws</b>
    /// <see cref="KeyNotFoundException"/> — the agent wrappers turn that into an
    /// observation the model can read instead.
    /// </remarks>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="name">The skill's name, as listed by <see cref="Skills"/>.</param>
    /// <returns>The skill with its <see cref="SkillEntry.Instructions"/>.</returns>
    /// <example><code>var pdf = Shuttle.LoadSkill(ctx, "pdf"); messages.Add(new(ChatRole.System, pdf.Instructions));</code></example>
    public static SkillEntry LoadSkill(IContext ctx, string name)
    {
        if (string.IsNullOrEmpty(name)) throw new ArgumentException("LoadSkill needs a skill name", nameof(name));
        var id = NextSkillId(ctx);
        var entry = SkillSourceOf(ctx)?.Get(name);
        if (entry is null)
        {
            var error = $"unknown skill \"{name}\"";
            SkillTrace(ctx, new Dictionary<string, object?> { ["id"] = id, ["name"] = name, ["status"] = "error", ["error"] = error });
            throw new KeyNotFoundException(error);
        }
        var use = new Dictionary<string, object?> { ["id"] = id, ["name"] = name, ["status"] = "loaded" };
        if (entry.Source is not null) use["source"] = entry.Source;
        SkillTrace(ctx, use);
        return entry;
    }

    /// <summary>
    /// Read one of a skill's bundled files — level 3 (PROTOCOL.md §12.5). Only a server
    /// skill backed by folders has files; the call throws <see cref="NotSupportedException"/>
    /// for a client-declared skill or a source without resources. The catalog confines
    /// <paramref name="path"/> to the skill folder.
    /// </summary>
    public static Task<string> SkillResourceAsync(IContext ctx, string name, string path, CancellationToken ct = default)
    {
        var src = SkillSourceOf(ctx);
        if (src is null || !src.HasResources) throw new NotSupportedException($"skill \"{name}\" has no resources");
        return src.ReadResourceAsync(name, path, ct);
    }

    /// <summary>True when the turn's skill source can serve bundled files (level 3).</summary>
    public static bool SkillResourcesAvailable(IContext ctx) => SkillSourceOf(ctx)?.HasResources ?? false;

    // Per-ctx ui counter — same replay-stability story as the tool counter.
    private static readonly ConditionalWeakTable<IContext, StrongBox<int>> UiCounters = new();

    private static string NextUiId(IContext ctx)
    {
        var box = UiCounters.GetValue(ctx, _ => new StrongBox<int>(0));
        var n = box.Value++;
        return $"{(string.IsNullOrEmpty(ctx.TaskId) ? "task" : ctx.TaskId)}:ui:{n}";
    }

    private static void EmitChunk(IContext ctx, Dictionary<string, object?> chunk) =>
        ctx.Emit(new Dictionary<string, object?> { [MekikKey] = "genui", ["chunk"] = chunk });

    /// <summary>Stream one prose delta to the client as a generative-UI text chunk.</summary>
    /// <remarks>
    /// Each chunk is a <c>genui</c> frame: it renders live and is persisted and replayed like
    /// every <c>genui</c> frame (PROTOCOL.md §4.3), so streamed text is already in the transcript.
    /// It is not the reply — that is a separate <c>text</c> frame emitted at run end from the
    /// reply selector — so a node that streams its whole answer returns no reply; returning
    /// the same text again shows the answer twice.
    /// A non-null <paramref name="id"/> is the chunk's client-side key — the same id
    /// updates that element in place, and opts out of text-run coalescing (PROTOCOL.md §4.1).
    /// </remarks>
    /// <param name="ctx">The ilmek node context (threaded into every node).</param>
    /// <param name="content">The prose fragment to append to the current turn's stream.</param>
    /// <param name="id">Optional client-side chunk key; omit and mekik manages it.</param>
    public static void Text(IContext ctx, string content, object? id = null)
    {
        var chunk = new Dictionary<string, object?> { ["type"] = "text", ["content"] = content };
        if (id is not null) chunk["id"] = id;
        EmitChunk(ctx, chunk);
    }

    /// <summary>Stream an async sequence of prose deltas as live text chunks and return the full text —
    /// the token-by-token pattern in a single call.</summary>
    /// <remarks>
    /// Each delta is emitted with <see cref="Text"/>, so consecutive deltas share one stream text-run
    /// and a client renders a <b>single growing bubble</b>, not one bubble per token (PROTOCOL.md §4.1).
    /// The chunks are persisted and replayed like any <c>genui</c> frame, so the bubble is already the
    /// answer: keep the return value (every delta concatenated) for your own use and return no
    /// <c>reply</c>, or the client shows the answer twice (PROTOCOL.md §4.3). Empty deltas are skipped.
    /// </remarks>
    /// <typeparam name="T">The element type of the source stream (e.g. a model's streaming chunk).</typeparam>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="deltas">The async source, e.g. an <see cref="IAsyncEnumerable{T}"/> from a model client.</param>
    /// <param name="select">Pulls the text fragment out of each element.</param>
    /// <param name="ct">Cancellation for the enumeration; pass <c>ctx.CancellationToken</c>.</param>
    /// <returns>The full text accumulated from every emitted delta.</returns>
    /// <example><code>
    /// var full = await Shuttle.StreamText(ctx, chat.GetStreamingResponseAsync(messages, options, ctx.CancellationToken), u => u.Text);
    /// return Update.Of("summary", full); // no "reply": the streamed bubble is the answer
    /// </code></example>
    public static async Task<string> StreamText<T>(
        IContext ctx,
        IAsyncEnumerable<T> deltas,
        Func<T, string?> select,
        CancellationToken ct = default)
    {
        var full = new StringBuilder();
        await foreach (var delta in deltas.WithCancellation(ct).ConfigureAwait(false))
        {
            var piece = select(delta);
            if (string.IsNullOrEmpty(piece)) continue;
            Text(ctx, piece);
            full.Append(piece);
        }
        return full.ToString();
    }

    /// <summary>Stream raw string deltas — the selector-free overload of <see cref="StreamText{T}"/>.</summary>
    public static Task<string> StreamText(IContext ctx, IAsyncEnumerable<string> deltas, CancellationToken ct = default) =>
        StreamText(ctx, deltas, static s => s, ct);

    // ── auth claims (PROTOCOL.md §7) ───────────────────────────────────────────

    private static readonly IReadOnlyDictionary<string, object?> EmptyClaims = new Dictionary<string, object?>();

    /// <summary>
    /// The authenticated claims for this turn — the <c>AuthVerdict.Claims</c> the
    /// authenticator returned, which the engine places at <c>ctx.Meta["auth"]</c>. Empty
    /// when the app runs without an authenticator or the connection is anonymous.
    /// </summary>
    public static IReadOnlyDictionary<string, object?> AuthClaims(IContext ctx) =>
        ctx.Meta.GetValueOrDefault("auth") as IReadOnlyDictionary<string, object?> ?? EmptyClaims;

    /// <summary>
    /// Read a claim as a list of strings, coercing the shapes it survives a JSON round-trip
    /// as: a string list, a single string, or a list of boxed values. Missing ⇒ empty.
    /// </summary>
    public static IReadOnlyList<string> ClaimStrings(IReadOnlyDictionary<string, object?> claims, string key) =>
        claims.GetValueOrDefault(key) switch
        {
            IEnumerable<string> strings => strings.ToList(),
            string one => string.IsNullOrEmpty(one) ? [] : [one],
            System.Collections.IEnumerable seq => seq.Cast<object?>()
                .Select(InvariantText)
                .Where(x => !string.IsNullOrEmpty(x))
                .Select(x => x!)
                .ToList(),
            _ => [],
        };

    /// <summary>A claim value as text, the way it reads in TypeScript: culture-free numbers, lowercase booleans.</summary>
    private static string? InvariantText(object? x) => x switch
    {
        null => null,
        string s => s,
        bool b => b ? "true" : "false",
        IFormattable f => f.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
        _ => x.ToString(),
    };

    /// <summary>Mount or update a generative-UI component by its client-registry name.</summary>
    /// <remarks>Emitting the same component again with new props updates it in place. mekik
    /// ships no components — it streams the instruction to render one the client has registered.
    /// Pass <paramref name="id"/> to key the instance yourself — that is how two instances of
    /// the <i>same</i> component stay distinct and individually updatable; see
    /// <see cref="Mount"/> for the managed form.</remarks>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="component">The component name registered on the client (chativa).</param>
    /// <param name="props">Props handed to the component; omit for one that needs none.</param>
    /// <param name="id">Optional client-side chunk key; omit and mekik manages it.</param>
    /// <example><code>Shuttle.Ui(ctx, "order-card", new Dictionary&lt;string, object?&gt; { ["id"] = order.Id });</code></example>
    public static void Ui(IContext ctx, string component, IReadOnlyDictionary<string, object?>? props = null, object? id = null)
    {
        var chunk = new Dictionary<string, object?> { ["type"] = "ui", ["component"] = component };
        if (props is not null) chunk["props"] = props;
        if (id is not null) chunk["id"] = id;
        EmitChunk(ctx, chunk);
    }

    /// <summary>
    /// Mount a GenUI component and get a <see cref="UiHandle"/> for updating it in
    /// place — chunk ids managed for you. Mirror of TypeScript <c>mekik.mount</c>.
    /// </summary>
    /// <remarks>
    /// The handle's id is minted replay-stable (like tool ids: <c>TaskId</c> + call order),
    /// so the resume pass after an interrupt re-emits the same id and the client updates the
    /// existing element instead of duplicating it. Pass <paramref name="id"/> to pick the key
    /// yourself (e.g. the order id, so the same order always maps to the same card).
    /// </remarks>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="component">The component name registered on the client.</param>
    /// <param name="props">Initial props; omit for a component that needs none.</param>
    /// <param name="id">Optional explicit chunk key.</param>
    /// <returns>A handle whose <see cref="UiHandle.Update"/> re-renders this same instance.</returns>
    public static UiHandle Mount(IContext ctx, string component, IReadOnlyDictionary<string, object?>? props = null, object? id = null)
    {
        var key = id ?? NextUiId(ctx);
        Ui(ctx, component, props, key);
        return new UiHandle(ctx, component, key);
    }

    /// <summary>Dispatch a named event to a mounted GenUI component — advance a step,
    /// highlight a row — without re-mounting it.</summary>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="name">The event name the component listens for.</param>
    /// <param name="payload">Optional event payload.</param>
    /// <param name="id">Optional client-side chunk key; omit and mekik manages it.</param>
    public static void Event(IContext ctx, string name, object? payload = null, object? id = null)
    {
        var chunk = new Dictionary<string, object?> { ["type"] = "event", ["name"] = name };
        if (payload is not null) chunk["payload"] = payload;
        if (id is not null) chunk["id"] = id;
        EmitChunk(ctx, chunk);
    }

    /// <summary>Run a side effect exactly once and surface it as a <c>tool_call</c> trace.</summary>
    /// <remarks>
    /// <paramref name="fn"/> executes inside ilmek's <c>ctx.StepAsync</c>, so its result is
    /// journaled: on the replay pass after an interrupt the node re-runs, but <paramref name="fn"/>
    /// is not called again — it returns the recorded value. This is what stops a paused-then-resumed
    /// node from repeating a charge or a lookup. The trace re-emits on replay, but as an upsert by id
    /// the client just updates the existing entry. An <see cref="InterruptSignalException"/> is
    /// rethrown untouched — a pause is not a failure (the .NET rethrow rule, PROTOCOL.md §9).
    /// </remarks>
    /// <typeparam name="T">The tool's result type. Must survive a journal round-trip (plain data).</typeparam>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="name">Tool name; shown in the trace and used as the journal step key.</param>
    /// <param name="params">Parameters, surfaced in the <c>running</c> trace.</param>
    /// <param name="fn">The side effect. Runs once ever, across any number of resumes.</param>
    /// <returns>The tool's result — the recorded value on a replay pass.</returns>
    /// <example><code>var order = await Shuttle.Tool(ctx, "get_order", p, () => Orders.Get(id));</code></example>
    public static async ValueTask<T> Tool<T>(IContext ctx, string name, IReadOnlyDictionary<string, object?> @params, Func<ValueTask<T>> fn)
    {
        var id = NextToolId(ctx);
        void EmitTool(Dictionary<string, object?> call) => ToolTrace(ctx, call);

        EmitTool(new Dictionary<string, object?> { ["id"] = id, ["name"] = name, ["status"] = "running", ["params"] = @params });
        try
        {
            var result = await ctx.StepAsync(name, fn).ConfigureAwait(false);
            EmitTool(new Dictionary<string, object?> { ["id"] = id, ["name"] = name, ["status"] = "completed", ["result"] = result });
            return result;
        }
        catch (InterruptSignalException)
        {
            // An interrupt is not a tool failure — rethrow untouched so the pause
            // propagates. This IS the .NET rethrow rule (PROTOCOL.md §9).
            throw;
        }
        catch (Exception ex)
        {
            EmitTool(new Dictionary<string, object?> { ["id"] = id, ["name"] = name, ["status"] = "error", ["error"] = ex.Message });
            throw;
        }
    }

    /// <summary>Synchronous-body overload of <see cref="Tool{T}(IContext, string, IReadOnlyDictionary{string, object?}, Func{ValueTask{T}})"/>.</summary>
    public static ValueTask<T> Tool<T>(IContext ctx, string name, IReadOnlyDictionary<string, object?> @params, Func<T> fn) =>
        Tool(ctx, name, @params, () => new ValueTask<T>(fn()));

    // ── client tools (PROTOCOL.md §11) ────────────────────────────────────────

    /// <summary>
    /// The client tools this turn may call (PROTOCOL.md §11.2) — the sanitized,
    /// server-accepted union of what the conversation's live connections declared,
    /// snapshotted at run start into <c>ctx.Meta["clientTools"]</c>. Empty unless
    /// the app opted in via <see cref="MekikOptions.ClientTools"/>.
    /// </summary>
    /// <remarks>
    /// The tag rule (§11.2): a tool with <b>no tags is unrestricted</b> and matches
    /// every query; a tagged tool matches only when its tags intersect
    /// <paramref name="tags"/>. So a frontend tags the tools it wants scoped to
    /// particular nodes and leaves general-purpose ones untagged. The returned
    /// definitions are ready to hand to a model as its tool list; dispatch a
    /// model's call with <see cref="CallClientToolAsync{T}"/>.
    /// </remarks>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="tags">Optional tag filter; see remarks.</param>
    /// <param name="mode">Optional invocation-mode filter (<c>"call"</c> or <c>"notify"</c>).</param>
    /// <returns>The matching definitions, in declaration order.</returns>
    /// <example><code>var tools = Shuttle.ClientTools(ctx, tags: ["billing"]);</code></example>
    public static IReadOnlyList<ClientToolDefinition> ClientTools(IContext ctx, IReadOnlyList<string>? tags = null, string? mode = null)
    {
        if (ctx.Meta?.GetValueOrDefault("clientTools") is not IReadOnlyList<ClientToolDefinition> defs) return [];
        IEnumerable<ClientToolDefinition> query = defs;
        if (mode is not null) query = query.Where(d => (d.Mode ?? "call") == mode);
        if (tags is not null)
        {
            var wanted = tags.ToHashSet();
            query = query.Where(d => d.Tags is null || d.Tags.Count == 0 || d.Tags.Any(wanted.Contains));
        }
        return query.ToList();
    }

    /// <summary>
    /// Invoke a tool the <b>client</b> declared (PROTOCOL.md §11.3) and return the
    /// result its handler produced.
    /// </summary>
    /// <remarks>
    /// For a <c>"call"</c>-mode tool (the default) this is a real pause with
    /// everything a pause buys: the run parks on an interrupt whose frame carries
    /// <c>data.tool = {name, params}</c>, the client executes its handler and
    /// answers with a <c>resume</c> carrying <c>{ok: true, result}</c> (or
    /// <c>{ok: false, error}</c>, which makes this call <b>throw</b>), and the wait
    /// survives a disconnect or restart — <c>welcome.pending</c> re-announces the
    /// open call so a reconnecting client can retry it. The node re-runs from the
    /// top on resume, so wrap side effects in
    /// <see cref="Tool{T}(IContext, string, IReadOnlyDictionary{string, object?}, Func{ValueTask{T}})"/>,
    /// exactly as around any other pause.
    ///
    /// <para>A <c>"notify"</c>-mode tool never parks: the invocation streams as a
    /// genui event chunk (<see cref="Protocol.ClientToolEvent"/>) in the turn's
    /// stream and the call returns immediately with <c>default</c>.</para>
    ///
    /// <para>Either way the call is surfaced as a <c>tool_call</c> running →
    /// completed/error trace, so the conversation shows the client-side work like
    /// any server tool.</para>
    /// </remarks>
    /// <typeparam name="T">The shape of the client handler's result.</typeparam>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="name">The declared tool name (see <see cref="ClientTools(IContext, IReadOnlyList{string}?, string?)"/>).</param>
    /// <param name="params">Parameters for the client handler, matching the declared schema.</param>
    /// <param name="key">Journal key; defaults to <c>tool:{name}</c>, so one node can call several client tools.</param>
    /// <returns>The handler's result (<c>default</c> for a notify tool).</returns>
    /// <example><code>var when = await Shuttle.CallClientToolAsync&lt;IReadOnlyDictionary&lt;string, object?&gt;&gt;(ctx, "pick_date", p);</code></example>
    public static async ValueTask<T?> CallClientToolAsync<T>(
        IContext ctx,
        string name,
        IReadOnlyDictionary<string, object?>? @params = null,
        string? key = null)
    {
        if (string.IsNullOrEmpty(name)) throw new ArgumentException("a client tool call needs a tool name", nameof(name));
        var def = ClientTools(ctx).FirstOrDefault(d => d.Name == name);
        var id = NextToolId(ctx);
        void Trace(Dictionary<string, object?> call) => ToolTrace(ctx, call);

        var running = new Dictionary<string, object?> { ["id"] = id, ["name"] = name, ["status"] = "running" };
        if (@params is not null) running["params"] = @params;
        Trace(running);

        if ((def?.Mode ?? "call") == "notify")
        {
            // Fire-and-forget: the invocation is an event chunk in the turn stream,
            // keyed by the (replay-stable) trace id so a resume pass upserts it.
            var notice = new Dictionary<string, object?> { ["name"] = name };
            if (@params is not null) notice["params"] = @params;
            Event(ctx, Protocol.ClientToolEvent, notice, id);
            Trace(new Dictionary<string, object?> { ["id"] = id, ["name"] = name, ["status"] = "completed" });
            return default;
        }

        var call = new Dictionary<string, object?> { ["name"] = name };
        if (@params is not null) call["params"] = @params;
        var wrapped = new Dictionary<string, object?> { [MekikKey] = new Dictionary<string, object?> { ["tool"] = call } };
        var answer = await ctx.InterruptAsync<object?>(wrapped, key ?? $"tool:{name}").ConfigureAwait(false);

        // The result envelope (§11.3). A hand-rolled resume that skips the envelope
        // is taken as the bare result — lenient on purpose, so a human answering an
        // open tool call from another tab does not wedge the run.
        if (answer is IReadOnlyDictionary<string, object?> env && env.GetValueOrDefault("ok") is bool ok)
        {
            if (!ok)
            {
                var message = env.GetValueOrDefault("error") is string { Length: > 0 } err ? err : $"client tool \"{name}\" failed";
                Trace(new Dictionary<string, object?> { ["id"] = id, ["name"] = name, ["status"] = "error", ["error"] = message });
                throw new InvalidOperationException(message);
            }
            var result = env.GetValueOrDefault("result");
            Trace(new Dictionary<string, object?> { ["id"] = id, ["name"] = name, ["status"] = "completed", ["result"] = result });
            return (T?)result;
        }
        Trace(new Dictionary<string, object?> { ["id"] = id, ["name"] = name, ["status"] = "completed", ["result"] = answer });
        return (T?)answer;
    }

    /// <summary>Pause the run for a human and resume with their answer.</summary>
    /// <remarks>
    /// The node suspends at this call on the first pass — it never returns there. The engine emits an
    /// <c>interrupt</c> frame (with the optional <paramref name="ui"/>/<paramref name="actions"/> under
    /// the reserved <c>$mekik</c> key, PROTOCOL.md §4.2) and ends the run <c>interrupted</c>. When the
    /// client answers with a <c>resume</c> keyed by the interrupt id, the node re-runs from the top and
    /// this call returns the answer. Everything before it re-runs on resume, so wrap side effects in
    /// <see cref="Tool{T}(IContext, string, IReadOnlyDictionary{string, object?}, Func{ValueTask{T}})"/>.
    /// Pass neither <paramref name="ui"/> nor <paramref name="actions"/> for default Approve/Cancel chips.
    /// </remarks>
    /// <typeparam name="T">The shape of the human's answer.</typeparam>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="payload">The question, delivered to the client as <c>interrupt.data.payload</c>.</param>
    /// <param name="ui">Optional: mount a form component instead of relying on chips.</param>
    /// <param name="actions">Optional: quick-reply chips.</param>
    /// <param name="key">Journal key, when a node pauses more than once.</param>
    /// <returns>The human's answer, on resume.</returns>
    public static ValueTask<T> Approve<T>(
        IContext ctx,
        IReadOnlyDictionary<string, object?> payload,
        IReadOnlyDictionary<string, object?>? ui = null,
        IReadOnlyList<object>? actions = null,
        string key = "interrupt")
    {
        if (ui is null && actions is null) return ctx.InterruptAsync<T>(payload, key);

        var meta = new Dictionary<string, object?>();
        if (ui is not null) meta["ui"] = ui;
        if (actions is not null) meta["actions"] = actions;

        var wrapped = payload.ToDictionary(kv => kv.Key, kv => kv.Value);
        wrapped[MekikKey] = meta;
        return ctx.InterruptAsync<T>(wrapped, key);
    }

    /// <summary>Pause the run until a mounted component fires a named interaction.</summary>
    /// <remarks>
    /// The widget half of <see cref="Approve{T}"/>: instead of chips in the chat, the run
    /// waits for the <c>data-event</c> a component already on screen will send, and resolves
    /// to that event's payload. Mount the component first — this call never returns on the
    /// pass that parks, so anything emitted after it only reaches the client on the resume.
    ///
    /// <para>It is a real pause, with everything that buys: the run ends <c>interrupted</c>
    /// and the thread is checkpointed, so the wait survives a disconnect, a restart and a
    /// move to another node. The interrupt is re-announced in <c>welcome.pending</c> on
    /// reconnect like any other, carrying <c>data.event</c> so the client knows this pause
    /// answers by interaction and offers no default Approve/Cancel chips.</para>
    ///
    /// <para>The node re-runs from the top on resume, so wrap side effects in
    /// <see cref="Tool{T}(IContext, string, IReadOnlyDictionary{string, object?}, Func{ValueTask{T}})"/>
    /// and give the chunks you emitted literal ids, exactly as around any other pause.
    /// While several pauses are open ilmek requires them all answered at once, so an
    /// interaction that arrives while another pause is also open draws
    /// <c>error{incomplete_resume}</c> (PROTOCOL.md §4.4) — the same rule the
    /// <c>submit</c> shortcut plays by.</para>
    /// </remarks>
    /// <typeparam name="T">The shape of the event's payload.</typeparam>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="eventType">The component's <c>data-event</c> name.</param>
    /// <param name="payload">Optional context for the client, delivered as <c>interrupt.data.payload</c>.</param>
    /// <param name="ui">Optional: mount a component as part of the pause, as <see cref="Approve{T}"/> does.</param>
    /// <param name="key">Journal key; defaults to <c>event:{eventType}</c>, so one node can wait on several events.</param>
    /// <returns>The event's payload, on the interaction.</returns>
    /// <example><code>
    /// Shuttle.Ui(ctx, "delivery-card", props, id: "card-1");
    /// var req = await Shuttle.OnEvent&lt;IReadOnlyDictionary&lt;string, object?&gt;&gt;(ctx, "track_order");
    /// </code></example>
    public static ValueTask<T> OnEvent<T>(
        IContext ctx,
        string eventType,
        IReadOnlyDictionary<string, object?>? payload = null,
        IReadOnlyDictionary<string, object?>? ui = null,
        string? key = null)
    {
        if (string.IsNullOrEmpty(eventType))
            throw new ArgumentException("an awaited event needs a data-event name", nameof(eventType));

        var meta = new Dictionary<string, object?> { ["event"] = eventType };
        if (ui is not null) meta["ui"] = ui;

        var wrapped = payload?.ToDictionary(kv => kv.Key, kv => kv.Value) ?? new Dictionary<string, object?>();
        wrapped[MekikKey] = meta;
        return ctx.InterruptAsync<T>(wrapped, key ?? $"event:{eventType}");
    }

    // ── rich messages (PROTOCOL.md §4.5) ──────────────────────────────────────

    /// <summary>
    /// Emit one rich message — message type + JSON data, the low-level form.
    /// Mirror of TypeScript <c>mekik.message</c>.
    /// </summary>
    /// <remarks>
    /// The type names a message renderer on the client (chativa's
    /// <c>MessageTypeRegistry</c>: <c>image</c>, <c>card</c>, <c>carousel</c>, …); the
    /// data is that renderer's payload, delivered as a persistent rich message frame.
    /// Prefer the typed <see cref="Messages"/> catalog for chativa's built-ins.
    /// <c>"text"</c> is allowed (it emits a regular text frame); the protocol's other
    /// frame types are reserved and throw.
    /// </remarks>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="type">The client message-renderer name.</param>
    /// <param name="data">The renderer's payload.</param>
    /// <param name="id">Optional stable message id; omit and mekik mints one.</param>
    public static void Message(IContext ctx, string type, IReadOnlyDictionary<string, object?> data, string? id = null)
    {
        if (Protocol.ReservedFrameTypes.Contains(type) && type != "text")
            throw new ArgumentException($"\"{type}\" is a reserved protocol frame type, not a message type", nameof(type));
        var payload = new Dictionary<string, object?> { [MekikKey] = "message", ["messageType"] = type, ["data"] = data };
        if (id is not null) payload["id"] = id;
        ctx.Emit(payload);
    }

    // ── buttons, typed (no hand-written action JSON) ──────────────────────────

    /// <summary>
    /// Build one quick-reply button (a <c>MessageAction</c>) — the constructor that
    /// replaces hand-written <c>{ label, value }</c> dictionaries. Mirror of
    /// TypeScript <c>mekik.action</c>.
    /// </summary>
    /// <remarks>With no <paramref name="value"/> the answer is the <paramref name="label"/>
    /// string itself (protocol rule, PROTOCOL.md §3.2).</remarks>
    /// <example><code>Shuttle.Action("Approve", new Dictionary&lt;string, object?&gt; { ["approved"] = true })</code></example>
    public static IReadOnlyDictionary<string, object?> Action(string label, object? value = null) =>
        value is null
            ? new Dictionary<string, object?> { ["label"] = label }
            : new Dictionary<string, object?> { ["label"] = label, ["value"] = value };

    /// <summary>
    /// Pause the run on a set of buttons and resume with the one the human picked —
    /// the no-JSON way to put chips in the chat. Mirror of TypeScript <c>mekik.choose</c>.
    /// </summary>
    /// <remarks>
    /// Sugar over <see cref="Approve{T}"/>: emits an <c>interrupt</c> frame whose
    /// <c>actions</c> are the given options, and resolves on <c>resume</c> with the chosen
    /// action's <c>value</c> (its label string when the option has no value — a bare string
    /// option is both). <typeparamref name="T"/> is a contract with your own client, not a
    /// wire guarantee — same as <see cref="Approve{T}"/>.
    /// </remarks>
    /// <typeparam name="T">The answer type the chosen option's value resolves to.</typeparam>
    /// <param name="ctx">The ilmek node context.</param>
    /// <param name="payload">The question, delivered as <c>interrupt.data.payload</c>.</param>
    /// <param name="options">The buttons: bare strings and/or <see cref="Action"/>-built chips.</param>
    /// <param name="ui">Optional: also mount a form component; the chips remain as fallback.</param>
    /// <param name="key">Journal key, when a node pauses more than once.</param>
    /// <returns>The picked option's value, on resume.</returns>
    public static ValueTask<T> Choose<T>(
        IContext ctx,
        IReadOnlyDictionary<string, object?> payload,
        IReadOnlyList<object> options,
        IReadOnlyDictionary<string, object?>? ui = null,
        string key = "interrupt")
    {
        var actions = options
            .Select(o => o is string label ? Action(label) : o)
            .ToList<object>();
        return Approve<T>(ctx, payload, ui, actions, key);
    }

    /// <summary>String-question overload of <see cref="Choose{T}(IContext, IReadOnlyDictionary{string, object?}, IReadOnlyList{object}, IReadOnlyDictionary{string, object?}?, string)"/> —
    /// the question becomes <c>{ title }</c>, matching the TypeScript shorthand.</summary>
    public static ValueTask<T> Choose<T>(
        IContext ctx,
        string title,
        IReadOnlyList<object> options,
        IReadOnlyDictionary<string, object?>? ui = null,
        string key = "interrupt") =>
        Choose<T>(ctx, new Dictionary<string, object?> { ["title"] = title }, options, ui, key);
}

/// <summary>
/// A managed handle to one mounted GenUI component instance — mekik owns the chunk
/// id, the author just calls <see cref="Update"/>. Mirror of TypeScript <c>UiHandle</c>.
/// </summary>
/// <seealso cref="Shuttle.Mount"/>
public sealed class UiHandle
{
    private readonly IContext _ctx;
    private readonly string _component;

    /// <summary>The chunk id keying this instance on the client.</summary>
    public object Id { get; }

    internal UiHandle(IContext ctx, string component, object id)
    {
        _ctx = ctx;
        _component = component;
        Id = id;
    }

    /// <summary>Re-emit the component with new props — the client updates it in place.</summary>
    public void Update(IReadOnlyDictionary<string, object?> props) => Shuttle.Ui(_ctx, _component, props, Id);
}
