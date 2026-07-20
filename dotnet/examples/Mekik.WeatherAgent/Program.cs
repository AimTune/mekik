// The .NET mirror of ts/examples/weather-agent.ts: a travel-weather desk that
// talks to a real public API (Open-Meteo — no key, no account). Where the SQL
// agent shows a model exploring a local database, this one shows the shape most
// agents actually have: two chained network tools, several calls in a single
// turn, and a remote service that sometimes has no answer.
//
//   1. chaining — geocode_city → get_forecast, and the forecast renders as a
//                 `weather-card`; the model carries coordinates between two tools
//   2. fan-out  — "compare Istanbul and Berlin" produces several tool calls in ONE
//                 assistant turn, each traced separately on the wire
//   3. silent   — an unknown place fails inside the HIDDEN tool. The model
//                 recovers, but the client sees no error frame at all: Show=false
//                 hides a tool's failures as well as its successes
//   4. visible  — the shown tool fails instead, so the same recovery this time
//                 surfaces as a `tool_call` error frame the UI can render
//
//   ANTHROPIC_API_KEY=sk-ant-… dotnet run --project dotnet/examples/Mekik.WeatherAgent
//   dotnet run --project dotnet/examples/Mekik.WeatherAgent -- --probe  # no key, no network
//
// `--probe` swaps out exactly two things — the model's decisions and the HTTP
// layer — and runs the identical graph, tools and wire path. CI runs it.

using System.Globalization;
using System.Text.Json;

using Anthropic;
using Microsoft.Extensions.AI;

using Ilmek;
using Mekik;
using Mekik.Agents;

// ── the HTTP layer (swappable, so the probe never touches the network) ────────

var http = new HttpClient();

async Task<JsonElement> LiveFetchAsync(string url)
{
    using var res = await http.GetAsync(url);
    if (!res.IsSuccessStatusCode)
    {
        throw new InvalidOperationException($"{new Uri(url).Host} replied {(int)res.StatusCode} {res.ReasonPhrase}");
    }
    using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
    return doc.RootElement.Clone();
}

Func<string, Task<JsonElement>> fetchJson = LiveFetchAsync;

// Every request the run made, so the summary reports what happened rather than
// what we hoped.
var calls = new List<string>();

// ── the tools ─────────────────────────────────────────────────────────────────

var wmo = new Dictionary<int, string>
{
    [0] = "clear", [1] = "mainly clear", [2] = "partly cloudy", [3] = "overcast",
    [45] = "fog", [48] = "rime fog", [51] = "light drizzle", [53] = "drizzle", [55] = "heavy drizzle",
    [61] = "light rain", [63] = "rain", [65] = "heavy rain", [71] = "light snow", [73] = "snow",
    [75] = "heavy snow", [80] = "rain showers", [81] = "rain showers", [82] = "violent rain showers",
    [95] = "thunderstorm",
};

const string System = "You are a travel-weather assistant. " +
    "get_forecast needs coordinates, so resolve every place with geocode_city first. " +
    "When the user names several places, look them all up — you may call tools more than once in a turn. " +
    "If a place cannot be resolved, say so and ask for a clearer name; do not guess coordinates. " +
    "Temperatures are Celsius. Answer in one or two short sentences; the daily rows are already shown as cards.";

const int MaxTurns = 8;

