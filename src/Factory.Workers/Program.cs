using Factory.Workers;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddHostedService<StepRunner>();
await builder.Build().RunAsync();
