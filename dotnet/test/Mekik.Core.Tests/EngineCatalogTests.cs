using Mekik;

namespace Mekik.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>
/// The catalogs announced on connect — server-defined components (§10.2) and the
/// skill catalog (§12.2) — as the engine sends them. Mirror of the
/// "server-defined components" suite in ts/packages/core/test/scenarios.test.ts,
/// plus the handshake ordering both catalogs share with the replay tail.
/// </summary>
public class EngineCatalogTests
{
    private static readonly ComponentSpec OrderCard = new()
    {
        Name = "order-card",
        Template = "<h3>{{title}}</h3><button data-event=\"track_order\">Track</button>",
        Props = new Dictionary<string, object?> { ["title"] = "" },
    };

    private static MekikApp WithComponents() => new(Graphs.Options(Graphs.Greeter) with { Components = [OrderCard] });

    private static async Task<FakeConn> Connect(MekikApp app, HelloInfo? hello = null)
    {
        var c = new FakeConn();
        await app.ConnectAsync(c, hello is null ? null : new ConnectParams { Hello = hello });
        return c;
    }

    private static Frame Catalog(FakeConn c) => c.Sent.Single(f => f.Type() == "genui_components");

    [Fact]
    public async Task The_component_catalog_is_announced_right_after_welcome()
    {
        var c = await Connect(WithComponents());

        Assert.Equal(["welcome", "genui_components"], c.Types());
        var frame = Catalog(c);
        Assert.Equal(Json.Canonicalize(new ComponentCatalog([OrderCard]).Definitions), Json.Canonicalize(frame["components"]));
        Assert.Matches("^[0-9a-f]{64}$", (string)frame["hash"]!);
        Assert.False(frame.ContainsKey("unchanged"));
    }

    [Fact]
    public async Task A_client_holding_the_current_hash_gets_unchanged_and_no_markup()
    {
        var app = WithComponents();
        var hash = (string)Catalog(await Connect(app))["hash"]!;

        var c = await Connect(app, new HelloInfo { ComponentsHash = hash });

        var frame = Catalog(c);
        Assert.Equal(true, frame["unchanged"]);
        Assert.False(frame.ContainsKey("components"));
        Assert.Equal(hash, frame["hash"]);
    }

    [Fact]
    public async Task A_stale_hash_gets_the_markup_again()
    {
        var c = await Connect(WithComponents(), new HelloInfo { ComponentsHash = "an-old-hash" });

        Assert.False(Catalog(c).ContainsKey("unchanged"));
        Assert.Single((IEnumerable<object?>)Catalog(c)["components"]!);
    }

    [Fact]
    public async Task No_components_means_no_catalog_frame()
    {
        var plain = await Connect(Graphs.App(Graphs.Greeter));
        var empty = await Connect(new MekikApp(Graphs.Options(Graphs.Greeter) with { Components = [] }));

        Assert.DoesNotContain("genui_components", plain.Types());
        Assert.DoesNotContain("genui_components", empty.Types());
    }

    [Fact]
    public async Task The_catalog_frame_is_transient_and_never_replays()
    {
        var app = WithComponents();
        var c1 = await Connect(app);
        await app.ReceiveAsync(c1, In.Text("world"));
        Assert.Null(Catalog(c1).Seq());

        var c2 = await Connect(app, new HelloInfo
        {
            ConversationId = (string)c1.Welcome()["conversationId"]!,
            UserId = (string)c1.Welcome()["userId"]!,
            Watermark = 0,
        });

        Assert.Single(c2.Sent, f => f.Type() == "genui_components"); // this connect's own announcement only
        var transcript = await app.History.AfterAsync((string)c1.Welcome()["conversationId"]!, 0);
        Assert.DoesNotContain(transcript, f => f.Type() == "genui_components");
    }

    [Fact]
    public async Task Handshake_order_is_welcome_components_skills_then_the_replay_tail_then_the_greeting()
    {
        var app = new MekikApp(Graphs.Options(Graphs.Greeter) with
        {
            Components = [OrderCard],
            Skills = SkillSources.Inline(new SkillEntry { Name = "pdf", Description = "Fill PDF forms.", Instructions = "…" }),
            Greeting = _ => "Hi!",
        });
        var first = await Connect(app);
        Assert.Equal(["welcome", "genui_components", "skills", "text"], first.Types()); // fresh: greeting last
        await app.ReceiveAsync(first, In.Text("Ada"));

        var back = await Connect(app, new HelloInfo
        {
            ConversationId = (string)first.Welcome()["conversationId"]!,
            UserId = (string)first.Welcome()["userId"]!,
            Watermark = 0,
        });

        Assert.Equal(["welcome", "genui_components", "skills", "text", "text", "genui", "genui", "text"], back.Types());
        Assert.Equal([1L, 2, 3, 4, 5], back.Sent.Seqs());
    }

    [Fact]
    public async Task The_skill_catalog_hash_is_stable_and_a_matching_hash_gets_unchanged()
    {
        MekikApp App() => new(Graphs.Options(Graphs.Echo) with
        {
            Skills = SkillSources.Inline(
                new SkillEntry { Name = "pdf", Description = "Fill PDF forms.", Instructions = "a" },
                new SkillEntry { Name = "brand-voice", Description = "House style.", Instructions = "b", Tags = ["tone"] }),
        });
        var a = (await Connect(App())).Sent.Single(f => f.Type() == "skills");
        var b = (await Connect(App())).Sent.Single(f => f.Type() == "skills");
        Assert.Equal(a["hash"], b["hash"]); // same catalog, same hash, across app instances

        var again = (await Connect(App(), new HelloInfo { SkillsHash = (string)a["hash"]! })).Sent.Single(f => f.Type() == "skills");

        Assert.Equal(true, again["unchanged"]);
        Assert.False(again.ContainsKey("skills"));
        var listed = ((IEnumerable<object?>)a["skills"]!).Cast<Frame>().ToList();
        Assert.Equal(["brand-voice", "pdf"], listed.Select(s => s["name"]));
        Assert.All(listed, s => Assert.Equal("server", s["source"]));
        Assert.All(listed, s => Assert.False(s.ContainsKey("instructions"))); // level 1 only
    }

    [Fact]
    public async Task A_greeting_that_is_neither_text_nor_a_spec_nor_a_list_is_ignored()
    {
        var app = new MekikApp(Graphs.Options(Graphs.Echo) with { Greeting = _ => 42L });

        var c = await Connect(app);

        Assert.Equal(["welcome"], c.Types());
    }
}
