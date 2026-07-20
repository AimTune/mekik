using Microsoft.Extensions.AI;

using Ilmek;
using Mekik;
using Mekik.Agents;

namespace Mekik.Agents.Tests;

/// <summary>
/// Drives real <see cref="AIFunction"/>s through a real ilmek graph and the real
/// mekik engine, then asserts on the frames a client would actually receive —
/// the policy is only meaningful in terms of what reaches the wire. Mirror of the
/// TypeScript suite in ts/packages/langchain/test.
/// </summary>
public class MekikToolsTests
{
    // ── harness ───────────────────────────────────────────────────────────────

    private sealed class FakeConn : IConnection
    {
        public string Id => "c-1";
        private readonly List<IReadOnlyDictionary<string, object?>> _sent = new();
        public IReadOnlyList<IReadOnlyDictionary<string, object?>> Sent => _sent;
        public void Send(IReadOnlyDictionary<string, object?> frame) => _sent.Add(frame);
        public void Close(int? code = null, string? reason = null) { }
        public List<IReadOnlyDictionary<string, object?>> Drain()
        {
            var copy = _sent.ToList();
            _sent.Clear();
            return copy;
        }
    }

    private static string? Type(IReadOnlyDictionary<string, object?> f) => f.GetValueOrDefault("type") as string;

    private static IReadOnlyDictionary<string, object?> Data(IReadOnlyDictionary<string, object?> f) =>
        (IReadOnlyDictionary<string, object?>)f["data"]!;

    /// <summary>The `tool_call` frames for one function name, in order.</summary>
    private static List<IReadOnlyDictionary<string, object?>> Calls(
        IEnumerable<IReadOnlyDictionary<string, object?>> frames, string name) =>
        frames.Where(f => Type(f) == "tool_call" && Data(f).GetValueOrDefault("name") as string == name)
              .Select(Data)
              .ToList();

    /// <summary>Counts real executions, so "exactly-once" is measured, not assumed.</summary>
    private sealed class Counters
    {
        public int GetOrder;
        public int Refund;
        public int Lookup;
        public int Charge;
    }

    private static AIFunction Fn(string name, string description, Delegate body) =>
        AIFunctionFactory.Create(body, name, description);

    private static (AIFunction GetOrder, AIFunction Refund, AIFunction Lookup, AIFunction Charge) MakeTools(Counters c) =>
    (
        Fn("get_order", "Look up an order", (string id) =>
        {
            c.GetOrder++;
            return new Dictionary<string, object?> { ["id"] = id, ["total"] = 249.9 };
        }),
        Fn("refund_payment", "Refund an order", (string orderId) =>
        {
            c.Refund++;
            return new Dictionary<string, object?> { ["refunded"] = true, ["orderId"] = orderId };
        }),
        Fn("internal_lookup", "Internal risk check", () =>
        {
            c.Lookup++;
            return new Dictionary<string, object?> { ["risk"] = "low" };
        }),
        Fn("charge", "Charge a card", (string cardNumber, double amount) =>
        {
            c.Charge++;
            return new Dictionary<string, object?> { ["ok"] = true, ["cardNumber"] = cardNumber, ["amount"] = amount };
        })
    );

    /// <summary>A graph whose node "is" the agent: it calls the wrapped functions directly.</summary>
    private static MekikApp MakeApp(Func<IContext, ValueTask<string>> body)
    {
        var g = Graph.Create("agent")
            .Channel("input", Channels.LastWrite(""))
            .Channel("reply", Channels.LastWrite(""))
            .Node("agent", async (State _, IContext ctx) => Update.Of("reply", await body(ctx)))
            .Edge(Graph.Start, "agent")
            .Edge("agent", Graph.End)
            .Compile();

        return new MekikApp(new MekikOptions
        {
            Graph = g,
            Checkpointer = new InMemoryCheckpointer(),
            Reply = s => s.GetValueOrDefault("reply") as string,
        });
    }

    private static Dictionary<string, object?> TextFrame(string text) => new()
    {
        ["type"] = "text",
        ["data"] = new Dictionary<string, object?> { ["text"] = text },
    };

