using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Factory.Domain.Audit;

/// <summary>One link in the audit chain, exactly as stored.</summary>
public sealed record AuditEvent(
    long Seq,
    DateTimeOffset At,
    Guid? RunId,
    string Type,
    string Payload,
    string PrevHash,
    string Hash);

/// <summary>Result of walking a chain from its first event.</summary>
public sealed record ChainVerification(
    bool IsValid,
    long EventCount,
    string HeadHash,
    long? BrokenAtSeq,
    string? Problem)
{
    public static ChainVerification Valid(long count, string head) => new(true, count, head, null, null);

    public static ChainVerification Broken(long count, string head, long seq, string problem) =>
        new(false, count, head, seq, problem);
}

/// <summary>
/// The hash-chain formula, mirrored from the <c>audit_hash</c> SQL function in
/// db/migrations/0001_init.sql so exported chains can be verified without the
/// database. Changing either side breaks verification of every existing chain.
/// </summary>
public static class AuditChain
{
    public static readonly string GenesisHash = new('0', 64);

    public static string FormatTimestamp(DateTimeOffset at) =>
        at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture);

    public static string ComputeHash(
        string prevHash, long seq, DateTimeOffset at, Guid? runId, string type, string payload)
    {
        ArgumentNullException.ThrowIfNull(prevHash);
        ArgumentNullException.ThrowIfNull(type);
        ArgumentNullException.ThrowIfNull(payload);

        var input = string.Join(
            '\n',
            prevHash,
            seq.ToString(CultureInfo.InvariantCulture),
            FormatTimestamp(at),
            runId?.ToString("D") ?? string.Empty,
            type,
            payload);

        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(input)));
    }

    /// <summary>
    /// Walks events in order and stops at the first problem: a gap in the
    /// sequence, a broken link to the previous hash, or contents that no
    /// longer match their hash.
    /// </summary>
    public static ChainVerification Verify(IEnumerable<AuditEvent> events)
    {
        ArgumentNullException.ThrowIfNull(events);

        var expectedPrev = GenesisHash;
        long expectedSeq = 1;
        long count = 0;

        foreach (var e in events)
        {
            if (e.Seq != expectedSeq)
            {
                return ChainVerification.Broken(count, expectedPrev, e.Seq, $"expected seq {expectedSeq}");
            }

            if (!string.Equals(e.PrevHash, expectedPrev, StringComparison.Ordinal))
            {
                return ChainVerification.Broken(count, expectedPrev, e.Seq, "prev_hash does not match previous event");
            }

            var recomputed = ComputeHash(e.PrevHash, e.Seq, e.At, e.RunId, e.Type, e.Payload);
            if (!string.Equals(recomputed, e.Hash, StringComparison.Ordinal))
            {
                return ChainVerification.Broken(count, expectedPrev, e.Seq, "hash does not match contents");
            }

            expectedPrev = e.Hash;
            expectedSeq++;
            count++;
        }

        return ChainVerification.Valid(count, expectedPrev);
    }
}
