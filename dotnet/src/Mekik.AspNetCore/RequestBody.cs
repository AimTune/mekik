using System.Text;
using Microsoft.AspNetCore.Http;

namespace Mekik;

/// <summary>
/// Reads a JSON-RPC request body under a byte cap, the way <c>@mekik/mcp</c> and
/// <c>@mekik/a2a</c> do: the cap counts UTF-8 bytes (not characters), a declared
/// <c>Content-Length</c> over the cap is refused without reading, and reading stops as
/// soon as the running total passes the cap — an oversized body is never buffered.
/// </summary>
internal static class RequestBody
{
    /// <summary>The body as text, or <c>null</c> when it exceeds <paramref name="maxBodyBytes"/>.</summary>
    public static async Task<string?> ReadAsync(HttpRequest request, int maxBodyBytes, CancellationToken ct)
    {
        if (request.ContentLength is { } declared && declared > maxBodyBytes) return null;

        using var acc = new MemoryStream();
        var buffer = new byte[16 * 1024];
        int read;
        while ((read = await request.Body.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
        {
            if (acc.Length + read > maxBodyBytes) return null; // stop reading at the cap
            acc.Write(buffer, 0, read);
        }
        return Encoding.UTF8.GetString(acc.GetBuffer(), 0, (int)acc.Length);
    }

    /// <summary>The <c>413</c> JSON-RPC error both transports answer an oversized body with.</summary>
    public static Dictionary<string, object?> TooLarge() => new()
    {
        ["jsonrpc"] = "2.0",
        ["id"] = null,
        ["error"] = new Dictionary<string, object?> { ["code"] = -32600L, ["message"] = "request body too large" },
    };

    public static void ValidateMax(int maxBodyBytes)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxBodyBytes);
    }
}
