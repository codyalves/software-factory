using System.Data.Common;
using Factory.Domain.Forge;
using Factory.Domain.Runs;

namespace Factory.Infrastructure.Persistence;

public sealed record RunSummary(Guid Id, Guid RequirementId, RunState State, int ImplementAttempts);

public enum IntakeOutcome
{
    Created,
    DuplicateDelivery,
    AlreadyActive,
}

public sealed record IntakeResult(IntakeOutcome Outcome, Guid? RunId);

/// <summary>
/// Run lifecycle persistence. Every state change and its audit event commit in
/// the same transaction, so the record can never disagree with the state.
/// </summary>
public sealed class RunStore(DbDataSource dataSource)
{
    /// <summary>
    /// Turns an inbound issue into a requirement and a new run. A redelivered
    /// webhook (same delivery id) changes nothing.
    /// </summary>
    public async Task<IntakeResult> CreateFromIssueAsync(
        ForgeIssue issue, string source, string deliveryId, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(issue);

        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        var firstDelivery = await NonQuery(connection, transaction,
            "insert into inbound_delivery (delivery_id, source) values (@id, @source) on conflict do nothing",
            cancellationToken, ("id", deliveryId), ("source", source));

        if (firstDelivery == 0)
        {
            await transaction.RollbackAsync(cancellationToken);
            return new IntakeResult(IntakeOutcome.DuplicateDelivery, null);
        }

        var requirementId = (Guid)(await Scalar(connection, transaction, """
            insert into requirement (repo, issue_number, title, body)
            values (@repo, @number, @title, @body)
            on conflict (repo, issue_number)
                do update set title = excluded.title, body = excluded.body
            returning id
            """, cancellationToken,
            ("repo", issue.Repo), ("number", issue.Number), ("title", issue.Title), ("body", issue.Body)))!;

        var runId = await Scalar(connection, transaction, """
            insert into run (requirement_id, state) values (@requirement, 'Intake')
            on conflict (requirement_id) where state not in ('Merged', 'Escalated', 'Rejected', 'Cancelled')
                do nothing
            returning id
            """, cancellationToken, ("requirement", requirementId)) as Guid?;

        await AuditStore.AppendAsync(connection, transaction, runId, "requirement.received", new
        {
            source,
            deliveryId,
            repo = issue.Repo,
            issue = issue.Number,
            title = issue.Title,
            labels = issue.Labels,
        }, cancellationToken);

        if (runId is null)
        {
            await transaction.CommitAsync(cancellationToken);
            return new IntakeResult(IntakeOutcome.AlreadyActive, null);
        }

        await AuditStore.AppendAsync(connection, transaction, runId, "run.created", new
        {
            requirementId,
            state = nameof(RunState.Intake),
        }, cancellationToken);

        await transaction.CommitAsync(cancellationToken);
        return new IntakeResult(IntakeOutcome.Created, runId);
    }

    public async Task<RunSummary?> GetAsync(Guid runId, CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = Sql.Command(connection, null,
            "select id, requirement_id, state, implement_attempts from run where id = @id", ("id", runId));
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? Map(reader) : null;
    }

    /// <summary>
    /// Claims the oldest run in <paramref name="from"/> (skipping rows another
    /// orchestrator holds) and moves it to <paramref name="to"/>. Returns null
    /// when nothing is waiting.
    /// </summary>
    public async Task<RunSummary?> AdvanceNextAsync(
        RunState from, RunState to, string reason, CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        RunSummary? run;
        await using (var claim = Sql.Command(connection, transaction, """
            select id, requirement_id, state, implement_attempts from run
            where state = @state
            order by created_at
            for update skip locked
            limit 1
            """, ("state", from.ToString())))
        await using (var reader = await claim.ExecuteReaderAsync(cancellationToken))
        {
            run = await reader.ReadAsync(cancellationToken) ? Map(reader) : null;
        }

        if (run is null)
        {
            await transaction.RollbackAsync(cancellationToken);
            return null;
        }

        var moved = await TransitionAsync(connection, transaction, run, to, reason, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return moved;
    }

    private static async Task<RunSummary> TransitionAsync(
        DbConnection connection, DbTransaction transaction, RunSummary run, RunState to, string reason,
        CancellationToken cancellationToken)
    {
        var check = RunStateMachine.Evaluate(run.State, to, run.ImplementAttempts);
        if (!check.Allowed)
        {
            throw new InvalidOperationException($"Run {run.Id}: {check.Reason}");
        }

        var attempts = to == RunState.Implementing ? run.ImplementAttempts + 1 : run.ImplementAttempts;

        await NonQuery(connection, transaction,
            "update run set state = @state, implement_attempts = @attempts, updated_at = now() where id = @id",
            cancellationToken, ("state", to.ToString()), ("attempts", attempts), ("id", run.Id));

        await AuditStore.AppendAsync(connection, transaction, run.Id, "run.state_changed", new
        {
            from = run.State.ToString(),
            to = to.ToString(),
            reason,
            implementAttempts = attempts,
        }, cancellationToken);

        return run with { State = to, ImplementAttempts = attempts };
    }

    private static RunSummary Map(DbDataReader reader) => new(
        reader.GetGuid(0),
        reader.GetGuid(1),
        Enum.Parse<RunState>(reader.GetString(2)),
        reader.GetInt32(3));

    private static async Task<int> NonQuery(
        DbConnection connection, DbTransaction transaction, string sql,
        CancellationToken cancellationToken, params (string Name, object? Value)[] parameters)
    {
        await using var command = Sql.Command(connection, transaction, sql, parameters);
        return await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<object?> Scalar(
        DbConnection connection, DbTransaction transaction, string sql,
        CancellationToken cancellationToken, params (string Name, object? Value)[] parameters)
    {
        await using var command = Sql.Command(connection, transaction, sql, parameters);
        return await command.ExecuteScalarAsync(cancellationToken);
    }
}
