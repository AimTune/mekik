using System.Text.Json;
using Mekik;

namespace Mekik.Redis.Tests;

using Frame = IReadOnlyDictionary<string, object?>;

/// <summary>
/// Replays conformance/redis/envelope.json — the backplane envelope both RedisBackplane
/// implementations share (PROTOCOL.md §5.1). The TypeScript suite replays the same file
/// (ts/packages/redis/test/envelope.test.ts), so a .NET node and a TypeScript node can
/// share one Redis channel: each decodes what the other encodes.
/// </summary>
public class EnvelopeConformanceTests
{
    private static readonly Frame Fixture =
        (Frame)Json.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "redis", "envelope.json")))!;

    private static IEnumerable<Frame> Cases(string kind) => ((List<object?>)Fixture[kind]!).Cast<Frame>();

    private static Frame Case(string kind, string name) => Cases(kind).Single(c => (string)c["name"]! == name);

    public static TheoryData<string> EncodeCases() => new(Cases("encode").Select(c => (string)c["name"]!));

    public static TheoryData<string> DecodeCases() => new(Cases("decode").Select(c => (string)c["name"]!));

    private static BackplaneMessage ToMessage(Frame expected) =>
        new((string)expected["originId"]!, (Frame)expected["frame"]!);

    private static void AssertSame(Frame? expected, BackplaneMessage? actual)
    {
        if (expected is null)
        {
            Assert.Null(actual);
            return;
        }
        Assert.NotNull(actual);
        Assert.Equal((string)expected["originId"]!, actual.OriginId);
        Assert.Equal(Json.Canonicalize(expected["frame"]), Json.Canonicalize(actual.Frame));
    }

    [Fact]
    public void The_fixture_is_populated()
    {
        Assert.NotEmpty(Cases("encode"));
        Assert.NotEmpty(Cases("decode"));
    }

    [Theory]
    [MemberData(nameof(EncodeCases))]
    public void Encode_writes_the_canonical_camelCase_wire(string name)
    {
        var c = Case("encode", name);

        Assert.Equal((string)c["wire"]!, BackplaneEnvelope.Encode(ToMessage((Frame)c["message"]!)));
    }

    [Theory]
    [MemberData(nameof(EncodeCases))]
    public void Every_encoded_wire_decodes_back_to_its_message(string name)
    {
        var c = Case("encode", name);

        AssertSame((Frame)c["message"]!, BackplaneEnvelope.Decode((string)c["wire"]!));
    }

    [Theory]
    [MemberData(nameof(DecodeCases))]
    public void Decode(string name)
    {
        var c = Case("decode", name);

        AssertSame((Frame?)c["expect"], BackplaneEnvelope.Decode((string)c["payload"]!));
    }

    [Fact]
    public void The_legacy_PascalCase_case_is_exactly_what_the_old_serializer_wrote()
    {
        // Pins the fixture's legacy payload to the real 0.9 encoding (System.Text.Json
        // defaults over the record), so the read-either-casing path is tested against it.
        var c = Case("decode", "PascalCase, escaped (.NET <= 0.9, read for one release)");
        var expect = (Frame)c["expect"]!;
        var legacy = JsonSerializer.Serialize(ToMessage(expect), JsonSerializerOptions.Default);

        Assert.Equal((string)c["payload"]!, legacy);
    }

    [Fact]
    public async Task A_TypeScript_encoded_envelope_reaches_a_dotnet_subscriber()
    {
        var redis = new FakeRedis();
        var bp = new RedisBackplane(redis.Multiplexer);
        var received = new List<BackplaneMessage>();
        await using var sub = await bp.SubscribeAsync("c", received.Add);
        var ts = Case("encode", "TypeScript node");
        var tsLegacy = Case("decode", "camelCase, insertion-ordered (TypeScript <= 0.9)");

        redis.Inject("mekik:bp:c", (string)ts["wire"]!);
        redis.Inject("mekik:bp:c", (string)tsLegacy["payload"]!);
        foreach (var bad in Cases("decode").Where(d => d["expect"] is null))
            redis.Inject("mekik:bp:c", (string)bad["payload"]!);

        Assert.Equal(2, received.Count);
        AssertSame((Frame)ts["message"]!, received[0]);
        AssertSame((Frame)tsLegacy["expect"]!, received[1]);
    }

    [Fact]
    public async Task A_dotnet_node_publishes_the_shared_wire()
    {
        var redis = new FakeRedis();
        var bp = new RedisBackplane(redis.Multiplexer);
        var c = Case("encode", ".NET node");

        await bp.PublishAsync("c", ToMessage((Frame)c["message"]!));

        Assert.Equal((string)c["wire"]!, redis.Published.Single().Payload);
    }
}
