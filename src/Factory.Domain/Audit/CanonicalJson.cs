using System.Text.Json;
using System.Text.Json.Nodes;

namespace Factory.Domain.Audit;

/// <summary>
/// Deterministic JSON for audit payloads: object keys sorted ordinally,
/// no whitespace. The canonical text is what gets hashed and stored.
/// </summary>
public static class CanonicalJson
{
    private static readonly JsonSerializerOptions SerializeOptions = new(JsonSerializerDefaults.Web);
    private static readonly JsonSerializerOptions WriteOptions = new() { WriteIndented = false };

    public static string Serialize<T>(T value) =>
        Write(JsonSerializer.SerializeToNode(value, SerializeOptions));

    public static string Canonicalize(string json) => Write(JsonNode.Parse(json));

    private static string Write(JsonNode? node) => Sort(node)?.ToJsonString(WriteOptions) ?? "null";

    private static JsonNode? Sort(JsonNode? node) => node switch
    {
        JsonObject obj => new JsonObject(
            obj.OrderBy(p => p.Key, StringComparer.Ordinal)
               .Select(p => KeyValuePair.Create(p.Key, Sort(p.Value)))),
        JsonArray arr => new JsonArray([.. arr.Select(Sort)]),
        null => null,
        _ => node.DeepClone(),
    };
}
