using System.Data.Common;
using Factory.Infrastructure.Persistence;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;

namespace Factory.Infrastructure;

public static class ServiceCollectionExtensions
{
    /// <summary>
    /// Registers Postgres and the stores. This is the only place Npgsql is
    /// referenced; everything else works against <see cref="DbDataSource"/>.
    /// </summary>
    public static IServiceCollection AddFactoryInfrastructure(this IServiceCollection services, string connectionString)
    {
        services.AddSingleton<DbDataSource>(_ => NpgsqlDataSource.Create(connectionString));
        services.AddSingleton<Migrator>();
        services.AddSingleton<AuditStore>();
        services.AddSingleton<RunStore>();
        return services;
    }
}
