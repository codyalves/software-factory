using System.Data.Common;
using System.Diagnostics.CodeAnalysis;

namespace Factory.Infrastructure.Persistence;

internal static class Sql
{
    /// <summary>
    /// Builds a parameterized command. SQL text is always a constant in this
    /// codebase; values only ever travel as parameters.
    /// </summary>
    [SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities",
        Justification = "Callers pass constant SQL; all values are bound parameters.")]
    public static DbCommand Command(
        DbConnection connection, DbTransaction? transaction, string sql,
        params (string Name, object? Value)[] parameters)
    {
        var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Transaction = transaction;

        foreach (var (name, value) in parameters)
        {
            var parameter = command.CreateParameter();
            parameter.ParameterName = name;
            parameter.Value = value ?? DBNull.Value;
            command.Parameters.Add(parameter);
        }

        return command;
    }
}
