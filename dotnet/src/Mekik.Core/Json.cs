using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Mekik;

/// <summary>
/// Canonical JSON (PROTOCOL.md §9) and a JSON→object reader — the two halves of
/// cross-language parity. `Canonicalize` produces the exact string the TypeScript
/// reference's `canonicalize` does: object keys sorted ascending, arrays in order,
/// no insignificant whitespace, non-ASCII written literally (matching
/// JSON.stringify, not .NET's default escaping). `Parse` turns a wire message into
/// the same nested `Dictionary`/`List`/primitive shape the mapper works on.
/// </summary>
public static class Json
{
    // UnsafeRelaxedJsonEscaping matches JSON.stringify: it leaves ₺, İ, <, >, &
    // as literal characters instead of \uXXXX, so the two languages' canonical
    // strings are byte-identical.
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Indented = false,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>Deterministic JSON for equality comparison. See class summary.</summary>
    public static string Canonicalize(object? value)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            Write(writer, value);
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// <summary>Compact (non-canonical) JSON for the wire — key order is irrelevant to a parser.</summary>
    public static string Serialize(object? value) => Canonicalize(value);

    private static void Write(Utf8JsonWriter w, object? value)
    {
        switch (value)
        {
            case null:
                w.WriteNullValue();
                break;
            case bool b:
                w.WriteBooleanValue(b);
                break;
            case string s:
                w.WriteStringValue(s);
                break;
            case int i:
                w.WriteNumberValue(i);
                break;
            case long l:
                w.WriteNumberValue(l);
                break;
            case double d:
                w.WriteNumberValue(d);
                break;
            case IReadOnlyDictionary<string, object?> dict:
                w.WriteStartObject();
                foreach (var key in dict.Keys.OrderBy(k => k, StringComparer.Ordinal))
                {
                    var v = dict[key];
                    // Drop nulls that stand in for "absent optional" so an omitted
                    // `ui` and an explicit-null `ui` canonicalize alike — matching
                    // JSON.stringify dropping `undefined`. Genuine null data is
                    // rare on this wire; the mapper never emits a meaningful null.
                    if (v is null) continue;
                    w.WritePropertyName(key);
                    Write(w, v);
                }
                w.WriteEndObject();
                break;
            case System.Collections.IEnumerable seq:
                w.WriteStartArray();
                foreach (var item in seq) Write(w, item);
                w.WriteEndArray();
                break;
            default:
                throw new InvalidOperationException(
                    $"cannot canonicalize a {value.GetType().Name}; frames must be built from " +
                    "dictionaries, lists, strings, numbers, booleans and null.");
        }
    }

    /// <summary>Parse a JSON string into nested Dictionary/List/string/long/double/bool/null.</summary>
    public static object? Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return FromElement(doc.RootElement);
    }

    /// <summary>Convert a <see cref="JsonElement"/> into the same object shape as <see cref="Parse"/>.</summary>
    public static object? FromElement(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.Object => el.EnumerateObject()
            .ToDictionary(p => p.Name, p => FromElement(p.Value)) as Dictionary<string, object?>,
        JsonValueKind.Array => el.EnumerateArray().Select(FromElement).ToList(),
        JsonValueKind.String => el.GetString(),
        // Integer JSON tokens become long, everything else double — so an integer
        // seq prints "7" and 249.9 prints "249.9", both matching JSON.stringify.
        JsonValueKind.Number => el.TryGetInt64(out var l) ? l : el.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => null,
    };
}