IReadOnlyList<AIFunction> MakeWeatherTools(IContext ctx)
{
    var functions = new List<AIFunction>
    {
        AIFunctionFactory.Create(
            async (string city) =>
            {
                var url = "https://geocoding-api.open-meteo.com/v1/search?name="
                    + Uri.EscapeDataString(city) + "&count=1&language=en&format=json";
                calls.Add($"geocode {city}");
                var body = await fetchJson(url);
                if (!body.TryGetProperty("results", out var results)
                    || results.ValueKind != JsonValueKind.Array
                    || results.GetArrayLength() == 0)
                {
                    // Thrown, not returned, so the agent loop hands the message
                    // back to the model and it can ask for a better name. Note
                    // this tool is Show=false, so the failure never reaches the
                    // client — see scenario 3.
                    throw new InvalidOperationException(
                        $"No place called \"{city}\". Try a city name, optionally with its country.");
                }
                var hit = results[0];
                return new Dictionary<string, object?>
                {
                    ["name"] = hit.GetProperty("name").GetString(),
                    ["country"] = hit.TryGetProperty("country", out var c) ? c.GetString() : null,
                    ["latitude"] = hit.GetProperty("latitude").GetDouble(),
                    ["longitude"] = hit.GetProperty("longitude").GetDouble(),
                };
            },
            "geocode_city",
            "Resolve a place name to coordinates. Call this before get_forecast — it needs lat/lon."),

        AIFunctionFactory.Create(
            async (string label, double latitude, double longitude, int? days) =>
            {
                var span = Math.Clamp(days ?? 3, 1, 7);
                var url = "https://api.open-meteo.com/v1/forecast"
                    + $"?latitude={latitude.ToString(CultureInfo.InvariantCulture)}"
                    + $"&longitude={longitude.ToString(CultureInfo.InvariantCulture)}"
                    + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum"
                    + $"&forecast_days={span}&timezone=auto";
                calls.Add($"forecast {label} ({span}d)");

                var body = await fetchJson(url);
                if (!body.TryGetProperty("daily", out var daily)
                    || !daily.TryGetProperty("time", out var time)
                    || time.ValueKind != JsonValueKind.Array
                    || time.GetArrayLength() == 0)
                {
                    throw new InvalidOperationException("The forecast service returned no daily data.");
                }

                var rows = new List<object?>();
                for (var i = 0; i < time.GetArrayLength(); i++)
                {
                    var code = ReadInt(daily, "weather_code", i);
                    rows.Add(new Dictionary<string, object?>
                    {
                        ["date"] = time[i].GetString(),
                        ["summary"] = code is int k && wmo.TryGetValue(k, out var s) ? s : "unknown",
                        ["high"] = ReadDouble(daily, "temperature_2m_max", i),
                        ["low"] = ReadDouble(daily, "temperature_2m_min", i),
                        ["precipitationMm"] = ReadDouble(daily, "precipitation_sum", i),
                    });
                }

                // One card per place, emitted the moment the data lands rather
                // than after the model has finished writing its comparison.
                Shuttle.Ui(ctx, "weather-card", new Dictionary<string, object?>
                {
                    ["place"] = label,
                    ["days"] = rows,
                });

                return new Dictionary<string, object?> { ["place"] = label, ["days"] = rows };
            },
            "get_forecast",
            "Get a daily forecast for one set of coordinates. Temperatures are Celsius."),
    };

    return MekikTools.Wrap(ctx, functions, new Dictionary<string, ToolPolicy>
    {
        // Coordinate lookup is plumbing the traveller has no reason to watch.
        ["geocode_city"] = new ToolPolicy { Show = false },
        ["get_forecast"] = new ToolPolicy(),
    });
}

static int? ReadInt(JsonElement daily, string name, int i) =>
    daily.TryGetProperty(name, out var arr) && arr.ValueKind == JsonValueKind.Array && i < arr.GetArrayLength()
        ? arr[i].GetInt32()
        : null;

static double? ReadDouble(JsonElement daily, string name, int i) =>
    daily.TryGetProperty(name, out var arr) && arr.ValueKind == JsonValueKind.Array && i < arr.GetArrayLength()
        ? arr[i].GetDouble()
        : null;

// ── who decides each turn ─────────────────────────────────────────────────────

// Built lazily so `--probe` never constructs the client, which would demand a key
// it does not need. Declared before `decide` below: a local function that captures
// it cannot be assigned to a delegate before the capture is definitely assigned.
var chat = new Lazy<IChatClient>(() => new AnthropicClient()
    .AsIChatClient("claude-opus-4-8", defaultMaxOutputTokens: 2048));

async Task<Dictionary<string, object?>> AskClaudeAsync(
    IReadOnlyList<AIFunction> tools, List<ChatMessage> messages, int turn)
{
    var response = await chat.Value.GetResponseAsync(messages, new ChatOptions { Tools = [.. tools] });
    var toolCalls = response.Messages
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
    return new Dictionary<string, object?> { ["text"] = response.Text, ["calls"] = toolCalls };
}

