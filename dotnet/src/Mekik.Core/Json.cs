using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Mekik;

/// <summary>
/// Canonical JSON (PROTOCOL.md §9) and a JSON→object reader — the two halves of
/// cross-language parity. `Canonicalize` produces the exact string the TypeScript
/// reference's `canonicalize` does (<c>JSON.stringify</c> over sorted keys): object
/// keys in JavaScript property order (array-index keys numerically, then the rest
/// sorted by UTF-16 code unit), arrays in order, no insignificant whitespace, strings
/// escaped exactly as <c>JSON.stringify</c> escapes them (quote, backslash and C0
/// controls only — every other character, emoji and U+2028/U+2029 included, is
/// written literally) and numbers in JavaScript's shortest round-trip form
/// (<c>1e+21</c>, <c>1e-7</c>). `Parse` turns a wire message into the same nested
/// `Dictionary`/`List`/primitive shape the mapper works on.
/// </summary>
public static class Json
{
    /// <summary>Deterministic JSON for equality comparison and hashing. See class summary.</summary>
    public static string Canonicalize(object? value)
    {
        var sb = new StringBuilder();
        Write(sb, value);
        return sb.ToString();
    }

    /// <summary>Compact (non-canonical) JSON for the wire — key order is irrelevant to a parser.</summary>
    public static string Serialize(object? value) => Canonicalize(value);

    private static void Write(StringBuilder sb, object? value)
    {
        switch (value)
        {
            case null:
                sb.Append("null");
                break;
            case bool b:
                sb.Append(b ? "true" : "false");
                break;
            case string s:
                WriteString(sb, s);
                break;
            case int i:
                sb.Append(i.ToString(CultureInfo.InvariantCulture));
                break;
            case long l:
                sb.Append(l.ToString(CultureInfo.InvariantCulture));
                break;
            case double d:
                sb.Append(NumberToString(d));
                break;
            case IReadOnlyDictionary<string, object?> dict:
                sb.Append('{');
                var first = true;
                foreach (var key in OrderKeys(dict.Keys))
                {
                    var v = dict[key];
                    // Drop nulls that stand in for "absent optional" so an omitted
                    // `ui` and an explicit-null `ui` canonicalize alike — matching
                    // JSON.stringify dropping `undefined`. Genuine null data is
                    // rare on this wire; the mapper never emits a meaningful null.
                    if (v is null) continue;
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, key);
                    sb.Append(':');
                    Write(sb, v);
                }
                sb.Append('}');
                break;
            case JsonElement je:
                // Values that came back through System.Text.Json — an
                // AIFunctionFactory tool result, a model's function-call arguments —
                // arrive as JsonElement. Fold them into the same plain shape the rest
                // of this writer emits, so a frame carrying one canonicalizes instead
                // of throwing on the real transport (a test double that skips
                // canonicalization would never notice).
                Write(sb, FromElement(je));
                break;
            case System.Collections.IEnumerable seq:
                sb.Append('[');
                var firstItem = true;
                foreach (var item in seq)
                {
                    if (!firstItem) sb.Append(',');
                    firstItem = false;
                    Write(sb, item);
                }
                sb.Append(']');
                break;
            default:
                throw new InvalidOperationException(
                    $"cannot canonicalize a {value.GetType().Name}; frames must be built from " +
                    "dictionaries, lists, strings, numbers, booleans and null.");
        }
    }

    /// <summary>
    /// JavaScript property order, which is what <c>JSON.stringify</c> emits: integer-like
    /// keys (canonical array indices) ascending numerically, then every other key in the
    /// order <c>Array.prototype.sort</c> leaves them — by UTF-16 code unit.
    /// </summary>
    private static IEnumerable<string> OrderKeys(IEnumerable<string> keys)
    {
        var all = keys.ToList();
        var indices = all.Where(IsArrayIndex).OrderBy(k => uint.Parse(k, CultureInfo.InvariantCulture));
        var rest = all.Where(k => !IsArrayIndex(k)).OrderBy(k => k, StringComparer.Ordinal);
        return indices.Concat(rest);
    }

    private static bool IsArrayIndex(string key)
    {
        if (key.Length == 0 || key.Length > 10) return false;
        if (key.Length > 1 && key[0] == '0') return false;
        foreach (var ch in key)
            if (ch is < '0' or > '9') return false;
        return uint.TryParse(key, NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n != uint.MaxValue;
    }

    /// <summary>The ECMAScript <c>QuoteJSONString</c> escaping (well-formed JSON.stringify).</summary>
    private static void WriteString(StringBuilder sb, string s)
    {
        sb.Append('"');
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20)
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
                    {
                        sb.Append(c).Append(s[i + 1]); // a well-formed pair is written as-is
                        i++;
                    }
                    else if (char.IsSurrogate(c))
                    {
                        // A lone surrogate is escaped, as well-formed JSON.stringify does.
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }
                    break;
            }
        }
        sb.Append('"');
    }

    /// <summary>
    /// ECMAScript <c>Number::toString</c>: the shortest digits that round-trip (which
    /// .NET's <c>"R"</c> already yields), laid out the JavaScript way — plain notation
    /// for exponents in [-7, 21), otherwise <c>d.ddde±n</c>. Non-finite numbers are
    /// <c>null</c>, as <c>JSON.stringify</c> writes them.
    /// </summary>
    internal static string NumberToString(double d)
    {
        if (double.IsNaN(d) || double.IsInfinity(d)) return "null";
        if (d == 0) return "0"; // -0 too
        var negative = d < 0;
        var r = Math.Abs(d).ToString("R", CultureInfo.InvariantCulture);

        // r is "ddd.ddd" or "d.dddE±xx": split into significant digits and exponent.
        var exp = 0;
        var e = r.IndexOfAny(['E', 'e']);
        var mantissa = r;
        if (e >= 0)
        {
            exp = int.Parse(r[(e + 1)..], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
            mantissa = r[..e];
        }
        var dot = mantissa.IndexOf('.');
        var intLen = dot < 0 ? mantissa.Length : dot;
        var digits = mantissa.Replace(".", "");
        var leadingZeros = 0;
        while (leadingZeros < digits.Length - 1 && digits[leadingZeros] == '0') leadingZeros++;
        digits = digits[leadingZeros..].TrimEnd('0');
        if (digits.Length == 0) return "0";
        // value = 0.digits × 10^n
        var n = intLen + exp - leadingZeros;
        var k = digits.Length;

        string body;
        if (k <= n && n <= 21) body = digits + new string('0', n - k);
        else if (0 < n && n <= 21) body = digits[..n] + "." + digits[n..];
        else if (-6 < n && n <= 0) body = "0." + new string('0', -n) + digits;
        else
        {
            var e10 = n - 1;
            var sign = e10 < 0 ? "-" : "+";
            body = (k == 1 ? digits : digits[..1] + "." + digits[1..]) + "e" + sign + Math.Abs(e10).ToString(CultureInfo.InvariantCulture);
        }
        return negative ? "-" + body : body;
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
