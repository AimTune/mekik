using Ilmek;

namespace Mekik;

/// <summary>Mints the ids that appear on the wire. Production: random. Fixtures: 1-based counters.</summary>
public interface IIdMinter
{
    /// <summary>For a `text` frame `id`.</summary>
    string Message();
    /// <summary>For a turn's genui `streamId`.</summary>
    string Stream();
}

/// <summary>The injected environment a <see cref="TurnMapper"/> needs (PROTOCOL.md §4).</summary>
public sealed record TurnMapperDeps
{
    /// <summary>Advance and return the conversation's next persistent `seq`.</summary>
    public required Func<long> AllocSeq { get; init; }
    public required IIdMinter Mint { get; init; }
    /// <summary>Wall clock (ms). Injected so fixtures pin `timestamp`.</summary>
    public required Func<long> Now { get; init; }
    /// <summary>Pick the run's reply text from final channel state at `run_end{done}` (PROTOCOL.md §4.3).</summary>
    public Func<IReadOnlyDictionary<string, object?>, string?>? Reply { get; init; }
}

/// <summary>
/// The canonical ilmek-event → mekik-frame mapping (PROTOCOL.md §4), mirror of
/// the TypeScript <c>TurnMapper</c>. Turn-stateful (owns the genui stream id and
/// chunk counter); every nondeterministic input is injected so the golden
/// fixtures replay identically across the two languages. Frames are built as
/// <c>Dictionary&lt;string, object?&gt;</c> for byte-exact wire parity.
/// </summary>
public sealed class TurnMapper
{
    private const string MekikKey = "$mekik";

    private readonly TurnMapperDeps _deps;
    private string? _streamId;
    private long _chunkCounter;
    // The id of the open text run, or null when none is open. Consecutive text
    // deltas share it so the client renders one growing bubble, not one per token.
    private long? _textRunId;

    public TurnMapper(TurnMapperDeps deps) => _deps = deps;

    /// <summary>Frames for one ilmek event, in emit order. May be empty (dropped events).</summary>
    public IReadOnlyList<Dictionary<string, object?>> Map(IlmekEvent ev) => ev switch
    {
        RunStartEvent => [Run("started")],
        CustomEvent c => MapCustom(c.Payload),
        InterruptEvent i => i.Pending.Select(InterruptFrame).ToList(),
        RunEndEvent r => MapRunEnd(r),
        // Not surfaced in v1 (PROTOCOL.md §4.1): node/step/state/checkpoint events.
        _ => [],
    };

    private List<Dictionary<string, object?>> MapCustom(object? payload)
    {
        if (TryTokenText(payload, out var text))
            return [GenuiFrame(new Dictionary<string, object?> { ["type"] = "text", ["content"] = text }, false)];

        if (payload is IReadOnlyDictionary<string, object?> d)
        {
            if (d.GetValueOrDefault(MekikKey) is "genui" && d.GetValueOrDefault("chunk") is IReadOnlyDictionary<string, object?> chunk)
                return [GenuiFrame(chunk, false)];

            if (d.GetValueOrDefault(MekikKey) is "tool" && d.GetValueOrDefault("call") is IReadOnlyDictionary<string, object?> call)
                return [new Dictionary<string, object?> { ["type"] = "tool_call", ["seq"] = _deps.AllocSeq(), ["data"] = call }];
        }

        // Unrecognised customs are dropped here (an extension hook maps them outside this closed core).
        return [];
    }

    private List<Dictionary<string, object?>> MapRunEnd(RunEndEvent ev)
    {
        switch (ev.Status)
        {
            case RunStatus.Interrupted:
                // The interrupt frames were already emitted from the `interrupt` event.
                return [Run("interrupted")];
            case RunStatus.Aborted:
                // No text: the last checkpoint stands and the thread is resumable.
                return [Run("aborted")];
            case RunStatus.Error:
                return [BotText("⚠️ " + FormatErrors(ev.Errors)), Run("error")];
            case RunStatus.Done:
            default:
                var frames = new List<Dictionary<string, object?>>();
                if (_streamId is not null)
                    frames.Add(GenuiFrame(new Dictionary<string, object?> { ["type"] = "event", ["name"] = "stream_done" }, true));
                var reply = _deps.Reply?.Invoke(ev.FinalState ?? EmptyState);
                if (!string.IsNullOrEmpty(reply)) frames.Add(BotText(reply));
                frames.Add(Run("finished"));
                return frames;
        }
    }

