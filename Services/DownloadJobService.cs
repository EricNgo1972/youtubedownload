using System.Collections.Concurrent;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using YoutubeDownloader.Models;

namespace YoutubeDownloader.Services;

/// <summary>
/// Runs downloads on a server-side queue, one at a time, in a hosted background
/// worker. Jobs are decoupled from the browser: closing the tab leaves them
/// running; the UI just polls <see cref="All"/> for status.
///
/// Each job holds an ordered list of items (videos). Items can be paused,
/// cancelled or restarted individually; resuming/restarting re-enqueues the job
/// so the worker picks the item up again.
/// </summary>
public class DownloadJobService : BackgroundService
{
    private readonly YoutubeDownloadService _downloader;
    private readonly HistoryService _history;
    private readonly ILogger<DownloadJobService> _logger;
    private readonly Channel<DownloadJob> _queue = Channel.CreateUnbounded<DownloadJob>();
    private readonly ConcurrentDictionary<string, DownloadJob> _jobs = new();

    public DownloadJobService(YoutubeDownloadService downloader, HistoryService history, ILogger<DownloadJobService> logger)
    {
        _downloader = downloader;
        _history = history;
        _logger = logger;
    }

    /// <summary>Queues a download and returns immediately.</summary>
    public DownloadJob Enqueue(string url, DownloadOptions options)
    {
        var job = new DownloadJob
        {
            Url = url,
            Options = options,
            CreatedAt = DateTimeOffset.Now,
        };
        _jobs[job.Id] = job;
        _queue.Writer.TryWrite(job);
        return job;
    }

    public IReadOnlyList<DownloadJob> All() =>
        _jobs.Values.OrderByDescending(j => j.CreatedAt).ToList();

    /// <summary>Cancels a whole job (every remaining item).</summary>
    public void Cancel(string id)
    {
        if (!_jobs.TryGetValue(id, out var job) || !job.IsActive) return;
        job.Cts.Cancel();

        // A paused job has no worker on it, so cancel its items here and now.
        if (job.Status == JobStatus.Paused)
        {
            foreach (var it in job.Items.Where(it => it.Status is JobStatus.Queued or JobStatus.Paused))
            {
                it.Status = JobStatus.Cancelled;
                it.Stage = "Cancelled";
            }
            job.Status = JobStatus.Cancelled;
            job.Stage = "Cancelled";
            job.FinishedAt = DateTimeOffset.Now;
        }
    }

    public void ClearFinished()
    {
        foreach (var job in _jobs.Values.Where(j => !j.IsActive).ToList())
            _jobs.TryRemove(job.Id, out _);
    }

    // ---- per-item controls -------------------------------------------------

    /// <summary>Pauses an item. A running item stops now and can be resumed later
    /// (re-downloaded from the start); a queued item just won't start.</summary>
    public void PauseItem(string jobId, string itemId) => WithItem(jobId, itemId, (job, item) =>
    {
        if (item.Status == JobStatus.Running)
        {
            item.Pending = ItemAction.Pause;
            item.Cts?.Cancel();
        }
        else if (item.Status == JobStatus.Queued)
        {
            item.Status = JobStatus.Paused;
            item.Stage = "Paused";
        }
    });

    /// <summary>Resumes a paused item back into the queue.</summary>
    public void ResumeItem(string jobId, string itemId) => WithItem(jobId, itemId, (job, item) =>
    {
        if (item.Status != JobStatus.Paused) return;
        item.Status = JobStatus.Queued;
        item.Stage = "Queued";
        item.Percent = 0;
        Requeue(job);
    });

    /// <summary>Cancels a single item (skips it). A running item stops and is cleaned up.</summary>
    public void CancelItem(string jobId, string itemId) => WithItem(jobId, itemId, (job, item) =>
    {
        if (item.Status == JobStatus.Running)
        {
            item.Pending = ItemAction.Cancel;
            item.Cts?.Cancel();
        }
        else if (item.Status is JobStatus.Queued or JobStatus.Paused)
        {
            item.Status = JobStatus.Cancelled;
            item.Stage = "Cancelled";
            item.Percent = 0;
        }
    });