    // ── visibility ────────────────────────────────────────────────────────────

    [Fact]
    public async Task Shown_function_reaches_the_wire_as_running_then_completed()
    {
        var c = new Counters();
        var (getOrder, _, _, _) = MakeTools(c);

        var app = MakeApp(async ctx =>
        {
            var tools = MekikTools.Wrap(ctx, [getOrder]);
            await tools[0].InvokeAsync(new AIFunctionArguments { ["id"] = "ORD-42" });
            return "done";
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        conn.Drain();
        await app.ReceiveAsync(conn, TextFrame("go"));

        var calls = Calls(conn.Sent, "get_order");
        Assert.Equal(["running", "completed"], calls.Select(d => d["status"] as string));
        // running and completed are the same call, upserted by id.
        Assert.Equal(calls[0]["id"], calls[1]["id"]);
    }

    [Fact]
    public async Task Show_false_runs_the_function_but_emits_nothing()
    {
        var c = new Counters();
        var (_, _, lookup, _) = MakeTools(c);

        var app = MakeApp(async ctx =>
        {
            var tools = MekikTools.Wrap(ctx, [lookup],
                new Dictionary<string, ToolPolicy> { ["internal_lookup"] = new() { Show = false } });
            await tools[0].InvokeAsync(new AIFunctionArguments());
            return "done";
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("go"));

        Assert.Empty(Calls(conn.Sent, "internal_lookup"));
        Assert.Equal(1, c.Lookup); // but it did run
    }

    [Fact]
    public async Task Redact_masks_the_surfaced_trace_not_the_functions_own_input()
    {
        var c = new Counters();
        var (_, _, _, charge) = MakeTools(c);
        string? seenByFunction = null;

        var app = MakeApp(async ctx =>
        {
            var tools = MekikTools.Wrap(ctx, [charge],
                new Dictionary<string, ToolPolicy> { ["charge"] = new() { Redact = ["cardNumber"] } });
            var result = await tools[0].InvokeAsync(
                new AIFunctionArguments { ["cardNumber"] = "4111111111111111", ["amount"] = 10.0 });
            seenByFunction = ExtractCardNumber(result);
            return "done";
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("go"));

        var calls = Calls(conn.Sent, "charge");
        var parameters = (IReadOnlyDictionary<string, object?>)calls[0]["params"]!;
        Assert.Equal(MekikTools.Redacted, parameters["cardNumber"]);
        Assert.Equal(10.0, parameters["amount"]); // non-redacted field survives
        Assert.Equal("4111111111111111", seenByFunction); // the function got the real value
    }

    [Fact]
    public async Task Redact_reaches_into_a_function_result_and_its_nested_rows()
    {
        // Regression: AIFunctionFactory marshals return values through
        // System.Text.Json, so a result arrives as a JsonElement rather than a
        // dictionary. Redact used to walk only dictionaries, which meant it
        // silently masked nothing on the way back — the params were masked, the
        // result leaked. Both directions are asserted here.
        var lookup = Fn("lookup_customers", "Find customers", () => new Dictionary<string, object?>
        {
            ["count"] = 2,
            ["rows"] = new List<object?>
            {
                new Dictionary<string, object?> { ["name"] = "Grace", ["email"] = "grace@example.com" },
                new Dictionary<string, object?> { ["name"] = "Ada", ["email"] = "ada@example.com" },
            },
        });

        object? seenByFunction = null;
        var app = MakeApp(async ctx =>
        {
            var tools = MekikTools.Wrap(ctx, [lookup],
                new Dictionary<string, ToolPolicy> { ["lookup_customers"] = new() { Redact = ["email"] } });
            seenByFunction = await tools[0].InvokeAsync(new AIFunctionArguments());
            return "done";
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("go"));

        var completed = Calls(conn.Sent, "lookup_customers")[1];
        var wire = System.Text.Json.JsonSerializer.Serialize(completed["result"]);
        Assert.DoesNotContain("grace@example.com", wire, StringComparison.Ordinal);
        Assert.DoesNotContain("ada@example.com", wire, StringComparison.Ordinal);
        Assert.Contains(MekikTools.Redacted, wire, StringComparison.Ordinal);
        Assert.Contains("Grace", wire, StringComparison.Ordinal); // siblings survive

        // The function's own return value is untouched — masking is a wire concern.
        Assert.Contains("grace@example.com",
            System.Text.Json.JsonSerializer.Serialize(seenByFunction), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_failing_function_surfaces_status_error_and_rethrows()
    {
        // Typed explicitly: a lambda whose body is a `throw` has no inferable
        // delegate type for the `Delegate` parameter.
        Func<string> failing = () => throw new InvalidOperationException("upstream down");
        var boom = Fn("boom", "fails", failing);

        var app = MakeApp(async ctx =>
        {
            var tools = MekikTools.Wrap(ctx, [boom]);
            await tools[0].InvokeAsync(new AIFunctionArguments());
            return "unreachable";
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("go"));

        var last = Calls(conn.Sent, "boom").Last();
        Assert.Equal("error", last["status"]);
        Assert.Contains("upstream down", last["error"] as string);
        Assert.Contains(conn.Sent, f => Type(f) == "run" && Data(f).GetValueOrDefault("status") as string == "error");
    }

    // ── approval + exactly-once ───────────────────────────────────────────────

    [Fact]
    public async Task Approve_pauses_before_the_function_runs_and_lets_it_through_once()
    {
        var c = new Counters();
        var (getOrder, refund, _, _) = MakeTools(c);

        var app = MakeApp(async ctx =>
        {
            var tools = MekikTools.Wrap(ctx, [getOrder, refund], new Dictionary<string, ToolPolicy>
            {
                ["get_order"] = new(),
                ["refund_payment"] = new() { Approve = new ApproveSpec() },
            });
            await tools[0].InvokeAsync(new AIFunctionArguments { ["id"] = "ORD-42" });
            await tools[1].InvokeAsync(new AIFunctionArguments { ["orderId"] = "ORD-42" });
            return "refunded ORD-42";
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        conn.Drain();

        // Turn 1: get_order runs, then the graph parks on the refund approval.
        await app.ReceiveAsync(conn, TextFrame("refund ORD-42"));
        var t1 = conn.Drain();
        Assert.Equal(["running", "completed"], Calls(t1, "get_order").Select(d => d["status"] as string));
        Assert.Empty(Calls(t1, "refund_payment"));
        Assert.Equal(0, c.Refund); // the effect is gated behind the pause

        var interrupt = t1.Single(f => Type(f) == "interrupt");
        var payload = (IReadOnlyDictionary<string, object?>)Data(interrupt)["payload"]!;
        Assert.Equal("refund_payment", payload["tool"]);
        var interruptId = (string)interrupt["id"]!;

        // Turn 2: approve → the refund runs and completes.
        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "resume",
            ["answers"] = new Dictionary<string, object?>
            {
                [interruptId] = new Dictionary<string, object?> { ["approved"] = true },
            },
        });
        var t2 = conn.Drain();
        Assert.Equal(["running", "completed"], Calls(t2, "refund_payment").Select(d => d["status"] as string));
        Assert.Contains(t2, f => Type(f) == "run" && Data(f).GetValueOrDefault("status") as string == "finished");

        // The point: the node re-ran from the top on resume, but neither effect doubled.
        Assert.Equal(1, c.GetOrder); // journaled — not re-invoked on replay
        Assert.Equal(1, c.Refund);
    }

    [Fact]
    public async Task Rejecting_returns_an_observation_and_never_runs_the_function()
    {
        var c = new Counters();
        var (_, refund, _, _) = MakeTools(c);

        var app = MakeApp(async ctx =>
        {
            var tools = MekikTools.Wrap(ctx, [refund], new Dictionary<string, ToolPolicy>
            {
                ["refund_payment"] = new()
                {
                    Approve = new ApproveSpec { Title = "Refund $249.90?", DenyMessage = "User said no." },
                },
            });
            return (await tools[0].InvokeAsync(new AIFunctionArguments { ["orderId"] = "ORD-42" }))?.ToString() ?? "";
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        conn.Drain();

        await app.ReceiveAsync(conn, TextFrame("refund"));
        var interrupt = conn.Drain().Single(f => Type(f) == "interrupt");
        var payload = (IReadOnlyDictionary<string, object?>)Data(interrupt)["payload"]!;
        Assert.Equal("Refund $249.90?", payload["title"]);

        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "resume",
            ["answers"] = new Dictionary<string, object?>
            {
                [(string)interrupt["id"]!] = new Dictionary<string, object?> { ["approved"] = false },
            },
        });
        var t2 = conn.Drain();

        Assert.Equal(0, c.Refund); // declined functions never execute
        Assert.Empty(Calls(t2, "refund_payment")); // and emit no trace
        // The model got a plain observation back, so its loop can continue.
        Assert.Contains(t2, f =>
            Type(f) == "text" && f.GetValueOrDefault("from") as string == "bot"
            && Data(f).GetValueOrDefault("text") as string == "User said no.");
    }

    [Fact]
    public async Task Two_approving_functions_in_one_node_keep_distinct_interrupt_ids()
    {
        var c = new Counters();
        var (_, refund, _, charge) = MakeTools(c);

        var app = MakeApp(async ctx =>
        {
            var tools = MekikTools.Wrap(ctx, [refund, charge], new Dictionary<string, ToolPolicy>
            {
                ["refund_payment"] = new() { Approve = new ApproveSpec() },
                ["charge"] = new() { Approve = new ApproveSpec() },
            });
            await tools[0].InvokeAsync(new AIFunctionArguments { ["orderId"] = "A" });
            await tools[1].InvokeAsync(new AIFunctionArguments { ["cardNumber"] = "4111", ["amount"] = 1.0 });
            return "done";
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        conn.Drain();

        // Sequential awaits mean one pause at a time; answering the first must
        // surface the second rather than resolving both.
        await app.ReceiveAsync(conn, TextFrame("go"));
        var first = conn.Drain().Single(f => Type(f) == "interrupt");
        Assert.Equal("refund_payment",
            ((IReadOnlyDictionary<string, object?>)Data(first)["payload"]!)["tool"]);

        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "resume",
            ["answers"] = new Dictionary<string, object?>
            {
                [(string)first["id"]!] = new Dictionary<string, object?> { ["approved"] = true },
            },
        });
        var second = conn.Drain().Single(f => Type(f) == "interrupt");
        Assert.Equal("charge",
            ((IReadOnlyDictionary<string, object?>)Data(second)["payload"]!)["tool"]);
        Assert.NotEqual((string)first["id"]!, (string)second["id"]!);
    }

    // ── unit-level checks on the helpers ──────────────────────────────────────

    [Theory]
    [InlineData(true, true)]
    [InlineData(false, false)]
    [InlineData("yes", true)]
    [InlineData("approve", true)]
    [InlineData("nope", false)]
    public void IsApproved_accepts_the_shapes_clients_actually_send(object answer, bool expected) =>
        Assert.Equal(expected, MekikTools.IsApproved(answer));

    [Fact]
    public void IsApproved_reads_the_approved_field_of_an_object_answer()
    {
        Assert.True(MekikTools.IsApproved(new Dictionary<string, object?> { ["approved"] = true }));
        Assert.False(MekikTools.IsApproved(new Dictionary<string, object?> { ["approved"] = false }));
        Assert.False(MekikTools.IsApproved(new Dictionary<string, object?> { ["other"] = true }));
    }

    /// <summary>An AIFunction result round-trips as JSON, so read the field back out of it.</summary>
    private static string? ExtractCardNumber(object? result) => result switch
    {
        IReadOnlyDictionary<string, object?> d => d.GetValueOrDefault("cardNumber")?.ToString(),
        System.Text.Json.JsonElement je when je.ValueKind == System.Text.Json.JsonValueKind.Object
            && je.TryGetProperty("cardNumber", out var v) => v.GetString(),
        _ => result?.ToString(),
    };
}
