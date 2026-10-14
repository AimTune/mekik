using System.Net.WebSockets;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Mekik.Converger.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>
/// The compatibility guard (conformance/converger/refund.json), the .NET half: the refund
/// example behind a fake Converger must put on the wire, inside the
/// <c>{conversationId, frame}</c> envelope, exactly the frames a direct <c>MapMekik</c>
/// client receives.
/// </summary>
public class HubConformanceTests
{
    private static readonly Frame Scenario =
        (Frame)Json.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "converger", "refund.json")))!;

    private static string ConversationId => (string)Scenario["conversationId"]!;
    private static string UserId => (string)Scenario["userId"]!;
    private static long Clock => (long)Scenario["clock"]!;
    private static string Greeting => (string)Scenario["greeting"]!;
    private static IEnumerable<Frame> Steps => ((IEnumerable<object?>)Scenario["steps"]!).Cast<Frame>();

    private static Func<Frame, bool> Matches(Frame until) => f =>
        f.GetValueOrDefault("type") as string == until["type"] as string &&
        (until.GetValueOrDefault("status") is not string status || (f.GetValueOrDefault("data") as Frame)?.GetValueOrDefault("status") as string == status);

    /// <summary>Replace <c>$interrupt</c> keys with the id of the last interrupt seen.</summary>
    private static Frame Resolve(Frame frame, IReadOnlyList<Frame> seen)
    {
        var last = seen.LastOrDefault(f => f.GetValueOrDefault("type") as string == "interrupt");
        var json = Json.Serialize(frame).Replace("$interrupt", last?.GetValueOrDefault("id") as string ?? "");
        return (Frame)Json.Parse(json)!;
    }

    /// <summary>Canonical JSON with ilmek's checkpoint ids renamed by first appearance (the scenario's normalize rule).</summary>
    private static List<string> Normalized(IEnumerable<Frame> frames)
    {
        var pattern = new Regex((string)((Frame)Scenario["normalize"]!)["pattern"]!);
        var names = new Dictionary<string, string>();
        return frames.Select(f => pattern.Replace(Json.Canonicalize(f), m =>
        {
            if (!names.TryGetValue(m.Value, out var name)) names[m.Value] = name = $"ckpt-{names.Count + 1}";
            return name;
        })).ToList();
    }

    [Fact]
    public async Task The_refund_example_behind_a_hub_puts_the_direct_runs_frames_in_the_envelope()
    {
        var direct = await DirectRunAsync();
        var behindHub = await HubRunAsync();

        var types = direct.Select(f => f["type"] as string).ToHashSet();
        foreach (var t in new[] { "text", "tool_call", "genui", "interrupt", "error", "interrupt_resolved", "run" })
            Assert.Contains(t, types);
        Assert.DoesNotContain(direct, f => f["type"] as string == "text" && f.GetValueOrDefault("from") as string == "user");

        Assert.Equal(Normalized(direct), Normalized(behindHub));
    }

    /// <summary>Every step over a direct mekik/1 socket; the frames after <c>welcome</c>.</summary>
    private static async Task<List<Frame>> DirectRunAsync()
    {
        var conversations = new InMemoryConversationStore();
        await conversations.CreateAsync(new ConversationRecord(ConversationId, UserId, 0, new Dictionary<string, object?>()));
        var app = new MekikApp(RefundApp.Options(Greeting, Clock) with { Conversations = conversations });

        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        await using var web = builder.Build();
        web.UseWebSockets();
        web.MapMekik("/ws", app);
        await web.StartAsync();
        var address = web.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();

        using var ws = new ClientWebSocket();
        await ws.ConnectAsync(new Uri(address.Replace("http://", "ws://") + "/ws"), CancellationToken.None);
        var frames = new List<Frame>();
        var reader = Task.Run(async () =>
        {
            var buffer = new byte[64 * 1024];
            using var acc = new MemoryStream();
            while (ws.State == WebSocketState.Open)
            {
                WebSocketReceiveResult r;
                try { r = await ws.ReceiveAsync(buffer, CancellationToken.None); }
                catch { return; }
                if (r.MessageType == WebSocketMessageType.Close) return;
                acc.Write(buffer, 0, r.Count);
                if (!r.EndOfMessage) continue;
                var f = (Frame)Json.Parse(Encoding.UTF8.GetString(acc.ToArray()))!;
                acc.SetLength(0);
                lock (frames) frames.Add(f);
            }
        });
        List<Frame> Snapshot() { lock (frames) return frames.ToList(); }
        Task SendAsync(object frame) => ws.SendAsync(Encoding.UTF8.GetBytes(Json.Serialize(frame)), WebSocketMessageType.Text, true, CancellationToken.None);

        await SendAsync(new Dictionary<string, object?> { ["type"] = "hello", ["userId"] = UserId, ["conversationId"] = ConversationId });
        await FakeHub.WaitForAsync(() => Snapshot().Any(f => f["type"] as string == "welcome"), "welcome");
        var welcome = (Frame)Snapshot().First(f => f["type"] as string == "welcome")["data"]!;
        Assert.Equal(ConversationId, welcome["conversationId"]);

        foreach (var step in Steps)
        {
            var before = Snapshot().Count;
            await SendAsync(Resolve((Frame)step["send"]!, Snapshot()));
            var until = Matches((Frame)step["until"]!);
            await FakeHub.WaitForAsync(() => Snapshot().Skip(before).Any(until), $"direct {Json.Serialize(step["until"])}", detail: () => Json.Serialize(Snapshot()));
        }
        await Task.Delay(50);
        await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
        return Snapshot().Where(f => f["type"] as string != "welcome").ToList();
    }

    /// <summary>Every step through a fake hub; the inner frames of the conversation's envelopes.</summary>
    private static async Task<List<Frame>> HubRunAsync()
    {
        await using var hub = await FakeHub.StartAsync();
        var app = new MekikApp(RefundApp.Options(Greeting, Clock).WithExternalTranscript());
        await using var transport = ConvergerTransport.Connect(app, new ConvergerOptions { Url = hub.Url, Token = "channel-token" });
        await transport.Ready.WaitAsync(TimeSpan.FromSeconds(10));

        foreach (var step in Steps)
        {
            var before = hub.FramesOf(ConversationId).Count;
            var send = Resolve((Frame)step["send"]!, hub.FramesOf(ConversationId));
            if (send["type"] as string == "text")
                await hub.UserTurnAsync(ConversationId, (string)((Frame)send["data"]!)["text"]!);
            else
                await hub.ForwardAsync(ConversationId, send);
            var until = Matches((Frame)step["until"]!);
            await FakeHub.WaitForAsync(() => hub.FramesOf(ConversationId).Skip(before).Any(until), $"hub {Json.Serialize(step["until"])}", detail: () => Json.Serialize(hub.FramesOf(ConversationId)));
        }
        await Task.Delay(50);
        return hub.FramesOf(ConversationId);
    }
}
