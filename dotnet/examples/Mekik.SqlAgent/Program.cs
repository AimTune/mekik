// The .NET mirror of ts/examples/sql-agent.ts: an analytics desk over a real
// SQLite database. The model is given no schema up front — it discovers the
// tables, reads their columns, writes its own SQL, and explains the answer.
// Three scenarios run back to back:
//
//   1. discovery  — list_tables (hidden) → describe_table → run_query, and the
//                   result set renders as a `data-table` GenUI card
//   2. redaction  — a query that returns customer emails: the model sees the real
//                   addresses, the surfaced trace shows «redacted»
//   3. correction — the user asks for a DELETE; the read-only guard rejects it,
//                   the failure surfaces as a `tool_call` error frame, and the
//                   model recovers and answers instead of the node crashing
//
//   ANTHROPIC_API_KEY=sk-ant-… dotnet run --project dotnet/examples/Mekik.SqlAgent
//   dotnet run --project dotnet/examples/Mekik.SqlAgent -- --probe   # no key, no API call
//
// `--probe` replaces only the model's decisions with a fixed script and runs the
// identical graph, tools and wire path, asserting the three behaviours above. CI
// runs it, so this example is protected without a key or a bill.

using System.Text.Json;

using Anthropic;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.AI;

using Ilmek;
using Mekik;
using Mekik.Agents;

// ── the database ──────────────────────────────────────────────────────────────

