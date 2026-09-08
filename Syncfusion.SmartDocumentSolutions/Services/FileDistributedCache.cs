using Microsoft.Extensions.Caching.Distributed;
using System.Collections.Concurrent;
using System.Text;

namespace Syncfusion.SmartDocumentSolutions.Services;

/// <summary>
/// File-backed persistent session cache for Azure App Service worker recycling.
/// Stores session data to disk so it survives restarts and deployments.
/// </summary>
public class FileDistributedCache : IDistributedCache
{
    private readonly string _root;
    private readonly TimeSpan _defaultSlidingExpiration;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.OrdinalIgnoreCase);

    public FileDistributedCache(string root, TimeSpan? defaultSlidingExpiration = null)
    {
        if (string.IsNullOrWhiteSpace(root))
        {
            throw new ArgumentException("Cache root must be a non-empty path.", nameof(root));
        }

        Directory.CreateDirectory(root);
        _root = root;
        _defaultSlidingExpiration = defaultSlidingExpiration ?? TimeSpan.FromHours(2);
    }

    public byte[]? Get(string key)
    {
        return GetAsync(key).GetAwaiter().GetResult();
    }

    public async Task<byte[]?> GetAsync(string key, CancellationToken token = default)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            return null;
        }

        var path = ResolvePath(key);
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            await using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 4096,
                useAsync: true);
            using var reader = new BinaryReader(stream, Encoding.UTF8, leaveOpen: true);

            // File format: absoluteTicks(int64) | slidingTicks(int64) | dataLength(int32) | data(bytes)
            var absoluteTicks = reader.ReadInt64();
            var slidingTicks = reader.ReadInt64();
            var dataLength = reader.ReadInt32();
            if (dataLength < 0 || dataLength > 64 * 1024 * 1024)
            {
                // Sanity cap: refuse anything obviously corrupt.
                return null;
            }

            var now = DateTime.UtcNow;

            if (absoluteTicks != 0)
            {
                var absolute = new DateTime(Math.Max(0, absoluteTicks), DateTimeKind.Utc);
                if (absolute <= now)
                {
                    TryDeleteFile(path);
                    return null;
                }
            }

            if (slidingTicks != 0)
            {
                var sliding = TimeSpan.FromTicks(slidingTicks);
                var lastWriteUtc = File.GetLastWriteTimeUtc(path);
                if (lastWriteUtc.Add(sliding) <= now)
                {
                    TryDeleteFile(path);
                    return null;
                }
            }

            var data = reader.ReadBytes(dataLength);
            if (data.Length != dataLength)
            {
                // Partial / corrupted file.
                return null;
            }

            // Refresh mtime for sliding expiration window
            try
            {
                File.SetLastWriteTimeUtc(path, now);
            }
            catch
            {
                // Best-effort; a read failure to update mtime is
                // not fatal.
            }

            return data;
        }
        catch
        {
            // Any IO error -> treat as cache miss rather than
            // blowing up the request.
            return null;
        }
    }

    public void Set(string key, byte[] value, DistributedCacheEntryOptions options)
    {
        SetAsync(key, value, options).GetAwaiter().GetResult();
    }

    public async Task SetAsync(string key, byte[] value, DistributedCacheEntryOptions options, CancellationToken token = default)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            return;
        }
        if (value is null)
        {
            value = Array.Empty<byte>();
        }

        var path = ResolvePath(key);
        var tmpPath = path + ".tmp";
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(dir))
        {
            Directory.CreateDirectory(dir);
        }

        var now = DateTime.UtcNow;
        var (absoluteTicks, slidingTicks) = ResolveExpirations(options, now);

        var gate = _locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            await using (var stream = new FileStream(
                tmpPath,
                FileMode.Create,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 4096,
                useAsync: true))
            await using (var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true))
            {
                writer.Write(absoluteTicks);
                writer.Write(slidingTicks);
                writer.Write(value.Length);
                if (value.Length > 0)
                {
                    writer.Write(value);
                }
                await writer.BaseStream.FlushAsync(token).ConfigureAwait(false);
            }

            // Atomic replace prevents partial-write corruption.
            // On Windows, a concurrent reader can briefly hold the destination
            // file open while a new write is being committed. Retry a few times
            // instead of immediately crashing with IOException.
            var committed = false;
            for (var attempt = 1; attempt <= 10; attempt++)
            {
                try
                {
                    if (File.Exists(path))
                    {
                        File.Replace(tmpPath, path, destinationBackupFileName: null);
                    }
                    else
                    {
                        File.Move(tmpPath, path);
                    }

                    committed = true;
                    break;
                }
                catch (IOException) when (attempt < 10)
                {
                    Thread.Sleep(100 * attempt);
                }
            }

            if (!committed)
            {
                // Last-resort fallback: if the destination is temporarily locked,
                // remove it and move the tmp file into place. This keeps the cache
                // writable even when another process has briefly left the old file open.
                try
                {
                    if (File.Exists(path))
                    {
                        File.Delete(path);
                    }

                    File.Move(tmpPath, path);
                }
                catch (IOException)
                {
                    // The cache is best-effort persistence; if the file remains locked,
                    // keep the temp file so a later retry can still recover cleanly.
                    throw;
                }
            }

            try
            {
                File.SetLastWriteTimeUtc(path, now);
            }
            catch
            {
                // ignore - mtime is only used for sliding expiration
            }
        }
        finally
        {
            gate.Release();
        }
    }

    public void Refresh(string key)
    {
        RefreshAsync(key).GetAwaiter().GetResult();
    }

    public async Task RefreshAsync(string key, CancellationToken token = default)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            return;
        }

        var path = ResolvePath(key);
        if (!File.Exists(path))
        {
            return;
        }

        var gate = _locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            File.SetLastWriteTimeUtc(path, DateTime.UtcNow);
        }
        catch
        {
            // ignore
        }
        finally
        {
            gate.Release();
        }
    }

    public void Remove(string key)
    {
        RemoveAsync(key).GetAwaiter().GetResult();
    }

    public Task RemoveAsync(string key, CancellationToken token = default)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            return Task.CompletedTask;
        }

        var path = ResolvePath(key);
        TryDeleteFile(path);
        return Task.CompletedTask;
    }

    private string ResolvePath(string key)
    {
        // Hash key for safe, collision-resistant file naming
        var hash = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(
                Encoding.UTF8.GetBytes(key)));
        return Path.Combine(_root, hash + ".bin");
    }

    private static (long absoluteTicks, long slidingTicks) ResolveExpirations(
        DistributedCacheEntryOptions options,
        DateTime nowUtc)
    {
        long absoluteTicks = 0;
        long slidingTicks = 0;

        if (options.AbsoluteExpiration.HasValue)
        {
            absoluteTicks = options.AbsoluteExpiration.Value.ToUniversalTime().Ticks;
        }
        else if (options.AbsoluteExpirationRelativeToNow.HasValue)
        {
            absoluteTicks = nowUtc.Add(options.AbsoluteExpirationRelativeToNow.Value).Ticks;
        }

        if (options.SlidingExpiration.HasValue)
        {
            slidingTicks = options.SlidingExpiration.Value.Ticks;
        }

        return (absoluteTicks, slidingTicks);
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // Ignore; expired entries clean up naturally
        }
    }
}
