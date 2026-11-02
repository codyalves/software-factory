using Factory.Domain.Runs;
using Factory.Infrastructure.Persistence;

namespace Factory.Orchestrator;

/// <summary>
/// M0: claims runs waiting in Intake and moves them to Triage, recording the
/// transition. M1 replaces this with the full state machine driven by queued
/// steps, the decision layer and gate results.
/// </summary>
internal sealed partial class IntakeLoop(RunStore runs, ILogger<IntakeLoop> logger) : BackgroundService
{
    private static readonly TimeSpan IdleDelay = TimeSpan.FromSeconds(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var run = await runs.AdvanceNextAsync(RunState.Intake, RunState.Triage, "picked up by orchestrator", stoppingToken);
                if (run is not null)
                {
                    LogAdvanced(run.Id, run.State);
                    continue;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                LogLoopFailed(ex);
            }

            await Task.Delay(IdleDelay, stoppingToken);
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Run {RunId} moved to {State}")]
    private partial void LogAdvanced(Guid runId, RunState state);

    [LoggerMessage(Level = LogLevel.Error, Message = "Intake loop iteration failed")]
    private partial void LogLoopFailed(Exception ex);
}