// Money is stored in cents, and the column is `unit_price_cents` — deliberately
// not the shape a question is asked in. The model has to read the schema and do
// the conversion itself, which is the part worth demonstrating.
// The connection stays open for the process lifetime: closing it would drop the
// in-memory database.
var conn = new SqliteConnection("Data Source=:memory:");
conn.Open();
Execute(@"
    CREATE TABLE customers (
        id    TEXT PRIMARY KEY,
        name  TEXT NOT NULL,
        email TEXT NOT NULL,
        tier  TEXT NOT NULL CHECK (tier IN ('gold', 'silver', 'standard'))
    );
    CREATE TABLE orders (
        id          TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        placed_on   TEXT NOT NULL,
        status      TEXT NOT NULL
    );
    CREATE TABLE order_items (
        order_id         TEXT NOT NULL REFERENCES orders(id),
        sku              TEXT NOT NULL,
        qty              INTEGER NOT NULL,
        unit_price_cents INTEGER NOT NULL
    );

    INSERT INTO customers (id, name, email, tier) VALUES
        ('CUS-1', 'Ada Lovelace', 'ada@example.com',   'gold'),
        ('CUS-2', 'Grace Hopper', 'grace@example.com', 'gold'),
        ('CUS-3', 'Alan Turing',  'alan@example.com',  'silver'),
        ('CUS-4', 'Katherine J.', 'kj@example.com',    'standard');

    INSERT INTO orders (id, customer_id, placed_on, status) VALUES
        ('ORD-1', 'CUS-1', '2026-06-03', 'delivered'),
        ('ORD-2', 'CUS-1', '2026-06-21', 'delivered'),
        ('ORD-3', 'CUS-2', '2026-06-11', 'delivered'),
        ('ORD-4', 'CUS-3', '2026-06-14', 'refunded'),
        ('ORD-5', 'CUS-4', '2026-05-28', 'delivered'),
        ('ORD-6', 'CUS-2', '2026-07-02', 'shipped');

    INSERT INTO order_items (order_id, sku, qty, unit_price_cents) VALUES
        ('ORD-1', 'KETTLE-01', 1, 24990),
        ('ORD-1', 'MUG-07',    2,  1250),
        ('ORD-2', 'GRINDER-3', 1, 18900),
        ('ORD-3', 'KETTLE-01', 2, 24990),
        ('ORD-3', 'FILTER-XL', 4,   890),
        ('ORD-4', 'MUG-07',    1,  1250),
        ('ORD-5', 'CABLE-2M',  3,   650),
        ('ORD-6', 'GRINDER-3', 1, 18900);
");

// The queries actually run, so the run can be reported honestly at the end rather
// than us claiming behaviour we did not observe.
var audit = new List<(string Sql, string Outcome)>();

// Columns that must never reach the client. Declared once because they are needed
// in *two* places, and the second one is easy to miss: the Redact policy masks the
// `tool_call` frame mekik emits for you, but it has no say over a `genui` chunk
// the tool emits itself. Anything a tool renders directly is the tool's own
// responsibility to mask.
string[] privateColumns = ["email"];

// ── the tools ─────────────────────────────────────────────────────────────────

const string System = "You are a data analyst answering questions about a shop's SQLite database. " +
    "You do not know the schema: discover it with list_tables and describe_table before querying. " +
    "Prices are stored in cents — convert to dollars when you report money. " +
    "The connection is read-only. If a request needs a write, explain that you cannot make it rather than trying twice. " +
    "Answer the user in one or two short sentences; the rows are already shown to them as a table.";

const int MaxTurns = 10;

// Built per run so `run_query` can emit its GenUI card through *this* run's ctx.
IReadOnlyList<AIFunction> MakeSqlTools(IContext ctx)
{
    var functions = new List<AIFunction>
    {
        AIFunctionFactory.Create(
            () => string.Join(", ", Query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").Rows
                .Select(r => r["name"] as string)),
            "list_tables",
            "List every table in the database. Call this first if you do not know the schema."),

        AIFunctionFactory.Create(
            (string table) =>
            {
                var result = Query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = $t",
                    ("$t", table));
                if (result.Rows.Count == 0) throw new InvalidOperationException($"No table named {table}.");
                return result.Rows[0]["sql"] as string ?? "";
            },
            "describe_table",
            "Show one table's CREATE TABLE statement, including its columns and foreign keys."),

        AIFunctionFactory.Create(
            (string sql) =>
            {
                AssertReadOnly(sql);
                QueryResult result;
                try
                {
                    result = Query(sql);
                }
                catch (SqliteException ex)
                {
                    // SQLite's message names the offending token, which is exactly
                    // what the model needs to fix the query on its next turn.
                    audit.Add((sql, "sql error"));
                    throw new InvalidOperationException($"SQLite rejected the query: {ex.Message}");
                }
                audit.Add((sql, $"{result.Rows.Count} row(s)"));

                // The card is emitted from inside the tool, so the client renders
                // the result the moment the query lands. It is also outside the
                // Redact policy's reach, so it is masked here by hand.
                Shuttle.Ui(ctx, "data-table", new Dictionary<string, object?>
                {
                    ["columns"] = result.Columns,
                    ["rows"] = MaskRows(result.Rows),
                    ["sql"] = sql,
                });

                // Returned as a dictionary, not a JSON string: Redact masks by
                // field name and walks nested rows, and it cannot see into a string.
                return new Dictionary<string, object?>
                {
                    ["columns"] = result.Columns,
                    ["rows"] = result.Rows.Cast<object?>().ToList(),
                };
            },
            "run_query",
            "Run one read-only SQL query (SELECT or WITH) against the SQLite database and return its rows."),
    };

    return MekikTools.Wrap(ctx, functions, new Dictionary<string, ToolPolicy>
    {
        // Schema plumbing: it runs, but the customer has no reason to watch us
        // enumerate table names.
        ["list_tables"] = new ToolPolicy { Show = false },
        ["describe_table"] = new ToolPolicy(),
        // The model reads real addresses; the surfaced params and rows do not
        // carry them. Masking is by field name, and it walks nested rows.
        ["run_query"] = new ToolPolicy { Redact = privateColumns },
    });
}

// ── who decides each turn ─────────────────────────────────────────────────────

// The real one calls Claude; `--probe` swaps in a fixed script so the graph, the
// tools and the wire can be exercised offline. Everything downstream is identical.
Func<IReadOnlyList<AIFunction>, List<ChatMessage>, int, Task<Dictionary<string, object?>>> decide = AskClaudeAsync;

