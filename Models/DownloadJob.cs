namespace YoutubeDownloader.Models;

public enum JobStatus { Queued, Running, Completed, Failed, Cancelled }

/// <summary>
/// A server-side download task. Lives in the hosted worker, not the browser
/// circuit — so closing the tab does not cancel it.
/// </summary>
public class DownloadJob
{
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public required string Url { get; init; }
    public required DownloadOptions Options { get; init; }

    public JobStatus Status { get; set; } = JobStatus.Queued;
    public string Stage { get; set; } = "Queued";
    public int Percent { get; set; }
    public string? Error { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }

    /// <summary>History record ids produced by this job (one per video).</summary>
    public List<string> RecordIds { get; } = new();

    public CancellationTokenSource Cts { get; } = new();

    public bool IsActive => Status is JobStatus.Queued or JobStatus.Running;
}
