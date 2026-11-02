using Factory.Domain.Runs;

namespace Factory.Domain.Tests;

public class RunStateMachineTests
{
    [Theory]
    [InlineData(RunState.Intake, RunState.Triage)]
    [InlineData(RunState.Triage, RunState.Planning)]
    [InlineData(RunState.Triage, RunState.Rejected)]
    [InlineData(RunState.Planning, RunState.Implementing)]
    [InlineData(RunState.Implementing, RunState.Gating)]
    [InlineData(RunState.Gating, RunState.Reviewing)]
    [InlineData(RunState.Reviewing, RunState.Merging)]
    [InlineData(RunState.Merging, RunState.Merged)]
    public void Happy_path_transitions_are_allowed(RunState from, RunState to)
    {
        Assert.True(RunStateMachine.Evaluate(from, to, implementAttempts: 0).Allowed);
    }

    [Theory]
    [InlineData(RunState.Intake, RunState.Implementing)]
    [InlineData(RunState.Planning, RunState.Merging)]
    [InlineData(RunState.Gating, RunState.Merging)]
    [InlineData(RunState.Implementing, RunState.Reviewing)]
    public void Skipping_stages_is_denied(RunState from, RunState to)
    {
        Assert.False(RunStateMachine.Evaluate(from, to, implementAttempts: 0).Allowed);
    }

    [Fact]
    public void A_failed_gate_can_iterate_until_the_cap()
    {
        Assert.True(RunStateMachine.Evaluate(RunState.Gating, RunState.Implementing, 3).Allowed);

        var capped = RunStateMachine.Evaluate(RunState.Gating, RunState.Implementing, RunStateMachine.MaxImplementAttempts);

        Assert.False(capped.Allowed);
        Assert.Contains("escalate", capped.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void A_capped_run_can_still_escalate()
    {
        Assert.True(RunStateMachine.Evaluate(RunState.Gating, RunState.Escalated, RunStateMachine.MaxImplementAttempts).Allowed);
    }

    [Theory]
    [InlineData(RunState.Merged)]
    [InlineData(RunState.Escalated)]
    [InlineData(RunState.Rejected)]
    [InlineData(RunState.Cancelled)]
    public void Terminal_states_cannot_move(RunState terminal)
    {
        Assert.False(RunStateMachine.Evaluate(terminal, RunState.Cancelled, 0).Allowed);
        Assert.False(RunStateMachine.Evaluate(terminal, RunState.Triage, 0).Allowed);
    }
}