IChatClient? chat = null;
// Built lazily so `--probe` never constructs the client, which would demand a key
// it does not need.
IChatClient Model() => chat ??= new AnthropicClient()
    .AsIChatClient("claude-opus-4-8", defaultMaxOutputTokens: 2048);

async Task<Dictionary<string, object?>> AskClaudeAsync(
    IReadOnlyList<AIFunction> tools, List<ChatMessage> messages, int turn)
{
    var response = await Model().GetResponseAsync(messages, new ChatOptions { Tools = [.. tools] });
    var calls = response.Messages
        .SelectMany(m => m.Contents)
        .OfType<FunctionCallContent>()
        .Select(c => (object?)new Dictionary<string, object?>
        {
            ["id"] = c.CallId,
            ["name"] = c.Name,
            ["args"] = c.Arguments is null
                ? new Dictionary<string, object?>()
                : new Dictionary<string, object?>(c.Arguments),
        })
        .ToList();
    return new Dictionary<string, object?> { ["text"] = response.Text, ["calls"] = calls };
}

// ── the graph ─────────────────────────────────────────────────────────────────

var analyst = Graph.Create("sql-analyst")
    .Channel("input", Channels.LastWrite(""))
    .Channel("reply", Channels.LastWrite(""))
    .Node("analyst", async (State state, IContext ctx) =>
    {
        var tools = MakeSqlTools(ctx);
        var byName = tools.ToDictionary(t => t.Name);
        var messages = new List<ChatMessage>
        {
            new(ChatRole.System, System),
            new(ChatRole.User, state.Get<string>("input")),
        };

        for (var turn = 0; turn < MaxTurns; turn++)
        {
            // The model call is journaled too. Without this the resume pass after
            // an interrupt would re-ask the same question — paying for it again
            // and possibly getting different calls, which would desync the
            // replayed step keys.
            var decision = await ctx.StepAsync($"llm:{turn}", () => decide(tools, messages, turn));

            var text = decision.GetValueOrDefault("text") as string ?? "";
            var calls = ((IEnumerable<object?>)(decision.GetValueOrDefault("calls") ?? new List<object?>()))
                .OfType<IReadOnlyDictionary<string, object?>>()
                .ToList();

            // Rebuild the assistant turn from the journal, so the replay pass
            // presents the model with exactly the history the first pass did.
            var contents = new List<AIContent>();
            if (!string.IsNullOrEmpty(text)) contents.Add(new TextContent(text));
            foreach (var call in calls)
            {
                contents.Add(new FunctionCallContent(
                    (string)call["id"]!, (string)call["name"]!, ToArgs(call.GetValueOrDefault("args"))));
            }
            messages.Add(new ChatMessage(ChatRole.Assistant, contents));

            if (calls.Count == 0)
            {
                return Update.Of("reply", string.IsNullOrEmpty(text) ? "(no reply)" : text);
            }

            foreach (var call in calls)
            {
                var callId = (string)call["id"]!;
                var name = (string)call["name"]!;
                object? observation;
                try
                {
                    observation = byName.TryGetValue(name, out var fn)
                        ? await fn.InvokeAsync(new AIFunctionArguments(ToArgs(call.GetValueOrDefault("args"))))
                        : $"Unknown tool {name}.";
                }
                catch (InterruptSignalException)
                {
                    throw; // a pause is not a failure
                }
                catch (Exception ex)
                {
                    // The wrapper has already surfaced a `tool_call` error frame.
                    // Handing the message back as an observation is what lets the
                    // model fix its own query instead of the whole node dying.
                    observation = $"Error: {ex.Message}";
                }
                messages.Add(new ChatMessage(ChatRole.Tool, new List<AIContent>
                {
                    new FunctionResultContent(callId, observation),
                }));
            }
        }

        return Update.Of("reply", "I ran out of steps before I could answer that.");
    })
    .Edge(Graph.Start, "analyst")
    .Edge("analyst", Graph.End)
    .Compile();

var app = new MekikApp(new MekikOptions
{
    Graph = analyst,
    Input = f => Update.Of("input", ((IReadOnlyDictionary<string, object?>)f["data"]!)["text"]),
    Reply = s => s.GetValueOrDefault("reply") as string,
    Greeting = _ => "Shop analytics. Ask me anything about customers, orders or revenue — I'll find the schema myself.",
});

