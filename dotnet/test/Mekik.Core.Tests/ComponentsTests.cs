using Mekik;

namespace Mekik.Tests;

/// <summary>
/// Server-defined GenUI components (PROTOCOL.md §10): the authoring forms, the
/// catalog and its hash.
///
/// <para>The hash is the cross-language contract — a client that cached a catalog
/// from the TypeScript server must get <c>unchanged</c> from the .NET one for the
/// same components. <see cref="Catalog_hash_matches_the_TypeScript_reference"/>
/// pins that against a value computed by the reference implementation.</para>
/// </summary>
public class ComponentsTests
{
    private static ComponentSpec OrderCardSpec => new()
    {
        Name = "order-card",
        Template = "<h3>{{title}}</h3><button data-event=\"track_order\">Track</button>",
        Css = ".card { padding: 12px; }",
        Props = new Dictionary<string, object?> { ["title"] = "" },
    };

    private sealed class OrderCard : GenUiComponent
    {
        public override string Name => "order-card";
        public override string Template => "<h3>{{title}}</h3><button data-event=\"track_order\">Track</button>";
        public override string? Css => ".card { padding: 12px; }";
        public override IReadOnlyDictionary<string, object?>? Props =>
            new Dictionary<string, object?> { ["title"] = "" };
    }

    [Fact]
    public void Spec_becomes_its_wire_definition()
    {
        var catalog = new ComponentCatalog([OrderCardSpec]);

        var def = Assert.Single(catalog.Definitions);
        Assert.Equal("order-card", def["name"]);
        Assert.Equal(".card { padding: 12px; }", def["css"]);
        Assert.Equal(new[] { "css", "name", "props", "template" }, def.Keys.OrderBy(k => k, StringComparer.Ordinal));
    }

    [Fact]
    public void Absent_optional_fields_are_omitted_not_null()
    {
        var catalog = new ComponentCatalog([new ComponentSpec { Name = "bare", Template = "<p>x</p>" }]);

        var def = Assert.Single(catalog.Definitions);
        Assert.Equal(new[] { "name", "template" }, def.Keys.OrderBy(k => k, StringComparer.Ordinal));
    }

    [Fact]
    public void Class_instance_and_type_produce_the_same_definition()
    {
        var fromInstance = new ComponentCatalog([new OrderCard()]);
        var fromType = new ComponentCatalog([typeof(OrderCard)]);

        Assert.Equal(fromInstance.Hash, fromType.Hash);
    }

    [Fact]
    public void A_class_and_an_equivalent_spec_hash_alike()
    {
        Assert.Equal(new ComponentCatalog([OrderCardSpec]).Hash, new ComponentCatalog([new OrderCard()]).Hash);
    }

    [Fact]
    public void Empty_catalog_has_no_hash()
    {
        var catalog = new ComponentCatalog();

        Assert.True(catalog.IsEmpty);
        Assert.Equal("", catalog.Hash);
    }

    [Fact]
    public void Definitions_are_sorted_by_name_so_declaration_order_cannot_change_the_hash()
    {
        var other = new ComponentSpec { Name = "a-card", Template = "<p>a</p>" };
        var a = new ComponentCatalog([OrderCardSpec, other]);
        var b = new ComponentCatalog([other, OrderCardSpec]);

        Assert.Equal(new[] { "a-card", "order-card" }, a.Definitions.Select(d => (string)d["name"]!));
        Assert.Equal(a.Hash, b.Hash);
    }

    [Fact]
    public void A_changed_template_changes_the_hash()
    {
        var before = new ComponentCatalog([OrderCardSpec]).Hash;
        var after = new ComponentCatalog([OrderCardSpec with { Template = "<p>new</p>" }]).Hash;

        Assert.NotEqual(before, after);
    }

    [Fact]
    public void A_changed_version_changes_the_hash()
    {
        Assert.NotEqual(
            new ComponentCatalog([OrderCardSpec]).Hash,
            new ComponentCatalog([OrderCardSpec with { Version = "2" }]).Hash);
    }

    [Fact]
    public void Hash_is_lowercase_sha256_hex()
    {
        Assert.Matches("^[0-9a-f]{64}$", new ComponentCatalog([OrderCardSpec]).Hash);
    }

    /// <summary>
    /// Pinned against the TypeScript reference: `sha256(canonicalize([definition]))`.
    /// A change here means the two implementations have drifted and a client would
    /// re-download the catalog every time it switched servers.
    /// </summary>
    [Fact]
    public void Catalog_hash_matches_the_TypeScript_reference()
    {
        var definitions = new ComponentCatalog([OrderCardSpec]).Definitions;
        var canonical = Json.Canonicalize(definitions.Cast<object?>().ToList());

        Assert.Equal(
            "[{\"css\":\".card { padding: 12px; }\",\"name\":\"order-card\",\"props\":{\"title\":\"\"},\"template\":\"<h3>{{title}}</h3><button data-event=\\\"track_order\\\">Track</button>\"}]",
            canonical);

        Assert.Equal("d8a1c30060008da9bc3ec56223be3e43d4c1340178460381bb60d9e1bc170847", new ComponentCatalog([OrderCardSpec]).Hash);
    }

    [Fact]
    public void Duplicate_names_are_rejected()
    {
        var ex = Assert.Throws<ArgumentException>(() =>
            new ComponentCatalog([OrderCardSpec, OrderCardSpec with { Template = "<p>other</p>" }]));

        Assert.Contains("duplicate component name", ex.Message);
    }

    [Fact]
    public void A_non_component_source_is_rejected()
    {
        Assert.Throws<ArgumentException>(() => new ComponentCatalog(["not a component"]));
    }

    [Fact]
    public void Catalog_frame_type_is_reserved_but_not_persistent()
    {
        Assert.Contains("genui_components", Protocol.ReservedFrameTypes);
        Assert.DoesNotContain("genui_components", Protocol.PersistentFrameTypes);
    }
}
