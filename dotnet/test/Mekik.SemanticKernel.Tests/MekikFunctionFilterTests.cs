using Microsoft.SemanticKernel;

using Ilmek;
using Mekik;
using Mekik.Agents;
using Mekik.SemanticKernel;

namespace Mekik.SemanticKernel.Tests;

/// <summary>
/// Drives real <see cref="KernelFunction"/>s through a real <see cref="Kernel"/>,
/// a real ilmek graph and the real mekik engine, then asserts on the frames a
/// client would actually receive. Invoking through the kernel is the point: it is
/// what proves the filter fires on the same path auto function calling and the
/// agent types use.
/// </summary>
public class MekikFunctionFilterTests
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

    private static List<IReadOnlyDictionary<string, object?>> Calls(
        IEnumerable<IReadOnlyDictionary<string, object?>> frames, string name) =>
        frames.Where(f => Type(f) == "tool_call" && Data(f).GetValueOrDefault("name") as string == name)
              .Select(Data)
              .ToList();

    private sealed class Counters
    {
        public int GetOrder;
        public int Refund;
        public int Lookup;
    }

    /// <summary>A graph whose node "is" the agent: it invokes kernel functions.</summary>
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

    // ── tests ─────────────────────────────────────────────────────────────────

    [Fact]
    public async Task A_kernel_function_call_reaches_the_wire_as_running_then_completed()
    {
        var c = new Counters();
        var getOrder = KernelFunctionFactory.CreateFromMethod(
            (string id) => { c.GetOrder++; return $"order:{id}"; }, "get_order", "Look up an order");

        var app = MakeApp(async ctx =>
        {
            var kernel = new Kernel();
            using var _ = kernel.UseMekik(ctx);
            var result = await kernel.InvokeAsync(getOrder, new KernelArguments { ["id"] = "ORD-42" });
            return result.ToString();
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        conn.Drain();
        await app.ReceiveAsync(conn, TextFrame("go"));

        var calls = Calls(conn.Sent, "get_order");
        Assert.Equal(["running", "completed"], calls.Select(d => d["status"] as string));
        Assert.Equal(calls[0]["id"], calls[1]["id"]); // upserted by id
        Assert.Equal(1, c.GetOrder);
    }

    [Fact]
    public async Task Show_false_runs_the_function_but_emits_nothing()
    {
        var c = new Counters();
        var lookup = KernelFunctionFactory.CreateFromMethod(
            () => { c.Lookup++; return "low"; }, "internal_lookup", "Internal risk check");

        var app = MakeApp(async ctx =>
        {
            var kernel = new Kernel();
            using var _ = kernel.UseMekik(ctx,
                new Dictionary<string, ToolPolicy> { ["internal_lookup"] = new() { Show = false } });
            await kernel.InvokeAsync(lookup);
            return "done";
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("go"));

        Assert.Empty(Calls(conn.Sent, "internal_lookup"));
        Assert.Equal(1, c.Lookup);
    }

    [Fact]
    public async Task Redact_masks_the_surfaced_params_not_what_the_function_receives()
    {
        string? seenByFunction = null;
        var charge = KernelFunctionFactory.CreateFromMethod(
            (string cardNumber, double amount) => { seenByFunction = cardNumber; return "ok"; },
            "charge", "Charge a card");

        var app = MakeApp(async ctx =>
        {
            var kernel = new Kernel();
            using var _ = kernel.UseMekik(ctx,
                new Dictionary<string, ToolPolicy> { ["charge"] = new() { Redact = ["cardNumber"] } });
            await kernel.InvokeAsync(charge,
                new KernelArguments { ["cardNumber"] = "4111111111111111", ["amount"] = 10.0 });
            return "done";
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("go"));

        var parameters = (IReadOnlyDictionary<string, object?>)Calls(conn.Sent, "charge")[0]["params"]!;
        Assert.Equal(MekikTools.Redacted, parameters["cardNumber"]);
        Assert.Equal(10.0, parameters["amount"]);
        Assert.Equal("4111111111111111", seenByFunction);
    }

    [Fact]
    public async Task Approve_pauses_before_the_function_runs_and_lets_it_through_once()
    {
        var c = new Counters();
        var getOrder = KernelFunctionFactory.CreateFromMethod(
            (string id) => { c.GetOrder++; return $"order:{id}"; }, "get_order", "Look up an order");
        var refund = KernelFunctionFactory.CreateFromMethod(
            (string orderId) => { c.Refund++; return $"refunded:{orderId}"; }, "refund_payment", "Refund an order");

        var app = MakeApp(async ctx =>
        {
            var kernel = new Kernel();
            using var _ = kernel.UseMekik(ctx, new Dictionary<string, ToolPolicy>
            {
                ["get_order"] = new(),
                ["refund_payment"] = new() { Approve = new ApproveSpec() },
            });
            await kernel.InvokeAsync(getOrder, new KernelArguments { ["id"] = "ORD-42" });
            await kernel.InvokeAsync(refund, new KernelArguments { ["orderId"] = "ORD-42" });
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
        Assert.Equal(0, c.Refund);

        var interrupt = t1.Single(f => Type(f) == "interrupt");
        var payload = (IReadOnlyDictionary<string, object?>)Data(interrupt)["payload"]!;
        Assert.Equal("refund_payment", payload["tool"]);

        // Turn 2: approve → the refund runs and completes.
        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "resume",
            ["answers"] = new Dictionary<string, object?>
            {
                [(string)interrupt["id"]!] = new Dictionary<string, object?> { ["approved"] = true },
            },
        });
        var t2 = conn.Drain();
        Assert.Equal(["running", "completed"], Calls(t2, "refund_payment").Select(d => d["status"] as string));

        // The point: the node re-ran from the top on resume, but neither the
        // kernel invocation nor the effect doubled.
        Assert.Equal(1, c.GetOrder);
        Assert.Equal(1, c.Refund);
    }

    [Fact]
    public async Task A_replayed_call_still_returns_its_recorded_value_to_the_kernel()
    {
        var c = new Counters();
        var getOrder = KernelFunctionFactory.CreateFromMethod(
            (string id) => { c.GetOrder++; return $"order:{id}"; }, "get_order", "Look up an order");
        var gate = KernelFunctionFactory.CreateFromMethod(() => "ok", "gate", "Needs approval");

        // The reply is built from get_order's result, so if the replay pass lost
        // the journaled value the final text would be wrong — not just the counter.
        var app = MakeApp(async ctx =>
        {
            var kernel = new Kernel();
            using var _ = kernel.UseMekik(ctx, new Dictionary<string, ToolPolicy>
            {
                ["gate"] = new() { Approve = new ApproveSpec() },
            });
            var order = (await kernel.InvokeAsync(getOrder, new KernelArguments { ["id"] = "ORD-42" })).ToString();
            await kernel.InvokeAsync(gate);
            return $"got {order}";
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        conn.Drain();

        await app.ReceiveAsync(conn, TextFrame("go"));
        var interrupt = conn.Drain().Single(f => Type(f) == "interrupt");
        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "resume",
            ["answers"] = new Dictionary<string, object?>
            {
                [(string)interrupt["id"]!] = new Dictionary<string, object?> { ["approved"] = true },
            },
        });

        var reply = conn.Drain().Single(f => Type(f) == "text" && f.GetValueOrDefault("from") as string == "bot");
        Assert.Equal("got order:ORD-42", Data(reply)["text"]);
        Assert.Equal(1, c.GetOrder); // recorded, not re-invoked
    }

    [Fact]
    public async Task Rejecting_short_circuits_the_function_and_returns_the_deny_message()
    {
        var c = new Counters();
        var refund = KernelFunctionFactory.CreateFromMethod(
            (string orderId) => { c.Refund++; return "refunded"; }, "refund_payment", "Refund an order");

        var app = MakeApp(async ctx =>
        {
            var kernel = new Kernel();
            using var _ = kernel.UseMekik(ctx, new Dictionary<string, ToolPolicy>
            {
                ["refund_payment"] = new()
                {
                    Approve = new ApproveSpec { Title = "Refund $249.90?", DenyMessage = "User said no." },
                },
            });
            var result = await kernel.InvokeAsync(refund, new KernelArguments { ["orderId"] = "ORD-42" });
            return result.ToString();
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        conn.Drain();

        await app.ReceiveAsync(conn, TextFrame("refund"));
        var interrupt = conn.Drain().Single(f => Type(f) == "interrupt");
        Assert.Equal("Refund $249.90?",
            ((IReadOnlyDictionary<string, object?>)Data(interrupt)["payload"]!)["title"]);

        await app.ReceiveAsync(conn, new Dictionary<string, object?>
        {
            ["type"] = "resume",
            ["answers"] = new Dictionary<string, object?>
            {
                [(string)interrupt["id"]!] = new Dictionary<string, object?> { ["approved"] = false },
            },
        });
        var t2 = conn.Drain();

        Assert.Equal(0, c.Refund);                          // never executed
        Assert.Empty(Calls(t2, "refund_payment"));          // and emitted no trace
        // The kernel still produced a result, so the caller/model can carry on.
        Assert.Contains(t2, f =>
            Type(f) == "text" && f.GetValueOrDefault("from") as string == "bot"
            && Data(f).GetValueOrDefault("text") as string == "User said no.");
    }

    [Fact]
    public async Task A_failing_function_surfaces_status_error_and_rethrows()
    {
        // Typed explicitly: a lambda whose body is a `throw` has no inferable
        // delegate type.
        Func<string> failing = () => throw new InvalidOperationException("upstream down");
        var boom = KernelFunctionFactory.CreateFromMethod(failing, "boom", "fails");

        var app = MakeApp(async ctx =>
        {
            var kernel = new Kernel();
            using var _ = kernel.UseMekik(ctx);
            await kernel.InvokeAsync(boom);
            return "unreachable";
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("go"));

        var last = Calls(conn.Sent, "boom").Last();
        Assert.Equal("error", last["status"]);
        Assert.Contains(conn.Sent, f => Type(f) == "run" && Data(f).GetValueOrDefault("status") as string == "error");
    }

    [Fact]
    public async Task The_scope_removes_the_filter_so_a_reused_kernel_does_not_leak_context()
    {
        var kernel = new Kernel();
        var probe = KernelFunctionFactory.CreateFromMethod(() => "ok", "probe", "probe");

        var app = MakeApp(async ctx =>
        {
            using (kernel.UseMekik(ctx))
            {
                await kernel.InvokeAsync(probe);
            }
            Assert.Empty(kernel.FunctionInvocationFilters);
            return "done";
        });

        var conn = new FakeConn();
        await app.ConnectAsync(conn);
        await app.ReceiveAsync(conn, TextFrame("go"));

        Assert.Single(Calls(conn.Sent, "probe").Where(d => d["status"] as string == "running"));
        Assert.Empty(kernel.FunctionInvocationFilters);
    }
}
