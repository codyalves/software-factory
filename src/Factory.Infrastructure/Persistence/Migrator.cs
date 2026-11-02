using System.Data.Common;
using System.Security.Cryptography;
using System.Text;

namespace Factory.Infrastructure.Persistence;

/// <summary>
/// Applies db/migrations/*.sql in name order, each in its own transaction,
/// recording a checksum so an edited migration is caught instead of skipped.
/// </summary>
public sealed class Migrator(DbDataSource dataSource)
{
    private const long MigrationLockKey = 0x5F_AC_70_12;

    public async Task<IReadOnlyList<string>> ApplyAsync(string migrationsDirectory, CancellationToken cancellationToken)
    {
        var files = Directory.GetFiles(migrationsDirectory, "*.sql").Order(StringComparer.Ordinal).ToList();
        var applied = new List<string>();

        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);

        await Execute(connection, null, """
            create table if not exists schema_migrations (
                version    text primary key,
                checksum   char(64) not null,
                applied_at timestamptz not null default now())
            """, cancellationToken);

        foreach (var file in files)
        {
            var version = Path.GetFileNameWithoutExtension(file);
            var sql = await File.ReadAllTextAsync(file, cancellationToken);
            var checksum = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sql)));

            await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

            // Two instances starting together must not both apply a migration.
            await Execute(connection, transaction, $"select pg_advisory_xact_lock({MigrationLockKey})", cancellationToken);

            var existing = await Scalar(connection, transaction,
                "select checksum from schema_migrations where version = @version",
                cancellationToken, ("version", version));

            if (existing is string recorded)
            {
                if (!string.Equals(recorded.Trim(), checksum, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException(
                        $"Migration {version} was edited after it was applied. Add a new migration instead.");
                }

                await transaction.RollbackAsync(cancellationToken);
                continue;
            }

            await Execute(connection, transaction, sql, cancellationToken);
            await Execute(connection, transaction,
                "insert into schema_migrations (version, checksum) values (@version, @checksum)",
                cancellationToken, ("version", version), ("checksum", checksum));

            await transaction.CommitAsync(cancellationToken);
            applied.Add(version);
        }

        return applied;
    }

    private static async Task Execute(
        DbConnection connection, DbTransaction? transaction, string sql,
        CancellationToken cancellationToken, params (string Name, object? Value)[] parameters)
    {
        await using var command = Sql.Command(connection, transaction, sql, parameters);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<object?> Scalar(
        DbConnection connection, DbTransaction? transaction, string sql,
        CancellationToken cancellationToken, params (string Name, object? Value)[] parameters)
    {
        await using var command = Sql.Command(connection, transaction, sql, parameters);
        return await command.ExecuteScalarAsync(cancellationToken);
    }
}
