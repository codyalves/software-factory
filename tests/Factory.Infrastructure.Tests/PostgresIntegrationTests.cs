using Factory.Domain.Forge;
using Factory.Domain.Runs;
using Factory.Infrastructure.Persistence;
using Npgsql;

namespace Factory.Infrastructure.Tests;

public class PostgresIntegrationTests
{
    private static readonly ForgeIssue Issue = new("codyalves/target", 12, "Fix the footer", "It overlaps on mobile.", ["factory"]);

    [PostgresFact]
    public async Task Issue_intake_creates_a_run_and_a_verifiable_audit_trail()
    {
        await using var db = await PostgresTestDatabase.CreateAsync();
        var runs = new RunStore(db.DataSource);
        var audit = new AuditStore(db.DataSource);

        var result = await runs.CreateFromIssueAsync(Issue, "github", "delivery-1", CancellationToken.None);

        Assert.Equal(IntakeOutcome.Created, result.Outcome);
        var run = await runs.GetAsync(result.RunId!.Value, CancellationToken.None);
        Assert.Equal(RunState.Intake, run!.State);

        var events = await audit.ReadAllAsync(CancellationToken.None);
        Assert.Equal(new[] { "requirement.received", "run.created" }, events.Select(e => e.Type));
        Assert.True((await audit.VerifyAsync(CancellationToken.None)).IsValid);
        Assert.Empty(await audit.VerifyInDatabaseAsync(CancellationToken.None));
    }

    [PostgresFact]
    public async Task A_redelivered_webhook_changes_nothing()
    {
        await using var db = await PostgresTestDatabase.CreateAsync();
        var runs = new RunStore(db.DataSource);

        await runs.CreateFromIssueAsync(Issue, "github", "delivery-1", CancellationToken.None);
        var again = await runs.CreateFromIssueAsync(Issue, "github", "delivery-1", CancellationToken.None);

        Assert.Equal(IntakeOutcome.DuplicateDelivery, again.Outcome);
        Assert.Equal(2, (await new AuditStore(db.DataSource).ReadAllAsync(CancellationToken.None)).Count);
    }

    [PostgresFact]
    public async Task A_second_trigger_for_an_active_requirement_does_not_start_another_run()
    {
        await using var db = await PostgresTestDatabase.CreateAsync();
        var runs = new RunStore(db.DataSource);

        await runs.CreateFromIssueAsync(Issue, "github", "delivery-1", CancellationToken.None);
        var second = await runs.CreateFromIssueAsync(Issue, "github", "delivery-2", CancellationToken.None);

        Assert.Equal(IntakeOutcome.AlreadyActive, second.Outcome);
    }

    [PostgresFact]
    public async Task Advancing_a_run_records_the_transition()
    {
        await using var db = await PostgresTestDatabase.CreateAsync();
        var runs = new RunStore(db.DataSource);
        await runs.CreateFromIssueAsync(Issue, "github", "delivery-1", CancellationToken.None);

        var moved = await runs.AdvanceNextAsync(RunState.Intake, RunState.Triage, "test", CancellationToken.None);
        var nothingLeft = await runs.AdvanceNextAsync(RunState.Intake, RunState.Triage, "test", CancellationToken.None);

        Assert.Equal(RunState.Triage, moved!.State);
        Assert.Null(nothingLeft);
        var last = (await new AuditStore(db.DataSource).ReadAllAsync(CancellationToken.None))[^1];
        Assert.Equal("run.state_changed", last.Type);
        Assert.Contains("\"to\":\"Triage\"", last.Payload, StringComparison.Ordinal);
    }

    [PostgresFact]
    public async Task Audit_events_cannot_be_updated_or_deleted()
    {
        await using var db = await PostgresTestDatabase.CreateAsync();
        await new RunStore(db.DataSource).CreateFromIssueAsync(Issue, "github", "delivery-1", CancellationToken.None);

        await Assert.ThrowsAsync<PostgresException>(() => db.ExecuteAsync("update audit_event set type = 'x' where seq = 1"));
        await Assert.ThrowsAsync<PostgresException>(() => db.ExecuteAsync("delete from audit_event where seq = 1"));
        await Assert.ThrowsAsync<PostgresException>(() => db.ExecuteAsync("truncate audit_event"));
    }

    [PostgresFact]
    public async Task Tampering_by_a_privileged_user_is_detected_at_the_exact_event()
    {
        await using var db = await PostgresTestDatabase.CreateAsync();
        var audit = new AuditStore(db.DataSource);
        await new RunStore(db.DataSource).CreateFromIssueAsync(Issue, "github", "delivery-1", CancellationToken.None);

        // An owner can switch the trigger off. The hash chain is what still catches it.
        await db.ExecuteAsync("""
            alter table audit_event disable trigger audit_event_no_update_or_delete;
            update audit_event set payload = '{"forged":true}' where seq = 1;
            alter table audit_event enable trigger audit_event_no_update_or_delete;
            """);

        var app = await audit.VerifyAsync(CancellationToken.None);
        var database = await audit.VerifyInDatabaseAsync(CancellationToken.None);

        Assert.False(app.IsValid);
        Assert.Equal(1L, app.BrokenAtSeq);
        Assert.Equal(1L, Assert.Single(database).Seq);
    }
}
