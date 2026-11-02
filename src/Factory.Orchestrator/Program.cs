using Factory.Infrastructure;
using Factory.Orchestrator;

var builder = Host.CreateApplicationBuilder(args);

var connectionString = builder.Configuration.GetConnectionString("Factory")
    ?? throw new InvalidOperationException("ConnectionStrings:Factory is not configured.");

builder.Services.AddFactoryInfrastructure(connectionString);
builder.Services.AddHostedService<IntakeLoop>();

await builder.Build().RunAsync();
