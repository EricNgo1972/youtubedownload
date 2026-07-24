namespace YoutubeDownloader.Models;

public enum JobStatus { Queued, Running, Completed, Failed, Cancelled, Paused }

/// <summary>What the user asked to happen to a currently-running item, picked up
/// when its cancellation fires so the worker knows whether to pause or cancel it.</summary>
public enum ItemAction { None, Cancel, Pause }

/// <summary>One video within a job — a playlist has many, a single download has one.
/// Carries its own status/percent so the UI can list every item and its progress,
/// plus its own cancellation so it can be paused/cancelled independently.</summary>
public class DownloadItem
{
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public required string VideoId { get; init; }
    public string Title { get; set; } = "";
    public JobStatus Status { get; set; } = JobStatus.Queued;
    public string Stage { get; set; } = "Queued";
    public int Percent { get; set; }
    public string? Error { get; set; }
    public string? RecordId { get; set; }

    /// <summary>True when this video was already in the library and skipped (not re-downloaded).</summary>
    public bool Skipped { get; set; }

    /// <summary>Set by Restart so the skip-already-downloaded check is bypassed once.</summary>
    public bool ForceRedownload { get; set; }

    /// <summary>Pending user intent for the running item (cancel vs pause).</summary>
    public ItemAction Pending { get; set; }

    /// <summary>Cancels just this item while it runs; null when not running.</summary>
    public CancellationTokenSource? Cts { get; set; }

    public bool IsActive => Status is JobStatus.Queued or JobStatus.Running or JobStatus.Paused;
}

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

    /// <summary>Folder items are written to; resolved once, reused across re-runs.</summary>
    public string OutputDir { get; set; } = "";

    /// <summary>History record ids produced by this job (one per video).</summary>
    public List<string> RecordIds { get; } = new();

    /// <summary>Every video this job will download, listed up front (playlist) so the
    /// UI can show queuing → downloading → completed per item.</summary>
    public List<DownloadItem> Items { get; } = new();

    /// <summary>True once resolved to more than one video (a playlist).</summary>
    public bool IsPlaylist { get; set; }

    /// <summary>Whole-job cancellation. Replaced on re-run if a prior run cancelled it.</summary>
    public CancellationTokenSource Cts { get; set; } = new();

    public bool IsActive => Status is JobStatus.Queued or JobStatus.Running or JobStatus.Paused;
}
