using System.Globalization;
using Mekik;
using Ilmek;

namespace Mekik.Tests;

/// <summary>
/// Text mekik puts on the wire must not depend on the server's culture. On a tr-TR
/// machine <c>249.9.ToString()</c> is "249,9" and <c>true.ToString()</c> is "True";
/// on th-TH the default calendar is Buddhist, so a year formats as 2568. Each test
/// runs under the hostile culture and asserts the TypeScript reference's output.
/// </summary>
public class CultureInvarianceTests
{
    /// <summary>Swap the current culture for the scope of one test (it flows across awaits).</summary>
    private sealed class CultureScope : IDisposable
    {
        private readonly CultureInfo _culture = CultureInfo.CurrentCulture;
        private readonly CultureInfo _ui = CultureInfo.CurrentUICulture;
        public CultureScope(string name)
        {
            CultureInfo.CurrentCulture = new CultureInfo(name);
            CultureInfo.CurrentUICulture = new CultureInfo(name);
        }
        public void Dispose()
        {
            CultureInfo.CurrentCulture = _culture;
            CultureInfo.CurrentUICulture = _ui;
        }
    }

    /// <summary>Parks on a plain interrupt whose payload is the scalar the input names.</summary>
    private static readonly CompiledGraph Scalar = Graph.Create("scalar")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("ask", async (State s, IContext ctx) =>
        {
            object? payload = s.Get<string>("input") switch { "number" => 249.9, "bool" => true, _ => null };
            var answer = await ctx.InterruptAsync<object?>(payload, "ask");
            return Update.Of("reply", Json.Canonicalize(answer));
        })
        .Edge(Graph.Start, "ask")
        .Edge("ask", Graph.End)
        .Compile();

    /// <summary>Returns a fractional number from a traced tool, so it rides a tool_call frame.</summary>
    private static readonly CompiledGraph Priced = Graph.Create("priced")
        .Channel("input", Channels.LastWrite(""))
        .Channel("reply", Channels.LastWrite(""))
        .Node("n", async (State _, IContext ctx) =>
        {
            await Shuttle.Tool(ctx, "quote", new Dictionary<string, object?> { ["amount"] = 1234.5 }, () => 249.9);
            return Update.Of("reply", "ok");
        })
        .Edge(Graph.Start, "n")
        .Edge("n", Graph.End)
        .Compile();

    private static MekikApp App(CompiledGraph g) => new(new MekikOptions
    {
        Graph = g,
        Checkpointer = new InMemoryCheckpointer(),
        Reply = s => s.GetValueOrDefault("reply") as string,
    });

    private static MekikMcpServer Mcp(CompiledGraph g) => new(App(g), new McpServerOptions { Name = "desk" });

    private static string McpText(IReadOnlyDictionary<string, object?> r) =>
        (string)((IReadOnlyDictionary<string, object?>)((IEnumerable<object?>)r["content"]!).First()!)["text"]!;

    private static MekikA2aServer A2a(CompiledGraph g) =>
        new(App(g), new A2aServerOptions { Name = "Desk", Url = "http://x/a2a", Now = () => 1750000000000, MintId = k => $"{k}-1" });

    private static Dictionary<string, object?> Say(string text) => new()
    {
        ["message"] = new Dictionary<string, object?>
        {
            ["role"] = "user",
            ["parts"] = new List<object?> { new Dictionary<string, object?> { ["kind"] = "text", ["text"] = text } },
        },
    };

    private static IReadOnlyDictionary<string, object?> Status(IReadOnlyDictionary<string, object?> task) =>
        (IReadOnlyDictionary<string, object?>)task["status"]!;

    private static string StatusText(IReadOnlyDictionary<string, object?> task) =>
        (string)((IReadOnlyDictionary<string, object?>)((IEnumerable<object?>)((IReadOnlyDictionary<string, object?>)Status(task)["message"]!)["parts"]!).First()!)["text"]!;

    [Theory]
    [InlineData("number", "249.9")]
    [InlineData("bool", "true")]
    [InlineData("null", "null")]
    public async Task Mcp_describes_a_scalar_pause_payload_culture_free_under_tr_TR(string input, string expected)
    {
        using var _ = new CultureScope("tr-TR");
        var text = McpText(await Mcp(Scalar).CallToolAsync("desk", new Dictionary<string, object?> { ["message"] = input }));
        Assert.Contains($": {expected}", text);
        Assert.DoesNotContain("249,9", text);
        Assert.DoesNotContain("True", text);
    }

    [Theory]
    [InlineData("number", "249.9")]
    [InlineData("bool", "true")]
    public async Task A2a_describes_a_scalar_pause_payload_culture_free_under_tr_TR(string input, string expected)
    {
        using var _ = new CultureScope("tr-TR");
        var task = await A2a(Scalar).SendMessageAsync(Say(input));
        Assert.Equal("input-required", Status(task)["state"]);
        Assert.Contains($": {expected}", StatusText(task));
    }

    [Theory]
    [InlineData("tr-TR")]
    [InlineData("th-TH")]
    [InlineData("ar-SA")]
    public async Task A2a_status_timestamps_are_ISO_8601_Gregorian_whatever_the_culture(string culture)
    {
        using var _ = new CultureScope(culture);
        var task = await A2a(Scalar).SendMessageAsync(Say("number"));
        Assert.Equal("2025-06-15T15:06:40.000Z", Status(task)["timestamp"]);
    }

    [Fact]
    public async Task Frames_carrying_fractional_numbers_serialize_with_a_dot_under_tr_TR()
    {
        using var _ = new CultureScope("tr-TR");
        var r = await Mcp(Priced).CallToolAsync("desk", new Dictionary<string, object?> { ["message"] = "go" }.AsReadOnly());
        var wire = Json.Canonicalize(r);
        Assert.DoesNotContain("249,9", wire);
        var traces = ((IEnumerable<object?>)((IReadOnlyDictionary<string, object?>)r["structuredContent"]!)["toolCalls"]!).Count();
        Assert.Equal(1, traces);
        Assert.Equal("[249.9,1234.5,1e+21,0.1]", Json.Canonicalize(new List<object?> { 249.9, 1234.5, 1e21, 0.1 }));
    }

    [Fact]
    public void ClaimStrings_renders_boxed_numbers_and_booleans_as_TypeScript_does_under_tr_TR()
    {
        using var _ = new CultureScope("tr-TR");
        var claims = new Dictionary<string, object?> { ["levels"] = new List<object?> { 249.9, 3L, true, "admin" } };
        Assert.Equal(["249.9", "3", "true", "admin"], Shuttle.ClaimStrings(claims, "levels"));
    }
}
