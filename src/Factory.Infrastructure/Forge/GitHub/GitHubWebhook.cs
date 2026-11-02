using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Factory.Domain.Forge;

namespace Factory.Infrastructure.Forge.GitHub;

public static class GitHubWebhook
{
    /// <summary>Label that opts an issue into the factory.</summary>
    public const string FactoryLabel = "factory";

    /// <summary>
    /// Checks the X-Hub-Signature-256 header (HMAC-SHA256 of the raw body)
    /// in constant time.
    /// </summary>
    public static bool IsSignatureValid(string secret, ReadOnlySpan<byte> body, string? signatureHeader)
    {
        ArgumentException.ThrowIfNullOrEmpty(secret);

        const string prefix = "sha256=";
        if (signatureHeader is null || !signatureHeader.StartsWith(prefix, StringComparison.Ordinal))
        {
            return false;
        }

        byte[] provided;
        try
        {
            provided = Convert.FromHexString(signatureHeader.AsSpan(prefix.Length));
        }
        catch (FormatException)
        {
            return false;
        }

        var expected = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), body);
        return CryptographicOperations.FixedTimeEquals(expected, provided);
    }

    /// <summary>
    /// Returns the issue when an "issues" event should start a run: the issue
    /// was opened with the factory label, or the label was just added.
    /// </summary>
    public static ForgeIssue? ParseIssueEvent(string eventName, ReadOnlySpan<byte> body)
    {
        if (!string.Equals(eventName, "issues", StringComparison.Ordinal))
        {
            return null;
        }

        using var document = JsonDocument.Parse(body.ToArray());
        var root = document.RootElement;

        var action = root.GetProperty("action").GetString();
        var issue = root.GetProperty("issue");
        var labels = issue.GetProperty("labels").EnumerateArray()
            .Select(l => l.GetProperty("name").GetString() ?? string.Empty)
            .ToList();

        var triggered = action switch
        {
            "opened" => labels.Contains(FactoryLabel),
            "labeled" => root.TryGetProperty("label", out var added)
                         && added.GetProperty("name").GetString() == FactoryLabel,
            _ => false,
        };

        if (!triggered)
        {
            return null;
        }

        return new ForgeIssue(
            Repo: root.GetProperty("repository").GetProperty("full_name").GetString()!,
            Number: issue.GetProperty("number").GetInt32(),
            Title: issue.GetProperty("title").GetString() ?? string.Empty,
            Body: issue.TryGetProperty("body", out var b) && b.ValueKind == JsonValueKind.String ? b.GetString()! : string.Empty,
            Labels: labels);
    }
}