    private Dictionary<string, object?> InterruptFrame(Pending p) => new()
    {
        ["type"] = "interrupt",
        ["seq"] = _deps.AllocSeq(),
        ["id"] = p.Id,
        ["data"] = InterruptFrameData(p),
    };

    private Dictionary<string, object?> GenuiFrame(IReadOnlyDictionary<string, object?> chunk, bool done)
    {
        _streamId ??= _deps.Mint.Stream();
        // Clone, then give the chunk its stream-scoped id. Consecutive text deltas
        // share ONE id so a client renders one growing bubble instead of one bubble
        // per token (PROTOCOL.md §4.1); a ui/event chunk — or a caller-supplied id —
        // closes the open text run, so the next text delta starts a fresh bubble.
        var withId = chunk.ToDictionary(kv => kv.Key, kv => kv.Value);
        if (withId.GetValueOrDefault("id") is not null)
        {
            _textRunId = null; // an explicit id opts out of run coalescing
        }
        else if (withId.GetValueOrDefault("type") as string == "text")
        {
            _textRunId ??= ++_chunkCounter;
            withId["id"] = _textRunId.Value;
        }
        else
        {
            _textRunId = null; // a non-text chunk ends the current text run
            withId["id"] = ++_chunkCounter;
        }
        return new Dictionary<string, object?>
        {
            ["type"] = "genui",
            ["seq"] = _deps.AllocSeq(),
            ["streamId"] = _streamId,
            ["done"] = done,
            ["chunk"] = withId,
        };
    }

    private Dictionary<string, object?> BotText(string text) => new()
    {
        ["type"] = "text",
        ["id"] = _deps.Mint.Message(),
        ["seq"] = _deps.AllocSeq(),
        ["from"] = "bot",
        ["data"] = new Dictionary<string, object?> { ["text"] = text },
        ["timestamp"] = _deps.Now(),
    };

    private static Dictionary<string, object?> Run(string status) => new()
    {
        ["type"] = "run",
        ["data"] = new Dictionary<string, object?> { ["status"] = status },
    };

    // ── interrupt payload wrapping (PROTOCOL.md §4.2) ─────────────────────────

    /// <summary>Split an interrupt payload into `{ payload, ui?, actions? }` (public for `welcome.pending`).</summary>
    public static Dictionary<string, object?> InterruptFrameData(Pending p) => Unwrap(p.Payload);

    private static Dictionary<string, object?> Unwrap(object? payload)
    {
        if (payload is IReadOnlyDictionary<string, object?> dict &&
            dict.GetValueOrDefault(MekikKey) is IReadOnlyDictionary<string, object?> meta)
        {
            var rest = dict.Where(kv => kv.Key != MekikKey).ToDictionary(kv => kv.Key, kv => kv.Value);
            var data = new Dictionary<string, object?> { ["payload"] = rest };
            if (meta.GetValueOrDefault("ui") is { } ui) data["ui"] = ui;
            if (meta.GetValueOrDefault("actions") is { } actions) data["actions"] = actions;
            return data;
        }
        return new Dictionary<string, object?> { ["payload"] = payload };
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    private static readonly IReadOnlyDictionary<string, object?> EmptyState = new Dictionary<string, object?>();

    /// <summary>A token is ilmek's <see cref="TokenChunk"/> record OR a `{type:"token",text}` object.</summary>
    private static bool TryTokenText(object? payload, out string text)
    {
        switch (payload)
        {
            case TokenChunk tc:
                text = tc.Text;
                return true;
            case IReadOnlyDictionary<string, object?> d when d.GetValueOrDefault("type") is "token" && d.GetValueOrDefault("text") is string s:
                text = s;
                return true;
            default:
                text = "";
                return false;
        }
    }

    private static string FormatErrors(IReadOnlyList<(string Node, Exception Error)>? errors)
    {
        if (errors is null || errors.Count == 0) return "the run failed";
        return string.Join("; ", errors.Select(e => $"{e.Node}: {e.Error.Message}"));
    }
}

/// <summary>
/// Drive a whole recorded event list through a fresh mapper — the fixture entry
/// point. Production streams events one at a time through <see cref="TurnMapper.Map"/>.
/// </summary>
public static class Mapper
{
    public static List<Dictionary<string, object?>> EventToFrames(IEnumerable<IlmekEvent> events, TurnMapperDeps deps)
    {
        var mapper = new TurnMapper(deps);
        var frames = new List<Dictionary<string, object?>>();
        foreach (var ev in events) frames.AddRange(mapper.Map(ev));
        return frames;
    }
}
