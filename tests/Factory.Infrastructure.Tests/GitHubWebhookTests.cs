using System.Security.Cryptography;
using System.Text;
using Factory.Infrastructure.Forge.GitHub;

namespace Factory.Infrastructure.Tests;

public class GitHubWebhookTests
{
    private const string Secret = "test-secret";

    [Fact]
    public void Valid_signature_is_accepted()
    {
        var body = Encoding.UTF8.GetBytes("""{"zen":"Keep it logically awesome."}""");

        Assert.True(GitHubWebhook.IsSignatureValid(Secret, body, Sign(body)));
    }

    [Fact]
    public void Missing_signature_header_is_rejected()
    {
        Assert.False(GitHubWebhook.IsSignatureValid(Secret, Encoding.UTF8.GetBytes("{}"), null));
    }

    [Theory]
    [InlineData("")]
    [InlineData("sha1=abc")]
    [InlineData("sha256=not-hex")]
    [InlineData("sha256=0000000000000000000000000000000000000000000000000000000000000000")]
    public void Wrong_signature_is_rejected(string header)
    {
        var body = Encoding.UTF8.GetBytes("{}");

        Assert.False(GitHubWebhook.IsSignatureValid(Secret, body, header));
    }

    [Fact]
    public void A_modified_body_is_rejected()
    {
        var signature = Sign(Encoding.UTF8.GetBytes("""{"amount":1}"""));

        Assert.False(GitHubWebhook.IsSignatureValid(Secret, Encoding.UTF8.GetBytes("""{"amount":9}"""), signature));
    }

    [Fact]
    public void Issue_opened_with_factory_label_starts_a_run()
    {
        var issue = GitHubWebhook.ParseIssueEvent("issues", IssueEvent("opened", ["factory", "bug"]));

        Assert.NotNull(issue);
        Assert.Equal("codyalves/target", issue.Repo);
        Assert.Equal(12, issue.Number);
        Assert.Equal("Fix the footer", issue.Title);
    }

    [Fact]
    public void Issue_opened_without_the_label_is_ignored()
    {
        Assert.Null(GitHubWebhook.ParseIssueEvent("issues", IssueEvent("opened", ["bug"])));
    }

    [Fact]
    public void Adding_the_factory_label_starts_a_run()
    {
        Assert.NotNull(GitHubWebhook.ParseIssueEvent("issues", IssueEvent("labeled", ["bug", "factory"], added: "factory")));
        Assert.Null(GitHubWebhook.ParseIssueEvent("issues", IssueEvent("labeled", ["bug", "factory"], added: "bug")));
    }

    [Fact]
    public void Other_events_are_ignored()
    {
        Assert.Null(GitHubWebhook.ParseIssueEvent("push", Encoding.UTF8.GetBytes("{}")));
    }

    private static string Sign(byte[] body) =>
        "sha256=" + Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Secret), body));

    private static byte[] IssueEvent(string action, string[] labels, string? added = null)
    {
        var labelJson = string.Join(',', labels.Select(l => $$"""{"name":"{{l}}"}"""));
        var addedJson = added is null ? string.Empty : $$""","label":{"name":"{{added}}"}""";
        return Encoding.UTF8.GetBytes($$"""
            {
              "action": "{{action}}"{{addedJson}},
              "issue": { "number": 12, "title": "Fix the footer", "body": null, "labels": [{{labelJson}}] },
              "repository": { "full_name": "codyalves/target" }
            }
            """);
    }
}
