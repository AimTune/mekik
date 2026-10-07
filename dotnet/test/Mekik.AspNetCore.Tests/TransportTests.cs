using System.Net;
using System.Net.WebSockets;
using System.Text;
using Ilmek;
using Mekik;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;

namespace Mekik.AspNetCore.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>Graphs and a host for driving the transports in memory.</summary>
internal static class Host
{
    public static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    /// <summary>Emits a ui chunk and replies — four persistent frames per turn.</summary>
    public static readonly CompiledGraph Greeter = Graph.Create("greeter")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("greet", (State s, IContext ctx) =>
        {
            Shuttle.Ui(ctx, "hello-card", D(("name", s.Get<string>("input"))));
            return Update.Of("reply", $"Hi, {s.Get<string>("input")}!");
        })
        .Edge(Graph.Start, "greet")
        .Edge("greet", Graph.End)
        .Compile();

    /// <summary>Replies with the client tool names the turn sees.</summary>
    public static readonly CompiledGraph ToolLister = Graph.Create("tools")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("list", (State _, IContext ctx) => Update.Of("reply", "tools:" + string.Join(",", Shuttle.ClientTools(ctx).Select(t => t.Name))))
        .Edge(Graph.Start, "list")
        .Edge("list", Graph.End)
        .Compile();

    public static MekikOptions Options(CompiledGraph graph) => new()
    {
        Graph = graph,
        Checkpointer = new InMemoryCheckpointer(),
        Reply = s => s.GetValueOrDefault("reply") as string,
    };

    public static async Task<WebApplication> StartAsync(Action<WebApplication> map)
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        var web = builder.Build();
        web.UseWebSockets();
        map(web);
        await web.StartAsync();
        return web;
    }
}

/// <summary>A client socket that reads whole frames as parsed dictionaries.</summary>
internal sealed class Client(WebSocket ws) : IAsyncDisposable
{
    public WebSocket Socket => ws;
    public List<Frame> Received { get; } = new();

    public static async Task<Client> ConnectAsync(WebApplication web, string query = "", Action<HttpRequestMessageLike>? configure = null)
    {
        var wsClient = web.GetTestServer().CreateWebSocketClient();
        if (configure is not null)
        {
            var like = new HttpRequestMessageLike();
            configure(like);
            wsClient.ConfigureRequest = r => { foreach (var (k, v) in like.Headers) r.Headers[k] = v; };
        }
        var socket = await wsClient.ConnectAsync(new Uri($"ws://localhost/ws{query}"), CancellationToken.None);
        return new Client(socket);
    }

    public Task SendAsync(object frame) => SendRawAsync(Json.Serialize(frame));

    public Task SendRawAsync(string text) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);

    /// <summary>Read until a frame matches, or the server closes. Throws on timeout.</summary>
    public async Task<Frame> ReadUntilAsync(Func<Frame, bool> match, int timeoutMs = 10_000)
    {
        using var cts = new CancellationTokenSource(timeoutMs);
        foreach (var f in Received) if (match(f)) return f;
        while (true)
        {
            var frame = await ReadOneAsync(cts.Token) ?? throw new InvalidOperationException(
                $"socket closed ({ws.CloseStatus}) before a matching frame; got {string.Join(",", Received.Select(f => f.GetValueOrDefault("type")))}");
            if (match(frame)) return frame;
        }
    }

    public Task<Frame> ReadRunAsync(string status) =>
        ReadUntilAsync(f => f.GetValueOrDefault("type") as string == "run" && ((Frame)f["data"]!)["status"] as string == status);

    /// <summary>One whole frame, or null when the server closed.</summary>
    public async Task<Frame?> ReadOneAsync(CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        using var acc = new MemoryStream();
        while (true)
        {
            WebSocketReceiveResult r;
            try { r = await ws.ReceiveAsync(buffer, ct); }
            catch (WebSocketException) { return null; }
            catch (IOException) { return null; } // the server ended the request
            if (r.MessageType == WebSocketMessageType.Close) return null;
            acc.Write(buffer, 0, r.Count);
            if (!r.EndOfMessage) continue;
            var frame = (Frame)Json.Parse(Encoding.UTF8.GetString(acc.ToArray()))!;
            Received.Add(frame);
            return frame;
        }
    }

    /// <summary>Drain until the server closes; returns the close status.</summary>
    public async Task<WebSocketCloseStatus?> ReadToCloseAsync(int timeoutMs = 10_000)
    {
        using var cts = new CancellationTokenSource(timeoutMs);
        while (await ReadOneAsync(cts.Token) is not null) { }
        return ws.CloseStatus;
    }

    public IEnumerable<long> Seqs => Received.Select(f => f.GetValueOrDefault("seq")).OfType<long>();

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (ws.State == WebSocketState.Open)
                await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
        }
        catch (WebSocketException) { }
        ws.Dispose();
    }
}