    /// <summary>Re-downloads a finished item, replacing any library record it produced.</summary>
    public void RestartItem(string jobId, string itemId) => WithItem(jobId, itemId, (job, item) =>
    {
        if (item.Status is not (JobStatus.Completed or JobStatus.Failed or JobStatus.Cancelled)) return;

        if (item.RecordId is { } rid)
        {
            _ = _history.RemoveAsync(rid);   // fresh download replaces it
            job.RecordIds.Remove(rid);
        }
        item.RecordId = null;
        item.Skipped = false;
        item.Error = null;
        item.Percent = 0;
        item.ForceRedownload = true;   // bypass skip-already-downloaded once
        item.Status = JobStatus.Queued;
        item.Stage = "Queued";
        Requeue(job);
    });

    private void WithItem(string jobId, string itemId, Action<DownloadJob, DownloadItem> action)
    {
        if (!_jobs.TryGetValue(jobId, out var job)) return;
        var item = job.Items.FirstOrDefault(it => it.Id == itemId);
        if (item is not null) action(job, item);
    }

    /// <summary>Puts an active-again job back on the worker queue. Duplicate entries are
    /// harmless: the worker runs a job's items to completion each pass, so an extra pass
    /// with nothing queued is a quick no-op.</summary>
    private void Requeue(DownloadJob job)
    {
        job.FinishedAt = null;
        // A prior whole-job cancel leaves the token tripped; a fresh run needs a fresh one.
        if (job.Cts.IsCancellationRequested)
            job.Cts = new CancellationTokenSource();
        job.Status = JobStatus.Running;
        _queue.Writer.TryWrite(job);
    }

