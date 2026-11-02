using Factory.Infrastructure;
using Factory.Infrastructure.Forge.GitHub;
using Factory.Infrastructure.Persistence;

var builder = WebApplication.CreateBuilder(args);

var connectionString = builder.Configuration.GetConnectionString("Factory")
    ?? throw new InvalidOperationException("ConnectionStrings:Factory is not configured.");

builder.Services.AddFactoryInfrastructure(connectionString);

var app = builder.Build();

if (app.Configuration.GetValue("Database:MigrateOnStartup", false))
{
    var directory = app.Configuration["Database:MigrationsPath"] ?? "db/migrations";
    var applied = await app.Services.GetRequiredService<Migrator>().ApplyAsync(directory, CancellationToken.None);
    Log.MigrationsApplied(app.Logger, applied.Count, applied);
}

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

// GitHub calls this for repository events. Only signed "issues" events that
// carry the factory label start a run.
app.MapPost("/webhooks/github", async (HttpRequest request, RunStore runs, IConfiguration config, CancellationToken ct) =>
{
    var secret = config["GitHub:WebhookSecret"];
    if (string.IsNullOrEmpty(secret))
    {
        return Results.Problem("Webhook secret is not configured.", statusCode: StatusCodes.Status503ServiceUnavailable);
    }

    using var buffer = new MemoryStream();
    await request.Body.CopyToAsync(buffer, ct);
    var body = buffer.ToArray();

    if (!GitHubWebhook.IsSignatureValid(secret, body, request.Headers["X-Hub-Signature-256"]))
    {
        return Results.Unauthorized();
    }

    var eventName = request.Headers["X-GitHub-Event"].ToString();
    var deliveryId = request.Headers["X-GitHub-Delivery"].ToString();
    if (string.IsNullOrEmpty(deliveryId))
    {
        return Results.BadRequest(new { error = "missing X-GitHub-Delivery" });
    }

    var issue = GitHubWebhook.ParseIssueEvent(eventName, body);
    if (issue is null)
    {
        return Results.Ok(new { ignored = true });
    }

    var result = await runs.CreateFromIssueAsync(issue, "github", deliveryId, ct);
    return result.Outcome switch
    {
        IntakeOutcome.Created => Results.Accepted($"/runs/{result.RunId}", new { runId = result.RunId }),
        _ => Results.Ok(new { outcome = result.Outcome.ToString() }),
    };
});

app.MapGet("/runs/{id:guid}", async (Guid id, RunStore runs, CancellationToken ct) =>
    await runs.GetAsync(id, ct) is { } run
        ? Results.Ok(new { run.Id, run.RequirementId, state = run.State.ToString(), run.ImplementAttempts })
        : Results.NotFound());

// Recomputes the whole chain twice: once in Postgres, once in application code.
app.MapGet("/audit/verify", async (AuditStore audit, CancellationToken ct) =>
{
    var inApp = await audit.VerifyAsync(ct);
    var database = await audit.VerifyInDatabaseAsync(ct);
    return Results.Ok(new
    {
        valid = inApp.IsValid && database.Count == 0,
        events = inApp.EventCount,
        headHash = inApp.HeadHash,
        application = new { inApp.IsValid, inApp.BrokenAtSeq, inApp.Problem },
        database = database.Select(p => new { p.Seq, p.Problem }),
    });
});

await app.RunAsync();

/// <summary>Entry point, exposed for integration tests.</summary>
public partial class Program;

internal static partial class Log
{
    [LoggerMessage(Level = LogLevel.Information, Message = "Applied {Count} migration(s): {Versions}")]
    public static partial void MigrationsApplied(ILogger logger, int count, IReadOnlyList<string> versions);
}