internal sealed class HttpRequestMessageLike
{
    public Dictionary<string, string> Headers { get; } = new();
}

/// <summary>
/// <see cref="MekikAspNetCore.MapMekik"/> over a real (in-memory) WebSocket: identity
/// from the query or the first hello, frame forwarding, the auth close, and the
/// handshake races a socket brings.
/// </summary>
public class WebSocketTransportTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => Host.D(kv);
    private static Dictionary<string, object?> Text(string t) => D(("type", "text"), ("data", D(("text", t))));

    private static Task<WebApplication> Serve(MekikApp app) => Host.StartAsync(web => web.MapMekik("/ws", app));

    [Fact]
    public async Task A_hello_frame_handshakes_and_a_text_frame_runs_a_turn()
    {
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter)));
        await using var c = await Client.ConnectAsync(web);

        await c.SendAsync(D(("type", "hello"), ("userId", "ada")));
        var welcome = await c.ReadUntilAsync(f => f["type"] as string == "welcome");
        await c.SendAsync(Text("Ada"));
        await c.ReadRunAsync("finished");

        Assert.Equal("ada", ((Frame)welcome["data"]!)["userId"]);
        Assert.Equal("mekik/1", ((Frame)welcome["data"]!)["protocol"]);
        Assert.Equal(["welcome", "run", "genui", "genui", "text", "run"], c.Received.Select(f => f["type"]));
        Assert.Equal([2L, 3, 4], c.Seqs);
    }

    [Fact]
    public async Task Identity_can_travel_in_the_query_and_a_non_hello_first_frame_is_still_processed()
    {
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter)));
        await using var c = await Client.ConnectAsync(web, "?userId=bob");

        await c.SendAsync(Text("Bob"));
        await c.ReadRunAsync("finished");

        Assert.Equal("bob", ((Frame)c.Received[0]["data"]!)["userId"]);
        Assert.Contains(c.Received, f => f["type"] as string == "text" && ((Frame)f["data"]!)["text"] as string == "Hi, Bob!");
    }

    private static async Task<(string Conv, string User)> OneTurn(WebApplication web)
    {
        await using var c = await Client.ConnectAsync(web);
        await c.SendAsync(D(("type", "hello")));
        var w = (Frame)(await c.ReadUntilAsync(f => f["type"] as string == "welcome"))["data"]!;
        await c.SendAsync(Text("Ada"));
        await c.ReadRunAsync("finished");
        return ((string)w["conversationId"]!, (string)w["userId"]!);
    }

    [Fact]
    public async Task A_watermark_in_the_hello_frame_limits_the_replay()
    {
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter)));
        var (conv, user) = await OneTurn(web);

        await using var back = await Client.ConnectAsync(web);
        await back.SendAsync(D(("type", "hello"), ("userId", user), ("conversationId", conv), ("watermark", 2L)));
        await back.ReadUntilAsync(f => f.GetValueOrDefault("seq") is 4L);

        Assert.Equal([3L, 4], back.Seqs);
    }

    [Fact]
    public async Task A_watermark_in_the_query_limits_the_replay_and_the_hello_frame_wins_over_it()
    {
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter)));
        var (conv, user) = await OneTurn(web);

        await using var viaQuery = await Client.ConnectAsync(web, $"?userId={user}&conversationId={conv}&watermark=3");
        await viaQuery.SendAsync(D(("type", "hello")));
        await viaQuery.ReadUntilAsync(f => f.GetValueOrDefault("seq") is 4L);
        Assert.Equal([4L], viaQuery.Seqs);

        await using var both = await Client.ConnectAsync(web, $"?userId={user}&conversationId={conv}&watermark=3");
        await both.SendAsync(D(("type", "hello"), ("watermark", 1L)));
        await both.ReadUntilAsync(f => f.GetValueOrDefault("seq") is 4L);
        Assert.Equal([2L, 3, 4], both.Seqs);
    }

    [Fact]
    public async Task A_non_numeric_query_watermark_is_ignored_and_the_whole_transcript_replays()
    {
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter)));
        var (conv, user) = await OneTurn(web);

        await using var c = await Client.ConnectAsync(web, $"?userId={user}&conversationId={conv}&watermark=abc");
        await c.SendAsync(D(("type", "hello")));
        await c.ReadUntilAsync(f => f.GetValueOrDefault("seq") is 4L);

        Assert.Equal([1L, 2, 3, 4], c.Seqs);
    }

    [Fact]
    public async Task Wrong_typed_hello_fields_are_dropped_never_echoed()
    {
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter)));
        var (conv, _) = await OneTurn(web);

        await using var c = await Client.ConnectAsync(web);
        await c.SendAsync(D(("type", "hello"), ("userId", 42L), ("conversationId", D(("id", conv))), ("meta", "junk"),
            ("watermark", "7"), ("token", 5L), ("componentsHash", 1L), ("tools", "x"), ("skills", D())));
        var w = (Frame)(await c.ReadUntilAsync(f => f["type"] as string == "welcome"))["data"]!;

        Assert.StartsWith("user-", (string)w["userId"]!);
        Assert.NotEqual(conv, w["conversationId"]);
        Assert.Equal(0L, w["watermark"]);
    }

    [Fact]
    public async Task A_plain_http_request_is_a_400()
    {
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter)));

        var response = await web.GetTestClient().GetAsync("/ws");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task A_malformed_frame_draws_bad_request_and_the_socket_stays_open()
    {
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter)));
        await using var c = await Client.ConnectAsync(web);
        await c.SendAsync(D(("type", "hello")));

        await c.SendRawAsync("{not json");
        var error = await c.ReadUntilAsync(f => f["type"] as string == "error");
        await c.SendAsync(Text("still here"));
        await c.ReadRunAsync("finished");

        Assert.Equal("bad_request", ((Frame)error["data"]!)["code"]);
    }

    [Fact]
    public async Task A_frame_larger_than_the_receive_buffer_arrives_whole()
    {
        await using var web = await Serve(new MekikApp(Host.Options(Host.Greeter)));
        await using var c = await Client.ConnectAsync(web);
        await c.SendAsync(D(("type", "hello")));
        var big = new string('é', 20_000); // > 8 KiB of UTF-8, split across reads

        await c.SendAsync(Text(big));
        var reply = await c.ReadUntilAsync(f => f["type"] as string == "text");

        Assert.Equal($"Hi, {big}!", ((Frame)reply["data"]!)["text"]);
    }

    private static MekikApp Authed(IAuthenticator? auth = null) => new(Host.Options(Host.Greeter) with
    {
        Authenticator = auth ?? new StaticTokenAuthenticator(new Dictionary<string, (string, IReadOnlyDictionary<string, object?>?)>
        {
            ["good"] = ("u-42", null),
        }),
    });

    [Fact]
    public async Task A_bad_token_gets_error_unauthorized_and_a_4401_close()
    {
        await using var web = await Serve(Authed());
        await using var c = await Client.ConnectAsync(web);

        await c.SendAsync(D(("type", "hello"), ("token", "nope")));
        var error = await c.ReadUntilAsync(f => f["type"] as string == "error");
        var status = await c.ReadToCloseAsync();

        Assert.Equal("unauthorized", ((Frame)error["data"]!)["code"]);
        Assert.Equal((WebSocketCloseStatus)4401, status);
        Assert.Equal("unauthorized", c.Socket.CloseStatusDescription);
        Assert.DoesNotContain(c.Received, f => f["type"] as string == "welcome");
    }

    [Fact]
    public async Task A_token_can_travel_in_the_query_or_as_a_bearer_header()
    {
        await using var web = await Serve(Authed());

        await using var viaQuery = await Client.ConnectAsync(web, "?token=good");
        await viaQuery.SendAsync(D(("type", "hello")));
        var w1 = (Frame)(await viaQuery.ReadUntilAsync(f => f["type"] as string == "welcome"))["data"]!;

        await using var viaHeader = await Client.ConnectAsync(web, configure: r => r.Headers["Authorization"] = "Bearer good");
        await viaHeader.SendAsync(D(("type", "hello")));
        var w2 = (Frame)(await viaHeader.ReadUntilAsync(f => f["type"] as string == "welcome"))["data"]!;

        Assert.Equal("u-42", w1["userId"]);
        Assert.Equal("u-42", w2["userId"]);
    }

    private sealed class CapturingAuth : IAuthenticator
    {
        public Credential? Seen;
        public ValueTask<AuthVerdict> AuthenticateAsync(Credential credential)
        {
            Seen = credential;
            return ValueTask.FromResult(new AuthVerdict { Ok = true, UserId = "u" });
        }
    }

    [Fact]
    public async Task The_authenticator_sees_headers_query_and_the_hello_token_over_the_query_token()
    {
        var auth = new CapturingAuth();
        await using var web = await Serve(Authed(auth));
        await using var c = await Client.ConnectAsync(web, "?token=from-query&x=1", r => r.Headers["X-Tenant"] = "acme");

        await c.SendAsync(D(("type", "hello"), ("token", "from-hello")));
        await c.ReadUntilAsync(f => f["type"] as string == "welcome");

        Assert.Equal("from-hello", auth.Seen!.Token);
        Assert.Equal("1", auth.Seen.Query!["x"]);
        Assert.Equal("acme", auth.Seen.Headers!["X-Tenant"]);
    }

    private sealed class GatedAuth : IAuthenticator
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int Calls;

        public async ValueTask<AuthVerdict> AuthenticateAsync(Credential credential)
        {
            if (Interlocked.Increment(ref Calls) == 1)
            {
                Entered.TrySetResult();
                await Release.Task;
            }
            return new AuthVerdict { Ok = true, UserId = "ada" };
        }
    }

    [Fact]
    public async Task A_socket_that_closes_mid_handshake_is_disconnected_after_the_engine_registers_it()
    {
        var auth = new GatedAuth();
        var app = new MekikApp(Host.Options(Host.ToolLister) with { Authenticator = auth, ClientTools = ClientTools.AcceptAll });
        await app.Conversations.CreateAsync(new ConversationRecord("conv-1", "ada", 0, new Dictionary<string, object?>()));
        await using var web = await Serve(app);

        // Tab A declares a tool, then leaves while its authentication is still pending.
        var a = await Client.ConnectAsync(web);
        await a.SendAsync(D(("type", "hello"), ("conversationId", "conv-1"), ("tools", new List<object?> { D(("name", "ghost_tool")) })));
        await auth.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await a.Socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
        auth.Release.SetResult();
        await a.ReadToCloseAsync(); // returns once the server handler (and its Disconnect) is done
        a.Socket.Dispose();

        await using var b = await Client.ConnectAsync(web);
        await b.SendAsync(D(("type", "hello"), ("conversationId", "conv-1")));
        await b.SendAsync(Text("which tools?"));
        var reply = await b.ReadUntilAsync(f => f["type"] as string == "text" && f["from"] as string == "bot");

        Assert.Equal("tools:", ((Frame)reply["data"]!)["text"]); // the dead tab's tools did not leak
    }
}

