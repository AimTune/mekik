namespace Mekik;

/// <summary>The credential a client presented at connect (PROTOCOL.md §7).</summary>
public sealed record Credential
{
    public string? Token { get; init; }
    public IReadOnlyDictionary<string, string?>? Headers { get; init; }
    public IReadOnlyDictionary<string, string?>? Query { get; init; }
}

public sealed record AuthVerdict
{
    public required bool Ok { get; init; }
    /// <summary>The authoritative user id on success — overrides the client-asserted one.</summary>
    public string? UserId { get; init; }
    /// <summary>Verified claims; surfaced to nodes at `ctx.meta.auth`.</summary>
    public IReadOnlyDictionary<string, object?>? Claims { get; init; }
    /// <summary>Rejection reason; sent in the `error{unauthorized}` frame.</summary>
    public string? Reason { get; init; }
}

public interface IAuthenticator
{
    ValueTask<AuthVerdict> AuthenticateAsync(Credential credential);
}

/// <summary>A minimal Authenticator: a fixed token→identity table, for tests and simple deployments.</summary>
public sealed class StaticTokenAuthenticator : IAuthenticator
{
    private readonly IReadOnlyDictionary<string, (string UserId, IReadOnlyDictionary<string, object?>? Claims)> _table;

    public StaticTokenAuthenticator(IReadOnlyDictionary<string, (string, IReadOnlyDictionary<string, object?>?)> tokens) =>
        _table = tokens.ToDictionary(kv => kv.Key, kv => (kv.Value.Item1, kv.Value.Item2));

    public ValueTask<AuthVerdict> AuthenticateAsync(Credential credential)
    {
        if (credential.Token is null)
            return new ValueTask<AuthVerdict>(new AuthVerdict { Ok = false, Reason = "no token presented" });
        if (!_table.TryGetValue(credential.Token, out var hit))
            return new ValueTask<AuthVerdict>(new AuthVerdict { Ok = false, Reason = "invalid token" });
        return new ValueTask<AuthVerdict>(new AuthVerdict { Ok = true, UserId = hit.UserId, Claims = hit.Claims });
    }
}
