using Mekik;
using Ilmek;

namespace Mekik.Tests;

/// <summary>
/// The .NET half of cross-language parity (conformance/README.md). Loads the SAME
/// golden fixtures the TypeScript suite runs, replays them through
/// <see cref="Mapper.EventToFrames"/>, and asserts the output matches
/// `expectedFrames` byte-for-byte after canonicalization. If this passes, the two
/// implementations produce the identical wire.
/// </summary>
public class ConformanceTests
{
    private const long FixedClock = 1750000000000;

    public static IEnumerable<object[]> Fixtures()
    {
        foreach (var path in Directory.EnumerateFiles(FixturesDir(), "*.json").OrderBy(p => p))
            yield return [Path.GetFileName(path), path];
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void Fixture_maps_to_expected_frames(string name, string path)
    {
        var fixture = (IReadOnlyDictionary<string, object?>)Json.Parse(File.ReadAllText(path))!;

        var startSeq = Convert.ToInt64(fixture["startSeq"]);
        var replyChannel = fixture.GetValueOrDefault("replyChannel") as string;
        var events = ((IEnumerable<object?>)fixture["events"]!)
            .Cast<IReadOnlyDictionary<string, object?>>()
            .Select(BuildEvent)
            .ToList();
        var expected = ((IEnumerable<object?>)fixture["expectedFrames"]!).ToList();

        var actual = Mapper.EventToFrames(events, DeterministicDeps(startSeq, replyChannel));

        Assert.True(actual.Count == expected.Count,
            $"{name}: frame count got {actual.Count}, expected {expected.Count}");

        for (var i = 0; i < actual.Count; i++)
            Assert.Equal(Json.Canonicalize(expected[i]), Json.Canonicalize(actual[i]));
    }

    // ── deterministic environment (conformance/README.md) ─────────────────────

    private sealed class CountingMinter : IIdMinter
    {
        private int _msg;
        private int _stream;
        public string Message() => $"msg-{++_msg}";
        public string Stream() => $"stream-{++_stream}";
    }

    private static TurnMapperDeps DeterministicDeps(long startSeq, string? replyChannel)
    {
        var seq = startSeq;
        return new TurnMapperDeps
        {
            AllocSeq = () => ++seq,
            Mint = new CountingMinter(),
            Now = () => FixedClock,
            Reply = replyChannel is null
                ? null
                : state => state.GetValueOrDefault(replyChannel) as string,
        };
    }

    // ── build ilmek events from fixture JSON ──────────────────────────────────

    private static IlmekEvent BuildEvent(IReadOnlyDictionary<string, object?> ev) => (ev["type"] as string) switch
    {
        "run_start" => new RunStartEvent(),
        "node_start" => new NodeStartEvent { Node = (string)ev["node"]!, TaskId = (string)ev["taskId"]! },
        "custom" => new CustomEvent { Payload = ev.GetValueOrDefault("payload") },
        "interrupt" => new InterruptEvent { Pending = BuildPending(ev["pending"]) },
        "run_end" => BuildRunEnd(ev),
        var t => throw new InvalidOperationException($"fixture uses unmodelled event type {t}"),
    };

    private static IReadOnlyList<Pending> BuildPending(object? pending) =>
        ((IEnumerable<object?>)pending!)
            .Cast<IReadOnlyDictionary<string, object?>>()
            .Select(p => new Pending((string)p["id"]!, (string)p["taskId"]!, (string)p["node"]!, (string)p["key"]!, p.GetValueOrDefault("payload")))
            .ToList();

    private static RunEndEvent BuildRunEnd(IReadOnlyDictionary<string, object?> ev)
    {
        var status = (ev["status"] as string) switch
        {
            "done" => RunStatus.Done,
            "interrupted" => RunStatus.Interrupted,
            "error" => RunStatus.Error,
            "aborted" => RunStatus.Aborted,
            var s => throw new InvalidOperationException($"unknown run_end status {s}"),
        };
        return new RunEndEvent
        {
            Status = status,
            FinalState = ev.GetValueOrDefault("state") as IReadOnlyDictionary<string, object?>,
            Pending = status == RunStatus.Interrupted ? BuildPending(ev["pending"]) : null,
            AbortReason = ev.GetValueOrDefault("reason") as string,
        };
    }

    /// <summary>
    /// The shared golden fixtures, copied next to the test assembly by the csproj.
    /// Resolved from the output directory rather than the source path, because a
    /// deterministic CI build rewrites source paths to <c>/_/</c>.
    /// </summary>
    private static string FixturesDir() => Path.Combine(AppContext.BaseDirectory, "fixtures");
}