return args.Contains("--probe") ? await Probe() : await Run();

// ── the three scenarios, against the real API ─────────────────────────────────

async Task<int> Run()
{
    if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY")))
    {
        Console.Error.WriteLine("Set ANTHROPIC_API_KEY — this example calls the real Claude API (or pass --probe).");
        return 1;
    }

    var c = new Collector();
    await app.ConnectAsync(c);
    c.Drain();

    var asks = new (string Title, string Ask, string Expect)[]
    {
        ("1. discovery — the model finds the schema and writes its own SQL",
         "Which three customers have spent the most in total? Show the amounts in dollars.",
         "at least one run_query, and a data-table card"),
        ("2. redaction — the model sees emails, the wire does not",
         "Who placed ORD-3, and what is their email address?",
         "an email in the reply, «redacted» in the trace"),
        ("3. correction — a write is refused and the model recovers",
         "Please delete order ORD-4 from the database.",
         "a tool_call error frame, then a normal reply"),
    };

    foreach (var (title, ask, expect) in asks)
    {
        Console.WriteLine($"\n{title}");
        Console.WriteLine($"   user: {ask}");
        Console.WriteLine($"   expecting: {expect}");
        await app.ReceiveAsync(c, Text(ask));
        Describe(c.Drain());
    }

    Console.WriteLine("\nSQL the model actually ran:");
    foreach (var (sql, outcome) in audit) Console.WriteLine($"  {outcome,-12} {Truncate(Collapse(sql))}");
    return 0;
}

// ── probe: the same graph, offline ────────────────────────────────────────────

