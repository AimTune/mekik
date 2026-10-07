using System.Net;
using System.Text;
using Ilmek;
using Mekik;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.TestHost;

namespace Mekik.AspNetCore.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>
/// Where <see cref="MekikAspNetCore.MapMekik"/>, <see cref="MekikMcpAspNetCore.MapMekikMcp"/>
/// and <see cref="MekikA2aAspNetCore.MapMekikA2a"/> must behave like <c>@mekik/ws</c>,
/// <c>@mekik/mcp</c> and <c>@mekik/a2a</c>: empty identity fields are absent, a handler
/// exception is an <c>error{code:"internal"}</c> frame, and the request body cap counts
/// bytes, stops reading at the cap and is configurable as <c>maxBodyBytes</c>.
/// </summary>
public class WebSocketTransportParityTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => Host.D(kv);
    private static Dictionary<string, object?> Text(string t) => D(("type", "text"), ("data", D(("text", t))));
    private static Task<WebApplication> Serve(MekikApp app) => Host.StartAsync(web => web.MapMekik("/ws", app));

    [Fact]
    public async Task Empty_query_identity_fields_are_treated_as_missing()
    {
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter)));
        await using var c = await Client.ConnectAsync(web, "?userId=&conversationId=&token=");

        await c.SendAsync(D(("type", "hello")));
        var w = (Frame)(await c.ReadUntilAsync(f => f["type"] as string == "welcome"))["data"]!;

        Assert.StartsWith("user-", (string)w["userId"]!);
        Assert.False(string.IsNullOrEmpty((string)w["conversationId"]!));
    }

    [Fact]
    public async Task Empty_hello_identity_fields_are_missing_and_never_override_the_query()
    {
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter)));
        await using var c = await Client.ConnectAsync(web, "?userId=bob");

        await c.SendAsync(D(("type", "hello"), ("userId", ""), ("conversationId", "")));
        var w = (Frame)(await c.ReadUntilAsync(f => f["type"] as string == "welcome"))["data"]!;

        Assert.Equal("bob", w["userId"]);
        Assert.False(string.IsNullOrEmpty((string)w["conversationId"]!));
    }

    [Fact]
    public async Task An_empty_userId_is_never_the_user_id_anonymous_connect_mints_one()
    {
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter)));
        await using var c = await Client.ConnectAsync(web);

        await c.SendAsync(D(("type", "hello"), ("userId", "")));
        var w = (Frame)(await c.ReadUntilAsync(f => f["type"] as string == "welcome"))["data"]!;

        Assert.StartsWith("user-", (string)w["userId"]!);
    }

    private sealed class TokenSpy : IAuthenticator
    {
        public List<string?> Tokens { get; } = new();
        public ValueTask<AuthVerdict> AuthenticateAsync(Credential credential)
        {
            lock (Tokens) Tokens.Add(credential.Token);
            return ValueTask.FromResult(credential.Token == "good"
                ? new AuthVerdict { Ok = true, UserId = "u-42" }
                : new AuthVerdict { Ok = false, Reason = "bad token" });
        }
    }

    [Fact]
    public async Task An_empty_token_is_missing_the_query_token_or_bearer_still_applies()
    {
        var spy = new TokenSpy();
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter) with { Authenticator = spy }));

        await using var viaQuery = await Client.ConnectAsync(web, "?token=good");
        await viaQuery.SendAsync(D(("type", "hello"), ("token", "")));
        var w1 = (Frame)(await viaQuery.ReadUntilAsync(f => f["type"] as string == "welcome"))["data"]!;

        await using var viaBearer = await Client.ConnectAsync(web, "?token=", r => r.Headers["Authorization"] = "Bearer good");
        await viaBearer.SendAsync(D(("type", "hello")));
        var w2 = (Frame)(await viaBearer.ReadUntilAsync(f => f["type"] as string == "welcome"))["data"]!;

        await using var emptyBearer = await Client.ConnectAsync(web, configure: r => r.Headers["Authorization"] = "Bearer ");
        await emptyBearer.SendAsync(D(("type", "hello")));
        await emptyBearer.ReadToCloseAsync();

        Assert.Equal("u-42", w1["userId"]);
        Assert.Equal("u-42", w2["userId"]);
        Assert.Equal(["good", "good", null], spy.Tokens);
    }

    /// <summary>A history store that fails to record one particular user message.</summary>
    private sealed class FailingHistory : IHistoryStore
    {
        private readonly InMemoryHistoryStore _inner = new();
        public Task RecordAsync(string conversationId, Frame frame) =>
            frame.GetValueOrDefault("data") is Frame d && d.GetValueOrDefault("text") as string == "boom"
                ? throw new InvalidOperationException("history store down")
                : _inner.RecordAsync(conversationId, frame);
        public Task<IReadOnlyList<Frame>> AfterAsync(string conversationId, long watermark) => _inner.AfterAsync(conversationId, watermark);
        public Task<long> CurrentSeqAsync(string conversationId) => _inner.CurrentSeqAsync(conversationId);
    }

    [Fact]
    public async Task A_handler_exception_surfaces_error_internal_and_the_socket_stays_open()
    {
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter) with { History = new FailingHistory() }));
        await using var c = await Client.ConnectAsync(web);
        await c.SendAsync(D(("type", "hello")));
        await c.ReadUntilAsync(f => f["type"] as string == "welcome");

        await c.SendAsync(Text("boom"));
        var error = (Frame)(await c.ReadUntilAsync(f => f["type"] as string == "error"))["data"]!;
        await c.SendAsync(Text("Ada"));
        await c.ReadUntilAsync(f => f["type"] as string == "text" && ((Frame)f["data"]!)["text"] as string == "Hi, Ada!");

        Assert.Equal("internal", error["code"]);
        Assert.Equal("history store down", error["message"]);
    }

    private sealed class ThrowingAuthenticator : IAuthenticator
    {
        public ValueTask<AuthVerdict> AuthenticateAsync(Credential credential) => throw new InvalidOperationException("auth backend down");
    }

    [Fact]
    public async Task A_handshake_exception_surfaces_error_internal()
    {
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter) with { Authenticator = new ThrowingAuthenticator() }));
        await using var c = await Client.ConnectAsync(web);

        await c.SendAsync(D(("type", "hello")));
        var error = (Frame)(await c.ReadUntilAsync(f => f["type"] as string == "error"))["data"]!;

        Assert.Equal("internal", error["code"]);
        Assert.Equal("auth backend down", error["message"]);
    }
}

