namespace Factory.Domain.Decisions;

/// <summary>
/// One atomic question with a closed answer set. Keep questions free of
/// arithmetic, counting and multi-hop reasoning; split those and combine the
/// answers in code.
/// </summary>
public sealed record DecisionQuestion(string Name, string Instructions, IReadOnlyList<string> Options);

/// <summary>A typed answer. Every decision is recorded as an audit event.</summary>
public sealed record Decision(
    string Question,
    string Choice,
    double Probability,
    string Engine,
    string EngineVersion);

/// <summary>
/// The decision layer. Implementations wrap a decision model (such as Jev) or
/// an LLM constrained to the options, so engines can be swapped and compared
/// per question.
/// </summary>
public interface IDecisionModel
{
    string Engine { get; }

    Task<Decision> DecideAsync(DecisionQuestion question, string state, CancellationToken cancellationToken);
}

public sealed record DecisionPolicy(double ConfidenceThreshold)
{
    public static DecisionPolicy Default { get; } = new(0.8);

    /// <summary>Below the threshold the caller takes the question's safe fallback.</summary>
    public bool IsConfident(Decision decision)
    {
        ArgumentNullException.ThrowIfNull(decision);
        return decision.Probability >= ConfidenceThreshold;
    }
}
