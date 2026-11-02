using System.Net;
using Factory.Domain.Reliability;

namespace Factory.Domain.Tests;

public class RetryPolicyTests
{
    private static readonly RetryPolicy Policy = RetryPolicy.Default;

    [Theory]
    [InlineData(HttpStatusCode.TooManyRequests, FailureClass.Transient)]
    [InlineData(HttpStatusCode.RequestTimeout, FailureClass.Transient)]
    [InlineData(HttpStatusCode.BadGateway, FailureClass.Transient)]
    [InlineData(HttpStatusCode.ServiceUnavailable, FailureClass.Transient)]
    [InlineData(HttpStatusCode.Unauthorized, FailureClass.Permanent)]
    [InlineData(HttpStatusCode.NotFound, FailureClass.Permanent)]
    [InlineData(HttpStatusCode.UnprocessableEntity, FailureClass.Permanent)]
    public void Http_status_is_classified(HttpStatusCode status, FailureClass expected)
    {
        Assert.Equal(expected, RetryPolicy.Classify(status, null));
    }

    [Fact]
    public void Exceptions_are_classified()
    {
        Assert.Equal(FailureClass.Timeout, RetryPolicy.Classify(null, new TimeoutException()));
        Assert.Equal(FailureClass.Transient, RetryPolicy.Classify(null, new HttpRequestException("reset")));
        Assert.Equal(FailureClass.Permanent, RetryPolicy.Classify(null, new InvalidOperationException()));
    }

    [Fact]
    public void Permanent_failures_are_never_retried()
    {
        Assert.False(Policy.Decide(FailureClass.Permanent, 1, null, new Random(1)).Retry);
    }

    [Fact]
    public void Timeouts_are_retried_once()
    {
        Assert.True(Policy.Decide(FailureClass.Timeout, 1, null, new Random(1)).Retry);
        Assert.False(Policy.Decide(FailureClass.Timeout, 2, null, new Random(1)).Retry);
    }

    [Fact]
    public void Transient_failures_stop_at_max_attempts()
    {
        Assert.True(Policy.Decide(FailureClass.Transient, Policy.MaxAttempts - 1, null, new Random(1)).Retry);
        Assert.False(Policy.Decide(FailureClass.Transient, Policy.MaxAttempts, null, new Random(1)).Retry);
    }

    [Fact]
    public void Jittered_delay_stays_within_the_exponential_ceiling()
    {
        var random = new Random(42);
        for (var attempt = 1; attempt < Policy.MaxAttempts; attempt++)
        {
            var ceiling = Math.Min(Policy.MaxDelay.TotalMilliseconds, Policy.BaseDelay.TotalMilliseconds * Math.Pow(2, attempt - 1));
            for (var i = 0; i < 200; i++)
            {
                var delay = Policy.Decide(FailureClass.Transient, attempt, null, random).Delay;
                Assert.InRange(delay.TotalMilliseconds, 0, ceiling);
            }
        }
    }

    [Fact]
    public void Retry_after_is_never_undercut()
    {
        var decision = Policy.Decide(FailureClass.Transient, 1, TimeSpan.FromSeconds(30), new Random(1));

        Assert.True(decision.Retry);
        Assert.Equal(TimeSpan.FromSeconds(30), decision.Delay);
    }
}