    // ---- worker ------------------------------------------------------------

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var job in _queue.Reader.ReadAllAsync(stoppingToken))
            await RunAsync(job, stoppingToken);
    }

    private async Task RunAsync(DownloadJob job, CancellationToken stoppingToken)
    {
        // Cancel on either app shutdown or an explicit whole-job cancel.
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, job.Cts.Token);

        try
        {
            // Phase 1: resolve the URL into the full item list — once per job.
            if (job.Items.Count == 0)
            {
                job.Status = JobStatus.Running;
                job.Stage = "Fetching item list…";
                var plan = await _downloader.ResolveAsync(job.Url, job.Options, linked.Token);
                job.IsPlaylist = plan.Videos.Count > 1;
                job.OutputDir = plan.OutputDir;
                foreach (var v in plan.Videos)
                    job.Items.Add(new DownloadItem { VideoId = v.VideoId, Title = v.Title });
                if (job.Items.Count == 0)
                    throw new InvalidOperationException("Nothing to download for that URL.");
            }

            // Phase 2: run queued items in order until none are left runnable.
            while (true)
            {
                linked.Token.ThrowIfCancellationRequested();

                var item = job.Items.FirstOrDefault(it => it.Status == JobStatus.Queued);
                if (item is null) break;   // rest are terminal or paused
                var idx = job.Items.IndexOf(item);

                // Skip videos already in the library, unless Restart forced a redownload.
                if (job.IsPlaylist && !item.ForceRedownload &&
                    _history.FirstByVideoId(item.VideoId) is { } existing)
                {
                    item.Skipped = true;
                    item.Status = JobStatus.Completed;
                    item.Stage = "Already in library";
                    item.Percent = 100;
                    item.RecordId = existing.Id;
                    if (string.IsNullOrWhiteSpace(item.Title)) item.Title = existing.Title;
                    if (!job.RecordIds.Contains(existing.Id)) job.RecordIds.Add(existing.Id);
                    continue;
                }

                item.Cts = new CancellationTokenSource();
                using var itemLinked = CancellationTokenSource.CreateLinkedTokenSource(linked.Token, item.Cts.Token);

                item.Status = JobStatus.Running;
                item.Pending = ItemAction.None;
                item.Stage = "Starting…";
                job.Status = JobStatus.Running;
                job.Stage = job.IsPlaylist ? $"Downloading {idx + 1} of {job.Items.Count}" : "Downloading";
                job.Percent = OverallPercent(job);

                var progress = new Progress<DownloadProgress>(p =>
                {
                    item.Stage = p.Stage;
                    item.Percent = (int)Math.Round(p.Percent * 100);
                });

                try
                {
                    var record = await _downloader.DownloadSingleAsync(
                        item.VideoId, job.Options, job.OutputDir, progress, itemLinked.Token);
                    item.RecordId = record.Id;
                    if (string.IsNullOrWhiteSpace(item.Title)) item.Title = record.Title;
                    item.Percent = 100;
                    item.Status = JobStatus.Completed;
                    item.Stage = "Completed";
                    item.ForceRedownload = false;
                    if (!job.RecordIds.Contains(record.Id)) job.RecordIds.Add(record.Id);
                }
                catch (OperationCanceledException)
                {
                    // A whole-job cancel or app shutdown propagates; a per-item stop doesn't.
                    if (linked.Token.IsCancellationRequested) throw;

                    item.Status = item.Pending == ItemAction.Pause ? JobStatus.Paused : JobStatus.Cancelled;
                    item.Stage = item.Pending == ItemAction.Pause ? "Paused" : "Cancelled";
                    item.Percent = 0;
                    item.Pending = ItemAction.None;
                }
                catch (Exception ex)
                {
                    // Skip a bad video but keep going through the rest of the playlist.
                    item.Status = JobStatus.Failed;
                    item.Stage = "Failed";
                    item.Error = ex.Message;
                    _logger.LogError(ex, "Item {VideoId} in job {JobId} failed", item.VideoId, job.Id);
                }
                finally
                {
                    item.Cts?.Dispose();
                    item.Cts = null;
                }
            }

            Finalize(job);
        }
        catch (OperationCanceledException)
        {
            if (stoppingToken.IsCancellationRequested) return;   // app shutting down; leave state

            foreach (var it in job.Items.Where(it => it.Status is JobStatus.Queued or JobStatus.Running or JobStatus.Paused))
            {
                it.Status = JobStatus.Cancelled;
                it.Stage = "Cancelled";
            }
            job.Status = JobStatus.Cancelled;
            job.Stage = "Cancelled";
            job.FinishedAt = DateTimeOffset.Now;
        }
        catch (Exception ex)
        {
            job.Status = JobStatus.Failed;
            job.Error = ex.Message;
            job.Stage = "Failed";
            job.FinishedAt = DateTimeOffset.Now;
            _logger.LogError(ex, "Download job {JobId} failed", job.Id);
        }
    }

    /// <summary>Sets the job's terminal (or paused) state from its items' outcomes.</summary>
    private static void Finalize(DownloadJob job)
    {
        // Any paused item keeps the whole job alive so it can be resumed.
        if (job.Items.Any(it => it.Status == JobStatus.Paused))
        {
            job.Status = JobStatus.Paused;
            job.Stage = "Paused — resume to continue";
            return;
        }

        var done = job.Items.Count(it => it.Status == JobStatus.Completed && !it.Skipped);
        var skipped = job.Items.Count(it => it.Skipped);
        var failed = job.Items.Count(it => it.Status == JobStatus.Failed);
        var cancelled = job.Items.Count(it => it.Status == JobStatus.Cancelled);

        job.Percent = 100;
        job.FinishedAt = DateTimeOffset.Now;

        if (done == 0 && skipped == 0)
        {
            if (failed == 0 && cancelled > 0)
            {
                job.Status = JobStatus.Cancelled;
                job.Stage = "Cancelled";
            }
            else
            {
                job.Status = JobStatus.Failed;
                job.Error = "Every item failed to download.";
                job.Stage = "Failed";
            }
            return;
        }

        job.Status = JobStatus.Completed;
        if (job.IsPlaylist)
        {
            var parts = new List<string> { $"{done} downloaded" };
            if (skipped > 0) parts.Add($"{skipped} already in library");
            if (failed > 0) parts.Add($"{failed} failed");
            if (cancelled > 0) parts.Add($"{cancelled} cancelled");
            job.Stage = "Completed — " + string.Join(", ", parts);
        }
        else
        {
            job.Stage = "Completed";
        }
    }

    private static int OverallPercent(DownloadJob job)
    {
        if (job.Items.Count == 0) return 0;
        var settled = job.Items.Count(it => it.Status is JobStatus.Completed or JobStatus.Failed or JobStatus.Cancelled);
        return (int)(100.0 * settled / job.Items.Count);
    }
}
