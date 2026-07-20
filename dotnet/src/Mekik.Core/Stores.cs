namespace Mekik;

/// <summary>A wire frame — mekik models frames as dictionaries for byte-exact parity (PROTOCOL.md §9).</summary>
using Frame = System.Collections.Generic.IReadOnlyDictionary<string, object?>;

/// <summary>
/// The transcript port (PROTOCOL.md §2). Stores the persistent frames of a
/// conversation in `seq` order and replays the tail after a watermark. `seq` is
/// assigned by the engine; the store only persists and ranges. Separate from
/// ilmek's checkpointer: ilmek owns graph state, mekik owns what a client sees.
/// </summary>
public interface IHistoryStore
{
    Task RecordAsync(string conversationId, Frame frame);
    Task<IReadOnlyList<Frame>> AfterAsync(string conversationId, long watermark);
    Task<long> CurrentSeqAsync(string conversationId);
}

public sealed class InMemoryHistoryStore : IHistoryStore
{
    private readonly Dictionary<string, List<Frame>> _byConversation = new();
    private readonly object _lock = new();

    private static long SeqOf(Frame frame) => frame.TryGetValue("seq", out var s) ? Convert.ToInt64(s) : 0;

    public Task RecordAsync(string conversationId, Frame frame)
    {
        if (frame.GetValueOrDefault("type") is not string t || !Protocol.PersistentFrameTypes.Contains(t))
            throw new InvalidOperationException($"refusing to record a transient {frame.GetValueOrDefault("type")} frame");
        lock (_lock)
        {
            if (!_byConversation.TryGetValue(conversationId, out var list))
                _byConversation[conversationId] = list = new List<Frame>();
            list.Add(frame);
        }
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<Frame>> AfterAsync(string conversationId, long watermark)
    {
        lock (_lock)
        {
            var list = _byConversation.GetValueOrDefault(conversationId) ?? new List<Frame>();
            return Task.FromResult<IReadOnlyList<Frame>>(list.Where(f => SeqOf(f) > watermark).ToList());
        }
    }

    public Task<long> CurrentSeqAsync(string conversationId)
    {
        lock (_lock)
        {
            var list = _byConversation.GetValueOrDefault(conversationId);
            return Task.FromResult(list is { Count: > 0 } ? SeqOf(list[^1]) : 0L);
        }
    }
}

// ── conversations ─────────────────────────────────────────────────────────────

public sealed record ConversationRecord(string ConversationId, string UserId, long CreatedAt, IReadOnlyDictionary<string, object?> Meta);

/// <summary>The conversation registry — owner and metadata. Open interrupts live in ilmek, not here.</summary>
public interface IConversationStore
{
    Task<ConversationRecord?> GetAsync(string conversationId);
    Task CreateAsync(ConversationRecord record);
}

public sealed class InMemoryConversationStore : IConversationStore
{
    private readonly Dictionary<string, ConversationRecord> _byId = new();
    private readonly object _lock = new();

    public Task<ConversationRecord?> GetAsync(string conversationId)
    {
        lock (_lock) return Task.FromResult(_byId.GetValueOrDefault(conversationId));
    }

    public Task CreateAsync(ConversationRecord record)
    {
        lock (_lock) _byId[record.ConversationId] = record;
        return Task.CompletedTask;
    }
}