/// <summary><see cref="MekikMcpAspNetCore.MapMekikMcp"/> — the Streamable HTTP status codes (§13.2).</summary>
public class McpTransportTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => Host.D(kv);

    private static async Task<(WebApplication Web, HttpClient Http)> Serve()
    {
        var mcp = new MekikMcpServer(new MekikApp(Host.Options(Host.Greeter)), new McpServerOptions { Name = "desk", Description = "Greets." });
        var web = await Host.StartAsync(w => w.MapMekikMcp("/mcp", mcp));
        return (web, web.GetTestClient());
    }

    private static StringContent Body(string json) => new(json, Encoding.UTF8, "application/json");

    [Fact]
    public async Task A_request_is_answered_200_with_json()
    {
        var (web, http) = await Serve();
        await using var _ = web;

        var response = await http.PostAsync("/mcp", Body(Json.Serialize(D(("jsonrpc", "2.0"), ("id", 1L), ("method", "ping")))));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType!.MediaType);
        Assert.Equal("{\"id\":1,\"jsonrpc\":\"2.0\",\"result\":{}}", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task A_tool_call_runs_a_turn_over_http()
    {
        var (web, http) = await Serve();
        await using var _ = web;

        var response = await http.PostAsync("/mcp", Body(Json.Serialize(D(("jsonrpc", "2.0"), ("id", 2L), ("method", "tools/call"),
            ("params", D(("name", "desk"), ("arguments", D(("message", "Ada")))))))));

        var reply = (Frame)Json.Parse(await response.Content.ReadAsStringAsync())!;
        Assert.Equal("Hi, Ada!", ((Frame)((Frame)reply["result"]!)["structuredContent"]!)["reply"]);
    }

    [Fact]
    public async Task A_notification_is_202_with_no_body()
    {
        var (web, http) = await Serve();
        await using var _ = web;

        var response = await http.PostAsync("/mcp", Body("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}"));

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        Assert.Equal("", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Unparseable_json_is_400_parse_error_with_a_null_id()
    {
        var (web, http) = await Serve();
        await using var _ = web;

        var response = await http.PostAsync("/mcp", Body("{oops"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("{\"error\":{\"code\":-32700,\"message\":\"parse error\"},\"id\":null,\"jsonrpc\":\"2.0\"}", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task A_body_over_one_megabyte_is_413()
    {
        var (web, http) = await Serve();
        await using var _ = web;

        var response = await http.PostAsync("/mcp", Body(new string(' ', MekikMcpAspNetCore.MaxBodyBytes + 1)));

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        var error = (Frame)((Frame)Json.Parse(await response.Content.ReadAsStringAsync())!)["error"]!;
        Assert.Equal(-32600L, error["code"]);
    }

    [Theory]
    [InlineData("GET")]
    [InlineData("PUT")]
    [InlineData("PATCH")]
    public async Task Other_methods_are_405_with_an_allow_header(string method)
    {
        var (web, http) = await Serve();
        await using var _ = web;

        var response = await http.SendAsync(new HttpRequestMessage(new HttpMethod(method), "/mcp"));

        Assert.Equal(HttpStatusCode.MethodNotAllowed, response.StatusCode);
        Assert.Equal(["POST", "DELETE"], response.Content.Headers.Allow);
    }

    [Fact]
    public async Task Delete_ends_the_stateless_session_with_200()
    {
        var (web, http) = await Serve();
        await using var _ = web;

        var response = await http.DeleteAsync("/mcp");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public void Mapping_requires_a_server()
    {
        var web = WebApplication.CreateBuilder().Build();

        Assert.Throws<ArgumentNullException>(() => web.MapMekikMcp("/mcp", null!));
        Assert.Throws<ArgumentNullException>(() => web.MapMekikA2a("/a2a", null!));
    }
}

/// <summary><see cref="MekikA2aAspNetCore.MapMekikA2a"/> — the Agent Card and JSON-RPC over HTTP (§14).</summary>
public class A2aTransportTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => Host.D(kv);

    private static async Task<(WebApplication Web, HttpClient Http, MekikA2aServer Agent)> Serve(string? cardPath = null)
    {
        var agent = new MekikA2aServer(new MekikApp(Host.Options(Host.Greeter)), new A2aServerOptions
        {
            Name = "Desk",
            Description = "Greets.",
            Url = "https://bot.example.com/a2a",
        });
        var web = await Host.StartAsync(w =>
        {
            if (cardPath is null) w.MapMekikA2a("/a2a", agent);
            else w.MapMekikA2a("/a2a", agent, cardPath);
        });
        return (web, web.GetTestClient(), agent);
    }

    private static StringContent Body(string json) => new(json, Encoding.UTF8, "application/json");

    [Fact]
    public async Task The_agent_card_is_served_at_the_well_known_path()
    {
        var (web, http, agent) = await Serve();
        await using var _ = web;

        var response = await http.GetAsync("/.well-known/agent-card.json");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType!.MediaType);
        Assert.Equal(Json.Canonicalize(agent.AgentCard()), await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task A_custom_card_path_moves_the_card()
    {
        var (web, http, _) = await Serve("/card.json");
        await using var __ = web;

        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync("/card.json")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync(MekikA2aAspNetCore.AgentCardPath)).StatusCode);
    }

    [Fact]
    public async Task Message_send_completes_a_task_over_http()
    {
        var (web, http, _) = await Serve();
        await using var __ = web;

        var response = await http.PostAsync("/a2a", Body(Json.Serialize(D(("jsonrpc", "2.0"), ("id", 1L), ("method", "message/send"),
            ("params", D(("message", D(("role", "user"), ("parts", new List<object?> { D(("kind", "text"), ("text", "Ada")) })))))))));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var task = (Frame)((Frame)Json.Parse(await response.Content.ReadAsStringAsync())!)["result"]!;
        Assert.Equal("completed", ((Frame)task["status"]!)["state"]);
    }

    [Fact]
    public async Task A_notification_is_202()
    {
        var (web, http, _) = await Serve();
        await using var __ = web;

        var response = await http.PostAsync("/a2a", Body("{\"jsonrpc\":\"2.0\",\"method\":\"tasks/get\"}"));

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
    }

    [Fact]
    public async Task Unparseable_json_is_400_and_an_oversized_body_413()
    {
        var (web, http, _) = await Serve();
        await using var __ = web;

        var bad = await http.PostAsync("/a2a", Body("nope"));
        var big = await http.PostAsync("/a2a", Body(new string(' ', MekikA2aAspNetCore.MaxBodyBytes + 1)));

        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal("{\"error\":{\"code\":-32700,\"message\":\"parse error\"},\"id\":null,\"jsonrpc\":\"2.0\"}", await bad.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, big.StatusCode);
    }

    [Fact]
    public async Task Wrong_methods_on_either_path_are_405()
    {
        var (web, http, _) = await Serve();
        await using var __ = web;

        Assert.Equal(HttpStatusCode.MethodNotAllowed, (await http.GetAsync("/a2a")).StatusCode);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, (await http.PostAsync(MekikA2aAspNetCore.AgentCardPath, Body("{}"))).StatusCode);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, (await http.DeleteAsync("/a2a")).StatusCode);
    }
}
