using System.Data.Common;
using Factory.Domain.Audit;

namespace Factory.Infrastructure.Persistence;

/// <summary>
/// Reads and appends audit events. Appends go through the audit_append SQL
/// function, which serializes writers and computes the hash in the database.
/// </summary>
public sealed class AuditStore(DbDataSource dataSource)
{
    /// <summary>Appends inside the caller's transaction, so the event commits with the change it records.</summary>
    public static async Task<AuditEvent> AppendAsync(
        DbConnection connection, DbTransaction transaction,
        Guid? runId, string type, object payload, CancellationToken cancellationToken)
    {
        await using var command = Sql.Command(connection, transaction,
            "select seq, at, run_id, type, payload, prev_hash, hash from audit_append(@run_id::uuid, @type, @payload)",
            ("run_id", runId), ("type", type), ("payload", CanonicalJson.Serialize(payload)));

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        await reader.ReadAsync(cancellationToken);
        return Map(reader);
    }

    public async Task<IReadOnlyList<AuditEvent>> ReadAllAsync(CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = Sql.Command(connection, null,
            "select seq, at, run_id, type, payload, prev_hash, hash from audit_event order by seq");

        var events = new List<AuditEvent>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            events.Add(Map(reader));
        }

        return events;
    }

    /// <summary>Recomputes the chain in application code.</summary>
    public async Task<ChainVerification> VerifyAsync(CancellationToken cancellationToken) =>
        AuditChain.Verify(await ReadAllAsync(cancellationToken));

    /// <summary>Recomputes the chain inside Postgres with the audit_verify function.</summary>
    public async Task<IReadOnlyList<(long Seq, string Problem)>> VerifyInDatabaseAsync(CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = Sql.Command(connection, null, "select seq, problem from audit_verify()");

        var problems = new List<(long, string)>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            problems.Add((reader.GetInt64(0), reader.GetString(1)));
        }

        return problems;
    }

    private static AuditEvent Map(DbDataReader reader) => new(
        Seq: reader.GetInt64(0),
        At: new DateTimeOffset(DateTime.SpecifyKind(reader.GetDateTime(1), DateTimeKind.Utc)),
        RunId: reader.IsDBNull(2) ? null : reader.GetGuid(2),
        Type: reader.GetString(3),
        Payload: reader.GetString(4),
        PrevHash: reader.GetString(5).Trim(),
        Hash: reader.GetString(6).Trim());
}
