using System.Data.Common;
using Factory.Infrastructure.Persistence;
using Npgsql;

namespace Factory.Infrastructure.Tests;

/// <summary>
/// Runs only when FACTORY_TEST_DB holds a connection string to a server where
/// the user can create databases (CI provides one). Skipped otherwise.
/// </summary>
public sealed class PostgresFactAttribute : FactAttribute
{
    public PostgresFactAttribute()
    {
        if (string.IsNullOrEmpty(PostgresTestDatabase.AdminConnectionString))
        {
            Skip = "Set FACTORY_TEST_DB to run Postgres integration tests.";
        }
    }
}

/// <summary>A fresh, migrated database per test, dropped afterwards.</summary>
public sealed class PostgresTestDatabase : IAsyncDisposable
{
    public static string? AdminConnectionString => Environment.GetEnvironmentVariable("FACTORY_TEST_DB");

    private readonly string _name;
    private readonly NpgsqlDataSource _dataSource;

    private PostgresTestDatabase(string name, NpgsqlDataSource dataSource)
    {
        _name = name;
        _dataSource = dataSource;
    }

    public DbDataSource DataSource => _dataSource;

    public static async Task<PostgresTestDatabase> CreateAsync()
    {
        var name = "factory_test_" + Guid.NewGuid().ToString("N");
        await AdminExecute($"create database {name}");

        var builder = new NpgsqlConnectionStringBuilder(AdminConnectionString) { Database = name };
        var database = new PostgresTestDatabase(name, NpgsqlDataSource.Create(builder.ConnectionString));
        await new Migrator(database.DataSource).ApplyAsync(MigrationsDirectory(), CancellationToken.None);
        return database;
    }

    /// <summary>Runs SQL as the database owner, e.g. to simulate tampering.</summary>
    public async Task ExecuteAsync(string sql)
    {
        await using var command = _dataSource.CreateCommand(sql);
        await command.ExecuteNonQueryAsync();
    }

    public async ValueTask DisposeAsync()
    {
        await _dataSource.DisposeAsync();
        NpgsqlConnection.ClearAllPools();
        await AdminExecute($"drop database if exists {_name} with (force)");
    }

    private static async Task AdminExecute(string sql)
    {
        await using var dataSource = NpgsqlDataSource.Create(AdminConnectionString!);
        await using var command = dataSource.CreateCommand(sql);
        await command.ExecuteNonQueryAsync();
    }

    private static string MigrationsDirectory()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "SoftwareFactory.slnx")))
        {
            directory = directory.Parent;
        }

        return Path.Combine(directory?.FullName ?? throw new DirectoryNotFoundException("Repository root not found."), "db", "migrations");
    }
}