async Task<int> Probe()
{
    // One script per scenario. `turn` restarts at 0 for every user message,
    // because each message is a fresh run of the node.
    var script = new List<Dictionary<string, object?>>();
    decide = (_, _, turn) => Task.FromResult(turn < script.Count
        ? script[turn]
        : Say("(script exhausted)"));

    var c = new Collector();
    await app.ConnectAsync(c);
    c.Drain();

    // 1. discovery
    script.Clear();
    script.AddRange([
        Call("list_tables", new Dictionary<string, object?>()),
        Call("describe_table", new Dictionary<string, object?> { ["table"] = "order_items" }),
        Call("run_query", new Dictionary<string, object?>
        {
            ["sql"] = "SELECT c.name, SUM(i.qty * i.unit_price_cents) / 100.0 AS dollars " +
                      "FROM customers c JOIN orders o ON o.customer_id = c.id " +
                      "JOIN order_items i ON i.order_id = o.id GROUP BY c.id ORDER BY dollars DESC LIMIT 3",
        }),
        Say("Ada, Grace and Alan are your top spenders."),
    ]);
    Console.WriteLine("\n1. discovery — schema lookup, query, GenUI card");
    await app.ReceiveAsync(c, Text("Which three customers have spent the most in total?"));
    var t1 = c.Drain();
    Describe(t1);

    Check(!t1.Any(f => f["type"] as string == "tool_call" && Field(f, "name") == "list_tables"),
        "list_tables is never traced (Show = false)");
    var card = t1.FirstOrDefault(f => f["type"] as string == "genui"
        && ((IReadOnlyDictionary<string, object?>)f["chunk"]!).GetValueOrDefault("component") as string == "data-table");
    Check(card is not null, "the query renders a data-table card");
    var props = (IReadOnlyDictionary<string, object?>)((IReadOnlyDictionary<string, object?>)card!["chunk"]!)["props"]!;
    var cardRows = (IEnumerable<object?>)props["rows"]!;
    Check(cardRows.Count() == 3, $"the card carries 3 rows (got {cardRows.Count()})");

    // 2. redaction
    script.Clear();
    script.AddRange([
        Call("run_query", new Dictionary<string, object?>
        {
            ["sql"] = "SELECT c.name, c.email FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.id = 'ORD-3'",
        }),
        Say("ORD-3 was placed by Grace Hopper."),
    ]);
    Console.WriteLine("\n2. redaction — the model sees the email, the wire does not");
    await app.ReceiveAsync(c, Text("Who placed ORD-3, and what is their email?"));
    var t2 = c.Drain();
    Describe(t2);

    var wire = JsonSerializer.Serialize(t2.Where(f => f["type"] as string == "tool_call"));
    Check(wire.Contains("redacted", StringComparison.Ordinal), "the email is masked on the wire");
    Check(!wire.Contains("grace@example.com", StringComparison.Ordinal),
        "the real address never reaches the client");
    var cardWire = JsonSerializer.Serialize(t2.Where(f => f["type"] as string == "genui"));
    Check(!cardWire.Contains("grace@example.com", StringComparison.Ordinal),
        "the GenUI card does not carry the address either");

    // 3. correction
    script.Clear();
    script.AddRange([
        Call("run_query", new Dictionary<string, object?> { ["sql"] = "DELETE FROM orders WHERE id = 'ORD-4'" }),
        Say("I can only read from this database, so I cannot delete that order."),
    ]);
    Console.WriteLine("\n3. correction — the write is refused and the turn survives");
    await app.ReceiveAsync(c, Text("Please delete order ORD-4."));
    var t3 = c.Drain();
    Describe(t3);

    Check(t3.Any(f => f["type"] as string == "tool_call" && Field(f, "status") == "error"),
        "the refused write surfaces as a tool_call error frame");
    Check(t3.Any(f => f["type"] as string == "text" && f.GetValueOrDefault("from") as string == "bot"),
        "the turn still produces a reply instead of crashing");
    Check(t3.Any(f => f["type"] as string == "run" && Field(f, "status") == "finished"),
        "the run finishes cleanly after the tool error");
    Check(Query("SELECT COUNT(*) AS n FROM orders WHERE id = 'ORD-4'").Rows[0]["n"] is 1L,
        "ORD-4 is still in the database — the guard ran before SQLite did");

    Console.WriteLine("\nSQL the script ran:");
    foreach (var (sql, outcome) in audit) Console.WriteLine($"  {outcome,-12} {Truncate(Collapse(sql))}");

    Console.WriteLine("\n✅ probe passed — hidden tool, GenUI table, masking, and error recovery all verified offline");
    return 0;
}

// ── SQLite plumbing ───────────────────────────────────────────────────────────

void Execute(string sql)
{
    using var cmd = conn.CreateCommand();
    cmd.CommandText = sql;
    cmd.ExecuteNonQuery();
}

QueryResult Query(string sql, params (string Name, object? Value)[] parameters)
{
    using var cmd = conn.CreateCommand();
    cmd.CommandText = sql;
    foreach (var (name, value) in parameters) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);

    using var reader = cmd.ExecuteReader();
    var columns = new List<object?>();
    for (var i = 0; i < reader.FieldCount; i++) columns.Add(reader.GetName(i));

    var rows = new List<Dictionary<string, object?>>();
    while (reader.Read())
    {
        var row = new Dictionary<string, object?>();
        for (var i = 0; i < reader.FieldCount; i++)
        {
            row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
        }
        rows.Add(row);
    }
    return new QueryResult(columns, rows);
}

/// <summary>Anything that is not a single read is refused before it reaches SQLite.</summary>
static void AssertReadOnly(string sql)
{
    var trimmed = sql.Trim().TrimEnd(';').Trim();
    if (trimmed.Contains(';', StringComparison.Ordinal))
    {
        throw new InvalidOperationException("Only a single statement is allowed — remove the ';' and send one query.");
    }
    var verb = trimmed.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "that";
    if (!verb.Equals("SELECT", StringComparison.OrdinalIgnoreCase)
        && !verb.Equals("WITH", StringComparison.OrdinalIgnoreCase))
    {
        throw new InvalidOperationException(
            $"This connection is read-only, so {verb.ToUpperInvariant()} is refused. " +
            "You can SELECT to inspect data, but not modify it.");
    }
}

