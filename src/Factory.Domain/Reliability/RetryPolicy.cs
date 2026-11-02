using System.Net;

namespace Factory.Domain.Reliability;

/// <summary>
/// Why a step failed to run. Gate failures are not listed here: a step that ran
/// and produced wrong code is handled by agent iteration in the run state
/// machine, never by an infrastructure retry.
/// </summary>
public enum FailureClass
{
    /// <summary>Network blip, HTTP 408/429/5xx, worker lost. Safe to retry.</summary>
    Transient,

    /// <summary>The step overran its deadline. Retried once, then dead-lettered.</summary>
    Timeout,

    /// <summary>Bad config, missing access, invalid input. Retrying cannot help.</summary>
    Permanent,
}

public sealed record RetryDecision(bool Retry, TimeSpan Delay, string Reason)
{
    public static RetryDecision DeadLetter(string reason) => new(false, TimeSpan.Zero, reason);
}

public sealed record RetryPolicy(int MaxAttempts, TimeSpan BaseDelay, TimeSpan MaxDelay)
{
    public static RetryPolicy Default { get; } = new(5, TimeSpan.FromSeconds(2), TimeSpan.FromMinutes(5));

    public static FailureClass Classify(HttpStatusCode? status, Exception? error) => (status, error) switch
    {
        (_, TimeoutException) or (_, TaskCanceledException) => FailureClass.Timeout,
        (HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests, _) => FailureClass.Transient,
        ({ } code, _) when (int)code >= 500 => FailureClass.Transient,
        ({ }, _) => FailureClass.Permanent,
        (null, HttpRequestException or IOException) => FailureClass.Transient,
        _ => FailureClass.Permanent,
    };

    /// <param name="attempt">The attempt that just failed, starting at 1.</param>
    /// <param name="retryAfter">Server-provided Retry-After, if any. Never undercut.</param>
    public RetryDecision Decide(FailureClass failure, int attempt, TimeSpan? retryAfter, Random random)
    {
        ArgumentNullException.ThrowIfNull(random);

        switch (failure)
        {
            case FailureClass.Permanent:
                return RetryDecision.DeadLetter("permanent failure");
            case FailureClass.Timeout when attempt >= 2:
                return RetryDecision.DeadLetter("timed out twice");
            case FailureClass.Transient when attempt >= MaxAttempts:
                return RetryDecision.DeadLetter($"gave up after {MaxAttempts} attempts");
        }

        // Exponential backoff with full jitter: uniform in [0, min(max, base * 2^(n-1))].
        var ceiling = Math.Min(MaxDelay.TotalMilliseconds, BaseDelay.TotalMilliseconds * Math.Pow(2, attempt - 1));
        var delay = TimeSpan.FromMilliseconds(random.NextDouble() * ceiling);

        if (retryAfter is { } floor && floor > delay)
        {
            delay = floor;
        }

        return new RetryDecision(true, delay, $"{failure} failure, attempt {attempt}");
    }
}
