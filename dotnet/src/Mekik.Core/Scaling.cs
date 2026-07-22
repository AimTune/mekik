namespace Mekik;

// The horizontal-scale ports (docs/SCALING.md), mirror of the TypeScript
// `scaling.ts`. Like the persistence ports in `Stores.cs`, each is an interface
// with an in-memory default, so a single-node run needs nothing and a fleet swaps
// implementations in. Passing neither keeps mekik's process-local behaviour
// byte-for-byte — scaling is entirely opt-in.
//
// The shapes are native .NET: a lease and a subscription are `IAsyncDisposable`
// (release / unsubscribe on `await using` / `DisposeAsync`), acquisition is
// nullable-returning, and everything is cancellable.

/// <summary>
/// A held per-conversation turn lease. Renewed while a long run streams; released
/// on <see cref="IAsyncDisposable.DisposeAsync"/> so the next turn can proceed.
/// </summary>
public interface ITurnLease : IAsyncDisposable
{
    /// <summary>Extend the lease TTL (a Redis lock heartbeat; a no-op for the local lock).</summary>
    Task RenewAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// The distributed turn lock. <see cref="AcquireAsync"/> returns a lease, or
/// <c>null</c> when another node already owns the turn for this conversation (the
/// caller answers <c>busy</c>).
/// </summary>
public interface ITurnLock
{
    Task<ITurnLease?> AcquireAsync(string conversationId, CancellationToken cancellationToken = default);
}

/// <summary>
/// The single-node default: always grants. The engine's local turn lock is the
/// real lock on one node, so this lease is a no-op. A Redis <c>SET NX PX</c> lock
/// is the fleet implementation (docs/SCALING.md §The ports).
/// </summary>
public sealed class LocalTurnLock : ITurnLock
{
    private sealed class NoopLease : ITurnLease
    {
        public Task RenewAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    public Task<ITurnLease?> AcquireAsync(string conversationId, CancellationToken cancellationToken = default) =>
        Task.FromResult<ITurnLease?>(new NoopLease());
}

/// <summary>
/// What travels across the backplane: a frame plus the node that produced it, so a
/// subscriber can skip its own messages (pub/sub self-delivery guard).
/// </summary>
public sealed record BackplaneMessage(string OriginId, IReadOnlyDictionary<string, object?> Frame);

/// <summary>
/// Cross-node fan-out. The engine <see cref="PublishAsync"/>es every dispatched
/// frame; each node holding a tab of that conversation <see cref="SubscribeAsync"/>s
/// and re-fans the frame to its own sockets. Persist-once stays with the producing
/// node — the backplane only moves already-recorded frames. The returned
/// <see cref="IAsyncDisposable"/> unsubscribes.
/// </summary>
public interface IBackplane
{
    Task PublishAsync(string conversationId, BackplaneMessage message, CancellationToken cancellationToken = default);
    Task<IAsyncDisposable> SubscribeAsync(string conversationId, Action<BackplaneMessage> handler, CancellationToken cancellationToken = default);
}

/// <summary>
/// The single-node default: nothing to carry, because one node's connections already
/// hold every tab. <see cref="PublishAsync"/> drops the message and
/// <see cref="SubscribeAsync"/> never delivers, so behaviour is identical to
/// pre-scaling mekik. Redis Pub/Sub is the fleet implementation.
/// </summary>
public sealed class NoopBackplane : IBackplane
{
    private sealed class NoopSubscription : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    public Task PublishAsync(string conversationId, BackplaneMessage message, CancellationToken cancellationToken = default) =>
        Task.CompletedTask;

    public Task<IAsyncDisposable> SubscribeAsync(string conversationId, Action<BackplaneMessage> handler, CancellationToken cancellationToken = default) =>
        Task.FromResult<IAsyncDisposable>(new NoopSubscription());
}