Func<IReadOnlyList<AIFunction>, List<ChatMessage>, int, Task<Dictionary<string, object?>>> decide = AskClaudeAsync;

// ── the graph ─────────────────────────────────────────────────────────────────

var desk = Graph.Create("weather-desk")
    .Channel("input", Channels.LastWrite(""))
    .Channel("reply", Channels.LastWrite(""))
    .Node("desk", async (State state, IContext ctx) =>
    {
        var tools = MakeWeatherTools(ctx);
        var byName = tools.ToDictionary(t => t.Name);
        var messages = new List<ChatMessage>
        {
            new(ChatRole.System, System),
            new(ChatRole.User, state.Get<string>("input")),
        };

        for (var turn = 0; turn < MaxTurns; turn++)
        {
            var decision = await ctx.StepAsync(
                $"llm:{turn}",
                () => new ValueTask<Dictionary<string, object?>>(decide(tools, messages, turn)));

            var text = decision.GetValueOrDefault("text") as string ?? "";
            var toolCalls = ((IEnumerable<object?>)(decision.GetValueOrDefault("calls") ?? new List<object?>()))
                .OfType<IReadOnlyDictionary<string, object?>>()
                .ToList();

            var contents = new List<AIContent>();
            if (!string.IsNullOrEmpty(text)) contents.Add(new TextContent(text));
            foreach (var call in toolCalls)
            {
                contents.Add(new FunctionCallContent(
                    (string)call["id"]!, (string)call["name"]!, ToArgs(call.GetValueOrDefault("args"))));
            }
            messages.Add(new ChatMessage(ChatRole.Assistant, contents));

            if (toolCalls.Count == 0)
            {
                return Update.Of("reply", string.IsNullOrEmpty(text) ? "(no reply)" : text);
            }

            // Several calls can arrive in one turn (scenario 2). They are run in
            // order so each gets its own journal key and its own pair of frames.
            foreach (var call in toolCalls)
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
    .Edge(Graph.Start, "desk")
    .Edge("desk", Graph.End)
    .Compile();

var app = new MekikApp(new MekikOptions
{
    Graph = desk,
    Input = f => Update.Of("input", ((IReadOnlyDictionary<string, object?>)f["data"]!)["text"]),
    Reply = s => s.GetValueOrDefault("reply") as string,
    Greeting = _ => "Travel weather. Name any city — or a few — and I'll pull the forecast.",
});

return args.Contains("--probe") ? await Probe() : await Run();

// ── the scenarios, against the real API ───────────────────────────────────────

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

    var asks = new (string Title, string Ask)[]
    {
        ("1. chaining — coordinates from one tool feed the next",
         "What's the weather in Istanbul for the next three days?"),
        ("2. fan-out — several tool calls in one assistant turn",
         "Compare Istanbul and Berlin this week — which one should I pack a coat for?"),
        ("3. silent — a hidden tool fails, so the client sees nothing",
         "And what about the weather in Wakanda?"),
        ("4. visible — the shown tool fails, so the UI can render it",
         "Try Bouvet Island then."),
    };

    foreach (var (title, ask) in asks)
    {
        Console.WriteLine($"\n{title}");
        Console.WriteLine($"   user: {ask}");
        await app.ReceiveAsync(c, Text(ask));
        Describe(c.Drain());
    }

    Console.WriteLine("\nrequests made:");
    foreach (var call in calls) Console.WriteLine($"  {call}");
    return 0;
}

// ── probe: the same graph, offline ────────────────────────────────────────────

async Task<int> Probe()
{
    var fixtures = new (string Match, string Body)[]
    {
        ("name=Istanbul",
         """{"results":[{"name":"Istanbul","country":"Türkiye","latitude":41.0138,"longitude":28.9497}]}"""),
        ("name=Berlin",
         """{"results":[{"name":"Berlin","country":"Germany","latitude":52.5244,"longitude":13.4105}]}"""),
        // The service answers, with nothing in it.
        ("name=Wakanda", "{}"),
        // Resolves fine, but the forecast service has nothing for it — so the
        // failure lands in the *shown* tool instead of the hidden one.
        ("name=Bouvet",
         """{"results":[{"name":"Bouvet Island","country":"Norway","latitude":-54.42,"longitude":3.36}]}"""),
        ("latitude=41.0138", """{"daily":{"time":["2026-07-21","2026-07-22","2026-07-23"],"weather_code":[0,2,61],"temperature_2m_max":[31.4,30.1,26.8],"temperature_2m_min":[23.0,22.4,20.9],"precipitation_sum":[0,0,4.2]}}"""),
        ("latitude=52.5244", """{"daily":{"time":["2026-07-21","2026-07-22","2026-07-23"],"weather_code":[3,63,61],"temperature_2m_max":[19.2,17.5,18.1],"temperature_2m_min":[12.4,11.8,12.0],"precipitation_sum":[1.1,8.6,3.3]}}"""),
        ("latitude=-54.42", "{}"),
    };

    fetchJson = url =>
    {
        foreach (var (match, body) in fixtures)
        {
            if (url.Contains(match, StringComparison.Ordinal))
            {
                using var doc = JsonDocument.Parse(body);
                return Task.FromResult(doc.RootElement.Clone());
            }
        }
        throw new InvalidOperationException($"probe has no fixture for {url}");
    };

    // One script per scenario. `turn` restarts at 0 for every user message,
    // because each message is a fresh run of the node.
    var script = new List<Dictionary<string, object?>>();
    decide = (_, _, turn) => Task.FromResult(turn < script.Count ? script[turn] : Say("(script exhausted)"));

    var istanbul = new Dictionary<string, object?>
    { ["label"] = "Istanbul", ["latitude"] = 41.0138, ["longitude"] = 28.9497, ["days"] = 3 };
    var berlin = new Dictionary<string, object?>
    { ["label"] = "Berlin", ["latitude"] = 52.5244, ["longitude"] = 13.4105, ["days"] = 3 };

    var c = new Collector();
    await app.ConnectAsync(c);
    c.Drain();

    // 1. chaining
    script.Clear();
    script.AddRange([
        Call(("geocode_city", new Dictionary<string, object?> { ["city"] = "Istanbul" })),
        Call(("get_forecast", istanbul)),
        Say("Warm and clear in Istanbul, with a little rain on Thursday."),
    ]);
    Console.WriteLine("\n1. chaining — coordinates from one tool feed the next");
    await app.ReceiveAsync(c, Text("What's the weather in Istanbul for the next three days?"));
    var t1 = c.Drain();
    Describe(t1);
    Check(!Traced(t1).Any(f => Field(f, "name") == "geocode_city"), "geocode_city stays off the wire (Show = false)");
    Check(Cards(t1).Count == 1, $"one weather-card (got {Cards(t1).Count})");
    Check(Traced(t1).Count(f => Field(f, "status") == "completed") == 1, "the forecast is traced exactly once");

    // 2. fan-out
    script.Clear();
    script.AddRange([
        // Both places resolved in a single turn — this is the shape a model
        // produces when the question names more than one thing.
        Call(("geocode_city", new Dictionary<string, object?> { ["city"] = "Istanbul" }),
             ("geocode_city", new Dictionary<string, object?> { ["city"] = "Berlin" })),
        Call(("get_forecast", istanbul), ("get_forecast", berlin)),
        Say("Istanbul is about 12°C warmer; pack the coat for Berlin."),
    ]);
    Console.WriteLine("\n2. fan-out — several tool calls in one assistant turn");
    await app.ReceiveAsync(c, Text("Compare Istanbul and Berlin this week."));
    var t2 = c.Drain();
    Describe(t2);
    Check(Cards(t2).Count == 2, $"one card per city (got {Cards(t2).Count})");
    var places = Cards(t2)
        .Select(f => (((IReadOnlyDictionary<string, object?>)f["chunk"]!)["props"] as IReadOnlyDictionary<string, object?>)
            ?.GetValueOrDefault("place") as string)
        .ToList();
    Check(places.Contains("Istanbul") && places.Contains("Berlin"),
        $"both cities rendered (got {string.Join(", ", places)})");
    var running = Traced(t2).Where(f => Field(f, "status") == "running").ToList();
    Check(running.Count == 2, $"two traced forecasts in one turn (got {running.Count})");
    Check(running.Select(f => Field(f, "id")).Distinct().Count() == 2, "each call gets its own tool-call id");

    // 3. silent
    script.Clear();
    script.AddRange([
        Call(("geocode_city", new Dictionary<string, object?> { ["city"] = "Wakanda" })),
        Say("I couldn't find a place called Wakanda — could you give me a real city name?"),
    ]);
    Console.WriteLine("\n3. silent — a hidden tool fails, so the client sees nothing");
    await app.ReceiveAsync(c, Text("And what about the weather in Wakanda?"));
    var t3 = c.Drain();
    Describe(t3);
    Check(Cards(t3).Count == 0, "no card is rendered for a place that does not resolve");
    // The cost of Show=false, stated as an assertion so it cannot quietly stop
    // being true: a hidden tool's failure is hidden too.
    Check(Traced(t3).Count == 0, "a hidden tool's failure produces NO frame — the UI cannot show it");
    Check(t3.Any(f => f["type"] as string == "text" && f.GetValueOrDefault("from") as string == "bot"),
        "the model still recovers and replies");
    Check(t3.Any(f => f["type"] as string == "run" && Field(f, "status") == "finished"),
        "the run finishes cleanly after the failed lookup");

    // 4. visible
    script.Clear();
    script.AddRange([
        Call(("geocode_city", new Dictionary<string, object?> { ["city"] = "Bouvet Island" })),
        Call(("get_forecast", new Dictionary<string, object?>
        { ["label"] = "Bouvet Island", ["latitude"] = -54.42, ["longitude"] = 3.36, ["days"] = 3 })),
        Say("The forecast service has no data for Bouvet Island — it is a bit off the map."),
    ]);
    Console.WriteLine("\n4. visible — the shown tool fails, so the UI can render it");
    await app.ReceiveAsync(c, Text("Try Bouvet Island then."));
    var t4 = c.Drain();
    Describe(t4);
    Check(Traced(t4).Any(f => Field(f, "status") == "error"),
        "the shown tool's failure DOES surface as a tool_call error frame");
    Check(Cards(t4).Count == 0, "no card is rendered when the forecast has no data");
    Check(t4.Any(f => f["type"] as string == "text" && f.GetValueOrDefault("from") as string == "bot"),
        "the model explains the failure instead of the node crashing");

    Console.WriteLine("\nrequests the script made:");
    foreach (var call in calls) Console.WriteLine($"  {call}");

    Console.WriteLine("\n✅ probe passed — chaining, fan-out, hidden tool and recovery all verified offline");
    return 0;
}

// ── console helpers ───────────────────────────────────────────────────────────

static List<IReadOnlyDictionary<string, object?>> Traced(List<IReadOnlyDictionary<string, object?>> frames) =>
    frames.Where(f => f["type"] as string == "tool_call").ToList();

static List<IReadOnlyDictionary<string, object?>> Cards(List<IReadOnlyDictionary<string, object?>> frames) =>
    frames.Where(f => f["type"] as string == "genui"
        && (f.GetValueOrDefault("chunk") as IReadOnlyDictionary<string, object?>)
            ?.GetValueOrDefault("component") as string == "weather-card").ToList();

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
            var dayCount = (p?.GetValueOrDefault("days") as IEnumerable<object?>)?.Count() ?? 0;
            Console.WriteLine($"  ▦ {component}: {p?.GetValueOrDefault("place")} — {dayCount} day(s)");
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

static Dictionary<string, object?> Call(params (string Name, Dictionary<string, object?> Args)[] pairs) => new()
{
    ["text"] = "",
    ["calls"] = pairs
        .Select((p, i) => (object?)new Dictionary<string, object?>
        {
            ["id"] = $"call-{p.Name}-{i}",
            ["name"] = p.Name,
            ["args"] = p.Args,
        })
        .ToList(),
};

internal sealed class Collector : IConnection
{
    public string Id => "conn-weather";
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
