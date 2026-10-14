using Ilmek;
using Mekik;

namespace Mekik.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>
/// The external-transcript profile (PROTOCOL.md "Running behind a hub"): opt-in ports for a
/// hub that owns the transcript, the seq space and identity. Mirror of
/// <c>ts/packages/core/test/external.test.ts</c>.
/// </summary>
public class ExternalTranscriptTests
{
    private static Dictionary<string, object?> D(params (string K, object? V)[] kv) => kv.ToDictionary(p => p.K, p => p.V);

    private static readonly CompiledGraph Echo = Graph.Create("echo")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("n", (State s, IContext _) => Update.Of("reply", $"echo: {s.Get<string>("input")}"))
        .Edge(Graph.Start, "n")
        .Edge("n", Graph.End)
        .Compile();

    private static Dictionary<string, object?> Text(string t) => D(("type", "text"), ("data", D(("text", t))));

    [Fact]
    public async Task The_history_store_keeps_nothing_replays_nothing_and_seeds_seq_from_the_hub()
    {
        var transcript = new ExternalTranscript();
        var history = new ExternalTranscriptHistoryStore(transcript);
        await history.RecordAsync("c", D(("type", "text"), ("id", "m"), ("seq", 3L), ("from", "bot"), ("data", D(("text", "x"))), ("timestamp", 1L)));
        Assert.Empty(await history.AfterAsync("c", 0));
        Assert.Equal(0, await history.CurrentSeqAsync("c"));
        transcript.Observe("c", "alice", 7);
        Assert.Equal(7, await history.CurrentSeqAsync("c"));
    }

    [Fact]
    public async Task The_conversation_store_answers_from_the_hub_the_first_owner_sticks_and_create_is_a_no_op()
    {
        var transcript = new ExternalTranscript();
        var store = new HubConversationStore(transcript);
        Assert.Null(await store.GetAsync("c"));
        transcript.Observe("c", "alice", 1);
        transcript.Observe("c", "mallory", 2);
        Assert.Equal("alice", (await store.GetAsync("c"))!.UserId);
        await store.CreateAsync(new ConversationRecord("d", "bob", 0, D()));
        Assert.Null(await store.GetAsync("d"));
        transcript.Forget("c");
        Assert.Null(await store.GetAsync("c"));
        Assert.Equal(0, transcript.Count);
    }

    [Fact]
    public async Task The_authenticator_trusts_only_the_hub_identity_at_credential_meta_auth()
    {
        var auth = new HubAuthenticator();
        var ok = await auth.AuthenticateAsync(new Credential { Meta = D(("auth", D(("userId", "alice"), ("role", "user")))) });
        Assert.True(ok.Ok);
        Assert.Equal("alice", ok.UserId);
        Assert.Equal("""{"role":"user","userId":"alice"}""", Json.Canonicalize(ok.Claims));
        Assert.False((await auth.AuthenticateAsync(new Credential { Token = "anything" })).Ok);
        Assert.False((await auth.AuthenticateAsync(new Credential { Meta = D(("auth", D(("userId", "")))) })).Ok);
        Assert.False((await auth.AuthenticateAsync(new Credential { Meta = D(("auth", "alice")) })).Ok);
    }

    [Fact]
    public async Task A_hub_conversation_is_adopted_and_the_user_turn_is_numbered_but_neither_echoed_nor_stored()
    {
        var transcript = new ExternalTranscript();
        var app = new MekikApp(new MekikOptions { Graph = Echo, Reply = s => s.GetValueOrDefault("reply") as string }.WithExternalTranscript(transcript));
        transcript.Observe("conv-hub", "alice", 4);
        var credential = new Credential { Meta = D(("auth", D(("userId", "alice")))) };
        var a = new FakeConn();
        var b = new FakeConn();
        await app.ConnectAsync(a, new ConnectParams { Hello = new HelloInfo { ConversationId = "conv-hub" }, Credential = credential });
        await app.ConnectAsync(b, new ConnectParams { Hello = new HelloInfo { ConversationId = "conv-hub" }, Credential = credential });
        var welcome = (Frame)a.Sent.First(f => f["type"] as string == "welcome")["data"]!;
        Assert.Equal("conv-hub", welcome["conversationId"]);
        Assert.Equal("alice", welcome["userId"]);
        Assert.Equal(4L, welcome["watermark"]);

        await app.ReceiveAsync(a, Text("hi"));
        Assert.DoesNotContain(b.Sent, f => f["type"] as string == "text" && f.GetValueOrDefault("from") as string == "user");
        var reply = b.Sent.First(f => f["type"] as string == "text" && f.GetValueOrDefault("from") as string == "bot");
        Assert.Equal(6L, reply["seq"]); // the unsent user turn took seq 5
        Assert.Empty(await app.History.AfterAsync("conv-hub", 0));
    }

    [Fact]
    public async Task Without_a_hub_identity_the_connection_is_refused_like_any_failed_authenticator()
    {
        var app = new MekikApp(new MekikOptions { Graph = Echo }.WithExternalTranscript());
        var c = new FakeConn();
        await app.ConnectAsync(c, new ConnectParams { Hello = new HelloInfo { UserId = "alice", ConversationId = "x" } });
        Assert.Equal(4401, c.Closed?.Code);
        Assert.Equal("""{"data":{"code":"unauthorized","message":"no hub-verified identity"},"type":"error"}""", Json.Canonicalize(c.Sent[0]));
    }

    [Fact]
    public async Task Default_apps_are_unchanged_and_the_user_turn_still_reaches_the_other_tab_and_the_transcript()
    {
        var app = new MekikApp(new MekikOptions { Graph = Echo });
        var a = new FakeConn();
        await app.ConnectAsync(a, new ConnectParams { Hello = new HelloInfo { UserId = "u" } });
        var conv = (string)((Frame)a.Sent[0]["data"]!)["conversationId"]!;
        var b = new FakeConn();
        await app.ConnectAsync(b, new ConnectParams { Hello = new HelloInfo { UserId = "u", ConversationId = conv } });
        await app.ReceiveAsync(a, Text("hi"));
        Assert.Contains(b.Sent, f => f["type"] as string == "text" && f.GetValueOrDefault("from") as string == "user");
        Assert.Equal("text", (await app.History.AfterAsync(conv, 0))[0]["type"]);
    }
}