/// <summary>A request body that streams <see cref="Total"/> bytes lazily and counts how many were pulled.</summary>
internal sealed class CountingContent(long total, byte fill = (byte)' ') : HttpContent
{
    public long Total { get; } = total;
    private long _sent;
    public long Sent => Interlocked.Read(ref _sent);

    protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context)
    {
        var chunk = new byte[16 * 1024];
        Array.Fill(chunk, fill);
        while (_sent < Total)
        {
            var n = (int)Math.Min(chunk.Length, Total - _sent);
            await stream.WriteAsync(chunk.AsMemory(0, n));
            Interlocked.Add(ref _sent, n);
        }
    }

    protected override bool TryComputeLength(out long length)
    {
        length = -1; // chunked: no Content-Length to reject up front
        return false;
    }
}

public class BodyLimitParityTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => Host.D(kv);

    private static async Task<(WebApplication Web, HttpClient Http)> Serve(Action<WebApplication> map)
    {
        var web = await Host.StartAsync(map);
        return (web, web.GetTestClient());
    }

    private static MekikMcpServer Mcp() =>
        new(new MekikApp(Host.Options(Host.Greeter)), new McpServerOptions { Name = "desk", Description = "Greets." });

    private static MekikA2aServer A2a() =>
        new(new MekikApp(Host.Options(Host.Greeter)), new A2aServerOptions { Name = "Desk", Description = "Greets.", Url = "https://bot.example.com/a2a" });

    /// <summary>Under the cap in characters, over it in UTF-8 bytes: 'é' is two bytes.</summary>
    private static StringContent MultiByteBody(int maxBytes) =>
        new("\"" + new string('é', maxBytes / 2 + 1) + "\"", Encoding.UTF8, "application/json");

    private static async Task AssertTooLarge(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        Assert.Equal("{\"error\":{\"code\":-32600,\"message\":\"request body too large\"},\"id\":null,\"jsonrpc\":\"2.0\"}",
            await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task The_default_cap_is_one_mebibyte_counted_in_bytes_not_characters()
    {
        Assert.Equal(1024 * 1024, MekikMcpAspNetCore.MaxBodyBytes);
        Assert.Equal(1024 * 1024, MekikA2aAspNetCore.MaxBodyBytes);
        var (web, http) = await Serve(w => { w.MapMekikMcp("/mcp", Mcp()); w.MapMekikA2a("/a2a", A2a()); });
        await using var _ = web;

        await AssertTooLarge(await http.PostAsync("/mcp", MultiByteBody(MekikMcpAspNetCore.MaxBodyBytes)));
        await AssertTooLarge(await http.PostAsync("/a2a", MultiByteBody(MekikA2aAspNetCore.MaxBodyBytes)));
    }

    [Fact]
    public async Task The_cap_is_configurable_as_maxBodyBytes()
    {
        var (web, http) = await Serve(w =>
        {
            w.MapMekikMcp("/mcp", Mcp(), maxBodyBytes: 64);
            w.MapMekikA2a("/a2a", A2a(), maxBodyBytes: 64);
        });
        await using var _ = web;
        var ping = Json.Serialize(D(("jsonrpc", "2.0"), ("id", 1L), ("method", "ping"), ("params", D(("pad", new string('x', 64))))));

        await AssertTooLarge(await http.PostAsync("/mcp", new StringContent(ping, Encoding.UTF8, "application/json")));
        await AssertTooLarge(await http.PostAsync("/a2a", new StringContent(ping, Encoding.UTF8, "application/json")));
        var small = await http.PostAsync("/mcp", new StringContent("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, small.StatusCode);
    }

    [Fact]
    public async Task A_declared_oversized_content_length_is_refused_without_reading_the_body()
    {
        var (web, http) = await Serve(w => w.MapMekikMcp("/mcp", Mcp(), maxBodyBytes: 1024));
        await using var _ = web;
        var content = new StringContent(new string(' ', 4096), Encoding.UTF8, "application/json");

        await AssertTooLarge(await http.PostAsync("/mcp", content));
    }

    [Theory]
    [InlineData("/mcp")]
    [InlineData("/a2a")]
    public async Task Reading_stops_as_soon_as_the_cap_is_exceeded(string path)
    {
        var (web, http) = await Serve(w => { w.MapMekikMcp("/mcp", Mcp(), maxBodyBytes: 1024); w.MapMekikA2a("/a2a", A2a(), maxBodyBytes: 1024); });
        await using var _ = web;
        var body = new CountingContent(256L * 1024 * 1024); // 256 MiB, never buffered

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var response = await http.PostAsync(path, body, cts.Token);

        await AssertTooLarge(response);
        Assert.True(body.Sent < 8L * 1024 * 1024, $"the server kept reading: {body.Sent} bytes pulled");
    }
}
