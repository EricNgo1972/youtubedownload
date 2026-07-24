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
/// </summary>
public class DownloadJobService : BackgroundService
{
    private readonly YoutubeDownloadService _downloader;
    private readonly ILogger<DownloadJobService> _logger;
    private readonly Channel<DownloadJob> _queue = Channel.CreateUnbounded<DownloadJob>();
    private readonly ConcurrentDictionary<string, DownloadJob> _jobs = new();

    public DownloadJobService(YoutubeDownloadService downloader, ILogger<DownloadJobService> logger)
    {
        _downloader = downloader;
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

    public void Cancel(string id)
    {
        if (_jobs.TryGetValue(id, out var job) && job.IsActive)
            job.Cts.Cancel();
    }

    public void ClearFinished()
    {
        foreach (var job in _jobs.Values.Where(j => !j.IsActive).ToList())
            _jobs.TryRemove(job.Id, out _);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var job in _queue.Reader.ReadAllAsync(stoppingToken))
            await RunAsync(job, stoppingToken);
    }

    private async Task RunAsync(DownloadJob job, CancellationToken stoppingToken)
    {
        // Cancel on either app shutdown or an explicit user cancel.
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, job.Cts.Token);

        job.Status = JobStatus.Running;
        job.Stage = "Starting…";

        var progress = new Progress<DownloadProgress>(p =>
        {
            job.Stage = p.Stage;
            job.Percent = (int)Math.Round(p.Percent * 100);
        });

        try
        {
            var records = await _downloader.DownloadAsync(job.Url, job.Options, progress, linked.Token);
            job.RecordIds.AddRange(records.Select(r => r.Id));
            job.Percent = 100;
            job.Status = JobStatus.Completed;
            job.Stage = $"Completed — {records.Count} item{(records.Count == 1 ? "" : "s")}";
        }
        catch (OperationCanceledException)
        {
            job.Status = JobStatus.Cancelled;
            job.Stage = "Cancelled";
        }
        catch (Exception ex)
        {
            job.Status = JobStatus.Failed;
            job.Error = ex.Message;
            job.Stage = "Failed";
            _logger.LogError(ex, "Download job {JobId} failed", job.Id);
        }
        finally
        {
            job.FinishedAt = DateTimeOffset.Now;
        }
    }
}