List<object?> MaskRows(List<Dictionary<string, object?>> rows) => rows
    .Select(row =>
    {
        var copy = new Dictionary<string, object?>(row);
        foreach (var col in privateColumns) if (copy.ContainsKey(col)) copy[col] = MekikTools.Redacted;
        return (object?)copy;
    })
    .ToList();

// ── console helpers ───────────────────────────────────────────────────────────

void Describe(List<IReadOnlyDictionary<string, object?>> frames)
{
    foreach (var f in frames)
    {
        var type = f["type"] as string;
        var data = f.GetValueOrDefault("data") as IReadOnlyDictionary<string, object?>;
        if (type == "tool_call" && data is not null)
        {
            var status = data.GetValueOrDefault("status") as string;
            var name = data.GetValueOrDefault("name");
            if (status == "running") Console.WriteLine($"  → {name} {Truncate(Json(data.GetValueOrDefault("params")))}");
            else if (status == "error") Console.WriteLine($"  ✗ {name} error: {data.GetValueOrDefault("error")}");
            else Console.WriteLine($"  ← {name} {Truncate(Json(data.GetValueOrDefault("result")))}");
        }
        else if (type == "genui" && f.GetValueOrDefault("chunk") is IReadOnlyDictionary<string, object?> chunk
                 && chunk.GetValueOrDefault("component") is string component)
        {
            var p = chunk.GetValueOrDefault("props") as IReadOnlyDictionary<string, object?>;
            var rowCount = (p?.GetValueOrDefault("rows") as IEnumerable<object?>)?.Count() ?? 0;
            Console.WriteLine($"  ▦ {component}: {rowCount} row(s)");
        }
        else if (type == "text" && f.GetValueOrDefault("from") as string == "bot" && data is not null)
        {
            Console.WriteLine($"  bot: {data.GetValueOrDefault("text")}");
        }
        else if (type == "error" && data is not null)
        {
            Console.WriteLine($"  error {data.GetValueOrDefault("code")}: {data.GetValueOrDefault("message")}");
        }
    }
}

static string Json(object? value) => JsonSerializer.Serialize(value);

static string Collapse(string s) => string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

static string Truncate(string s, int max = 160) => s.Length > max ? s[..max] + "…" : s;

static void Check(bool cond, string msg)
{
    if (!cond) throw new InvalidOperationException($"assertion failed: {msg}");
    Console.WriteLine($"     ✓ {msg}");
}

static Dictionary<string, object?> ToArgs(object? value) =>
    value is IReadOnlyDictionary<string, object?> d ? new Dictionary<string, object?>(d) : [];

static Dictionary<string, object?> Text(string text) => new()
{
    ["type"] = "text",
    ["data"] = new Dictionary<string, object?> { ["text"] = text },
};

static string? Field(IReadOnlyDictionary<string, object?> frame, string key) =>
    (frame.GetValueOrDefault("data") as IReadOnlyDictionary<string, object?>)?.GetValueOrDefault(key) as string;

/// <summary>A scripted stand-in for one model turn.</summary>
static Dictionary<string, object?> Say(string text) =>
    new() { ["text"] = text, ["calls"] = new List<object?>() };

static Dictionary<string, object?> Call(string name, Dictionary<string, object?> args) => new()
{
    ["text"] = "",
    ["calls"] = new List<object?>
    {
        new Dictionary<string, object?> { ["id"] = $"call-{name}", ["name"] = name, ["args"] = args },
    },
};

internal sealed record QueryResult(List<object?> Columns, List<Dictionary<string, object?>> Rows);

internal sealed class Collector : IConnection
{
    public string Id => "conn-sql";
    private readonly List<IReadOnlyDictionary<string, object?>> _frames = new();
    public void Send(IReadOnlyDictionary<string, object?> frame) => _frames.Add(frame);
    public void Close(int? code = null, string? reason = null) { }
    public List<IReadOnlyDictionary<string, object?>> Drain()
    {
        var copy = _frames.ToList();
        _frames.Clear();
        return copy;
    }
}
