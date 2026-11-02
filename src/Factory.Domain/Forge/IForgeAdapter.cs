namespace Factory.Domain.Forge;

/// <summary>An issue as the factory sees it, independent of the git host.</summary>
public sealed record ForgeIssue(
    string Repo,
    int Number,
    string Title,
    string Body,
    IReadOnlyList<string> Labels);

/// <summary>
/// Everything the factory needs from a git host. GitHub is the first
/// implementation; GitLab can follow without touching the orchestrator.
/// </summary>
public interface IForgeAdapter
{
    string Name { get; }

    Task CommentAsync(string repo, int issueNumber, string body, CancellationToken cancellationToken);

    Task<int> OpenPullRequestAsync(
        string repo, string head, string baseBranch, string title, string body, CancellationToken cancellationToken);

    Task MergePullRequestAsync(string repo, int pullNumber, CancellationToken cancellationToken);
}
