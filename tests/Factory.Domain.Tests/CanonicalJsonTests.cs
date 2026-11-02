using Factory.Domain.Audit;

namespace Factory.Domain.Tests;

public class CanonicalJsonTests
{
    [Fact]
    public void Key_order_does_not_change_the_output()
    {
        var a = CanonicalJson.Canonicalize("""{ "b": 1, "a": { "y": [3, {"d": 4, "c": 5}], "x": null } }""");
        var b = CanonicalJson.Canonicalize("""{"a":{"x":null,"y":[3,{"c":5,"d":4}]},"b":1}""");

        Assert.Equal("""{"a":{"x":null,"y":[3,{"c":5,"d":4}]},"b":1}""", a);
        Assert.Equal(a, b);
    }

    [Fact]
    public void Array_order_is_preserved()
    {
        Assert.Equal("[3,1,2]", CanonicalJson.Canonicalize("[3, 1, 2]"));
    }

    [Fact]
    public void Serialize_uses_camel_case_and_sorted_keys()
    {
        var json = CanonicalJson.Serialize(new { Zeta = 1, Alpha = "x" });

        Assert.Equal("""{"alpha":"x","zeta":1}""", json);
    }
}
