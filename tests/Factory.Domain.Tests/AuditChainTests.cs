using Factory.Domain.Audit;

namespace Factory.Domain.Tests;

public class AuditChainTests
{
    private static readonly DateTimeOffset T0 = new DateTimeOffset(2026, 11, 2, 20, 0, 0, TimeSpan.Zero).AddTicks(1_234_560);

    // Vectors produced by the audit_hash SQL function in db/migrations/0001_init.sql.
    // If either implementation changes, these fail and existing chains stop verifying.
    [Fact]
    public void ComputeHash_matches_postgres_for_event_without_run()
    {
        var hash = AuditChain.ComputeHash(AuditChain.GenesisHash, 1, T0, null, "factory.started", """{"version":"0.1.0"}""");

        Assert.Equal("ad1247ea59d382e8c30f870f23e58c0a0b9e890d26c839a4b8b877a910e7bcbf", hash);
    }

    [Fact]
    public void ComputeHash_matches_postgres_for_event_with_run_and_escaped_payload()
    {
        var at = new DateTimeOffset(2026, 1, 31, 23, 59, 59, TimeSpan.Zero).AddTicks(10);
        var runId = Guid.Parse("11111111-2222-3333-4444-555555555555");

        var hash = AuditChain.ComputeHash("abc", 7, at, runId, "run.created", """{"a":"hé"}""");

        Assert.Equal("6b05d47bb1fec2711f2834dfa0903f71df101f14cfaf6cab2e2232a5f6e37e67", hash);
    }

    [Fact]
    public void FormatTimestamp_uses_utc_and_microseconds()
    {
        var local = new DateTimeOffset(2026, 11, 2, 13, 0, 0, TimeSpan.FromHours(-7)).AddTicks(1_234_560);

        Assert.Equal("2026-11-02T20:00:00.123456Z", AuditChain.FormatTimestamp(local));
    }

    [Fact]
    public void Verify_accepts_an_intact_chain()
    {
        var chain = BuildChain(3);

        var result = AuditChain.Verify(chain);

        Assert.True(result.IsValid);
        Assert.Equal(3L, result.EventCount);
        Assert.Equal(chain[^1].Hash, result.HeadHash);
    }

    [Fact]
    public void Verify_accepts_an_empty_chain()
    {
        var result = AuditChain.Verify([]);

        Assert.True(result.IsValid);
        Assert.Equal(AuditChain.GenesisHash, result.HeadHash);
    }

    [Fact]
    public void Verify_detects_an_edited_payload()
    {
        var chain = BuildChain(3);
        chain[1] = chain[1] with { Payload = """{"n":999}""" };

        var result = AuditChain.Verify(chain);

        Assert.False(result.IsValid);
        Assert.Equal(2L, result.BrokenAtSeq);
        Assert.Equal("hash does not match contents", result.Problem);
    }

    [Fact]
    public void Verify_detects_a_rehashed_event_because_the_next_link_breaks()
    {
        var chain = BuildChain(3);
        var forged = chain[1] with { Payload = """{"n":999}""" };
        chain[1] = forged with { Hash = AuditChain.ComputeHash(forged.PrevHash, forged.Seq, forged.At, forged.RunId, forged.Type, forged.Payload) };

        var result = AuditChain.Verify(chain);

        Assert.False(result.IsValid);
        Assert.Equal(3L, result.BrokenAtSeq);
        Assert.Equal("prev_hash does not match previous event", result.Problem);
    }

    [Fact]
    public void Verify_detects_a_deleted_event()
    {
        var chain = BuildChain(3);
        chain.RemoveAt(1);

        var result = AuditChain.Verify(chain);

        Assert.False(result.IsValid);
        Assert.Equal(3L, result.BrokenAtSeq);
    }

    private static List<AuditEvent> BuildChain(int count)
    {
        var events = new List<AuditEvent>();
        var prev = AuditChain.GenesisHash;
        for (var seq = 1; seq <= count; seq++)
        {
            var at = T0.AddSeconds(seq);
            var payload = CanonicalJson.Serialize(new { n = seq });
            var hash = AuditChain.ComputeHash(prev, seq, at, null, "test.event", payload);
            events.Add(new AuditEvent(seq, at, null, "test.event", payload, prev, hash));
            prev = hash;
        }

        return events;
    }
}
