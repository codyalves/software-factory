namespace Factory.Workers;

/// <summary>
/// Placeholder for M1. Workers will lease queued steps, run each agent or
/// gate step in a fresh sandbox container, heartbeat while it runs, and report
/// results through the step table. Kept as a separate deployable now so it can
/// scale on queue depth independently of the API.
/// </summary>
internal sealed partial class StepRunner(ILogger<StepRunner> logger) : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        LogIdle();
        return Task.CompletedTask;
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Step runner started; step execution arrives in M1")]
    private partial void LogIdle();
}
