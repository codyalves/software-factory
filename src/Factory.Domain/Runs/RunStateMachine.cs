namespace Factory.Domain.Runs;

public enum RunState
{
    Intake,
    Triage,
    Planning,
    Implementing,
    Gating,
    Reviewing,
    Merging,
    Merged,
    Escalated,
    Rejected,
    Cancelled,
}

public sealed record TransitionResult(bool Allowed, string? Reason)
{
    public static readonly TransitionResult Ok = new(true, null);

    public static TransitionResult Deny(string reason) => new(false, reason);
}

/// <summary>
/// The run lifecycle. Deterministic code owns every transition; models only
/// supply inputs to the decisions at branch points.
/// </summary>
public static class RunStateMachine
{
    /// <summary>Implement attempts allowed before a run must escalate to a human.</summary>
    public const int MaxImplementAttempts = 4;

    private static readonly Dictionary<RunState, RunState[]> Forward = new()
    {
        [RunState.Intake] = [RunState.Triage],
        [RunState.Triage] = [RunState.Planning, RunState.Rejected],
        [RunState.Planning] = [RunState.Implementing],
        [RunState.Implementing] = [RunState.Gating],
        // A failed gate or a rejecting review goes back to Implementing with the
        // failure as input. That is agent iteration, not an infrastructure retry.
        [RunState.Gating] = [RunState.Reviewing, RunState.Implementing],
        [RunState.Reviewing] = [RunState.Merging, RunState.Implementing],
        [RunState.Merging] = [RunState.Merged],
    };

    public static bool IsTerminal(RunState state) =>
        state is RunState.Merged or RunState.Escalated or RunState.Rejected or RunState.Cancelled;

    /// <param name="implementAttempts">Implement attempts already made in this run.</param>
    public static TransitionResult Evaluate(RunState from, RunState to, int implementAttempts)
    {
        if (IsTerminal(from))
        {
            return TransitionResult.Deny($"{from} is terminal");
        }

        // A human or a spent budget can stop any active run.
        if (to is RunState.Escalated or RunState.Cancelled)
        {
            return TransitionResult.Ok;
        }

        if (!Forward.TryGetValue(from, out var next) || !next.Contains(to))
        {
            return TransitionResult.Deny($"{from} cannot move to {to}");
        }

        if (to == RunState.Implementing && implementAttempts >= MaxImplementAttempts)
        {
            return TransitionResult.Deny(
                $"attempt cap of {MaxImplementAttempts} reached; escalate instead");
        }

        return TransitionResult.Ok;
    }
}
