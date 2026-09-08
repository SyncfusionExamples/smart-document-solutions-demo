using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;

namespace Syncfusion.SmartDocumentSolutions.Services;

/// <summary>
/// Centralises every per-user file path used by the Claim Intake
/// pipeline. The previous implementation scattered
/// <c>Path.Combine(_environment.WebRootPath, "uploads", ...)</c>
/// across the controller, which had three problems on Azure App
/// Service (Windows, zip-deploy):
///
///  1. <c>wwwroot</c> lives inside the deployment package. Every
///     zip-deploy wipes the user's uploaded PDFs.
///  2. The per-session folder name was derived from
///     <c>HttpContext.Session.Id</c>, which is null on the very
///     first request before the session middleware has run, and
///     which can change if the session cookie is lost.
///  3. The on-disk path was re-derived on every endpoint, so a
///     single typo (or a different culture's
///     <c>Path.DirectorySeparatorChar</c>) could make the
///     "select-template" write and the "run" read disagree about
///     where the file lives.
///
/// This service fixes all three by:
///   * Storing every per-user file under
///     <c>%HOME%\Data\Uploads\&lt;sessionKey&gt;\</c> on Azure
///     App Service (which survives restarts and zip-deploys),
///     falling back to <c>App_Data\Uploads\&lt;sessionKey&gt;\</c>
///     when <c>%HOME%</c> is not set (local dev / IIS Express).
///   * Deriving the per-session key from a stable cookie
///     (<c>ci_session</c>) that we own ourselves, so the
///     per-user directory is the same across restarts and
///     different from any other user's.
///   * Exposing a single API (<see cref="GetSessionRoot"/>,
///     <see cref="GetSessionRelativeUrl"/>, etc.) that the
///     controller uses for every disk read/write.
///
/// The web-facing URL contract is unchanged: the browser still
/// fetches <c>/api/claim-intake/preview/{fileName}</c> via the
/// controller, which in turn reads the file through this
/// service. That keeps the existing <c>Upload.cshtml</c>
/// JavaScript untouched.
/// </summary>
public class PerSessionFileStore
{
    public const string SessionCookieName = "ci_session";

    // Reserved sub-folder under each session directory. Anything
    // that the pipeline generates (searchable PDF, redacted PDF)
    // lives here so the Clear endpoint can wipe just the generated
    // artefacts without touching the user's original upload.
    public const string GeneratedSubFolder = "generated";

    private readonly IWebHostEnvironment _environment;
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly IConfiguration _configuration;
    private readonly ILogger<PerSessionFileStore> _logger;

    public static readonly string SessionLifetimeConfigKey = "Session:LifetimeHours";
    public PerSessionFileStore(
        IWebHostEnvironment environment,
        IHttpContextAccessor httpContextAccessor,
        IConfiguration configuration,
        ILogger<PerSessionFileStore> logger)
    {
        _environment = environment;
        _httpContextAccessor = httpContextAccessor;
        _configuration = configuration;
        _logger = logger;
    }

    /// <summary>
    /// Reads <c>Session:LifetimeHours</c> from configuration and
    /// returns it as a <see cref="TimeSpan"/>. Falls back to
    /// 2 hours when the value is missing or unparseable. This is
    /// the single source of truth for both the <c>ci_session</c>
    /// cookie lifetime and the sliding expiry baked into the
    /// client-side packet in <c>claimIntake.js</c>.
    /// </summary>
    public TimeSpan SessionLifetime
    {
        get
        {
            var raw = _configuration[SessionLifetimeConfigKey];
            if (!string.IsNullOrWhiteSpace(raw) &&
                double.TryParse(raw, System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out var hours) &&
                hours > 0)
            {
                return TimeSpan.FromHours(hours);
            }
            return TimeSpan.FromHours(2);
        }
    }
    /// <summary>
    /// Absolute on-disk path of the persistent uploads root.
    /// Created on first use. Identical for the lifetime of the
    /// process so concurrent requests do not race against
    /// directory creation.
    /// </summary>
    public string UploadsRoot
    {
        get
        {
            var root = ResolveUploadsRoot();
            Directory.CreateDirectory(root);
            return root;
        }
    }

    /// <summary>
    /// On-disk directory used by the current request to read /
    /// write that request's per-session artefacts. Auto-created.
    /// </summary>
    public string GetSessionRoot()
    {
        var key = GetOrCreateSessionKey();
        var path = Path.Combine(UploadsRoot, key);
        Directory.CreateDirectory(path);
        Directory.CreateDirectory(Path.Combine(path, GeneratedSubFolder));
        return path;
    }

    /// <summary>
    /// Force the current request to operate under an explicit
    /// per-session key. Caches the key on HttpContext.Items and
    /// (best-effort) writes the outbound ci_session cookie. Lets
    /// parallel /upload-by-template calls land in the same
    /// per-session folder.
    /// </summary>
    public string AdoptSessionKey(string explicitKey)
    {
        if (string.IsNullOrWhiteSpace(explicitKey) || !IsValidSessionKey(explicitKey))
        {
            // Invalid key - fall through to the normal path.
            return GetSessionRoot();
        }

        var ctx = _httpContextAccessor.HttpContext;
        if (ctx is not null)
        {
            // Cache the key for the rest of this request.
            ctx.Items[SessionCookieName] = explicitKey;

            // Cookie write is best-effort. If the response has
            // already started, Response.Cookies.Append throws
            // and the exception unwinds out of the controller,
            // which is what was producing the 502 on the live
            // site. The in-request cache above is enough to
            // resolve the current request.
            if (!ctx.Response.HasStarted)
            {
                try
                {
                    ctx.Response.Cookies.Append(
                        SessionCookieName,
                        explicitKey,
                        new CookieOptions
                        {
                            HttpOnly = true,
                            SameSite = SameSiteMode.Lax,
                            Secure = IsSecureRequest(ctx),
                            MaxAge = SessionLifetime,
                            Path = "/",
                            IsEssential = true
                        });
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(
                        ex,
                        "AdoptSessionKey could not write the ci_session cookie. Continuing with the in-request cache.");
                }
            }
        }
        else
        {
            _logger.LogWarning("AdoptSessionKey invoked without an HttpContext. Using the explicit key but not setting cookies.");
        }

        var path = Path.Combine(UploadsRoot, explicitKey);
        Directory.CreateDirectory(path);
        Directory.CreateDirectory(Path.Combine(path, GeneratedSubFolder));
        return path;
    }

    /// <summary>
    /// The session key the current request is operating under,
    /// or null if no inbound ci_session cookie is present.
    /// </summary>
    public string? InboundSessionKey
    {
        get
        {
            var ctx = _httpContextAccessor.HttpContext;
            if (ctx is null)
            {
                return null;
            }

            if (ctx.Items.TryGetValue(SessionCookieName, out var cached) && cached is string cachedKey)
            {
                return cachedKey;
            }

            if (ctx.Request.Cookies.TryGetValue(SessionCookieName, out var existing) &&
                !string.IsNullOrWhiteSpace(existing) &&
                IsValidSessionKey(existing))
            {
                return existing;
            }

            return null;
        }
    }

    /// <summary>
    /// Web-relative URL the front-end can use to fetch a file
    /// from the current session's directory. The browser will
    /// call <c>GET /api/claim-intake/preview/{fileName}</c> which
    /// the controller will resolve through this same service.
    /// </summary>
    public string GetSessionRelativeUrl(string fileName)
    {
        var key = GetOrCreateSessionKey();
        var safe = SanitizeFileName(fileName);
        return $"/uploads/{key}/{safe}";
    }

    /// <summary>
    /// Returns the absolute on-disk path for a per-session file,
    /// or <c>null</c> if the supplied web-relative URL is not
    /// owned by the current session (i.e. it is either outside
    /// the uploads root or it belongs to a different session).
    /// This is the security boundary the controller uses to make
    /// sure one user cannot fetch another user's PDFs.
    /// </summary>
    public string? ResolveSessionFile(string webRelativeUrl)
    {
        if (string.IsNullOrWhiteSpace(webRelativeUrl))
        {
            return null;
        }

        // Normalise: drop query / fragment, trim leading slash,
        // accept both forward and back-slashes.
        var path = webRelativeUrl
            .Replace('\\', '/')
            .TrimStart('/');
        var queryIndex = path.IndexOf('?', StringComparison.Ordinal);
        if (queryIndex >= 0)
        {
            path = path[..queryIndex];
        }

        // The URL must start with /uploads/<sessionKey>/...
        const string prefix = "uploads/";
        if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var afterPrefix = path[prefix.Length..];
        var slashIndex = afterPrefix.IndexOf('/');
        if (slashIndex <= 0)
        {
            return null;
        }

        var urlKey = afterPrefix[..slashIndex];
        var currentKey = GetOrCreateSessionKey();
        if (!string.Equals(urlKey, currentKey, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var tail = afterPrefix[(slashIndex + 1)..];
        var absolute = Path.Combine(UploadsRoot, urlKey, tail.Replace('/', Path.DirectorySeparatorChar));
        var normalized = Path.GetFullPath(absolute);
        var rootWithSep = UploadsRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!normalized.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        return normalized;
    }

    /// <summary>
    /// Companion to AdoptSessionKey. Resolves a web-relative
    /// previewUrl against an EXPLICIT session key instead of
    /// the inbound ci_session cookie. Returns null if the URL
    /// is malformed, the key is invalid, the URL is for a
    /// different session, or the file does not exist.
    /// </summary>
    public string? ResolveSessionFileForKey(string? explicitKey, string webRelativeUrl)
    {
        if (string.IsNullOrWhiteSpace(explicitKey) || !IsValidSessionKey(explicitKey))
        {
            return null;
        }
        if (string.IsNullOrWhiteSpace(webRelativeUrl))
        {
            return null;
        }

        var path = webRelativeUrl
            .Replace('\\', '/')
            .TrimStart('/');
        var queryIndex = path.IndexOf('?', StringComparison.Ordinal);
        if (queryIndex >= 0)
        {
            path = path[..queryIndex];
        }

        const string prefix = "uploads/";
        if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var afterPrefix = path[prefix.Length..];
        var slashIndex = afterPrefix.IndexOf('/');
        if (slashIndex <= 0)
        {
            return null;
        }

        var urlKey = afterPrefix[..slashIndex];
        if (!string.Equals(urlKey, explicitKey, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var tail = afterPrefix[(slashIndex + 1)..];
        var absolute = Path.Combine(UploadsRoot, urlKey, tail.Replace('/', Path.DirectorySeparatorChar));
        var normalized = Path.GetFullPath(absolute);
        var rootWithSep = UploadsRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!normalized.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        return System.IO.File.Exists(normalized) ? normalized : null;
    }

    /// <summary>
    /// Look up an uploaded file on disk for the current session,
    /// even when the ASP.NET session cache was wiped (e.g. an
    /// Azure recycle between "Choose" and "Run"). The file is
    /// only returned when it actually exists so the controller
    /// can fall back to a "Please choose the template first"
    /// response if nothing is on disk.
    /// </summary>
    public SessionFileCandidate? FindRecoverableFile()
    {
        var key = GetOrCreateSessionKey();
        var root = Path.Combine(UploadsRoot, key);
        if (!Directory.Exists(root) || IsSessionDirectoryStale(root))
        {
            return null;
        }

        // Prefer the most recent non-generated PDF. Generated
        // artefacts (searchable, redacted) are skipped because
        // they cannot be the "active" input file.
        FileInfo? best = null;
        foreach (var file in Directory.EnumerateFiles(root, "*.pdf", SearchOption.AllDirectories))
        {
            var info = new FileInfo(file);
            if (info.DirectoryName?.EndsWith(GeneratedSubFolder, StringComparison.OrdinalIgnoreCase) == true)
            {
                continue;
            }
            if (best is null || info.LastWriteTimeUtc > best.LastWriteTimeUtc)
            {
                best = info;
            }
        }

        if (best is null)
        {
            return null;
        }

        return new SessionFileCandidate(
            FileName: Path.GetFileName(best.Name),
            AbsolutePath: best.FullName,
            PreviewUrl: $"/uploads/{key}/{best.Name}",
            LastModifiedUtc: best.LastWriteTimeUtc);
    }

    /// <summary>
    /// Same as <see cref="FindRecoverableFile"/> but lets the
    /// caller target a specific per-session directory by key. The
    /// session key is whatever cookie / session id the caller
    /// already has, so the recovery also works on requests where
    /// the session middleware has not yet initialised the
    /// <see cref="HttpContext.Session"/>.
    /// </summary>
    public SessionFileCandidate? FindRecoverableFileForKey(string sessionKey)
    {
        if (string.IsNullOrWhiteSpace(sessionKey))
        {
            return null;
        }

        var safe = SanitizeFileName(sessionKey);
        if (string.IsNullOrWhiteSpace(safe))
        {
            return null;
        }

        var root = Path.Combine(UploadsRoot, safe);
        if (!Directory.Exists(root) || IsSessionDirectoryStale(root))
        {
            return null;
        }

        FileInfo? best = null;
        foreach (var file in Directory.EnumerateFiles(root, "*.pdf", SearchOption.AllDirectories))
        {
            var info = new FileInfo(file);
            if (info.DirectoryName?.EndsWith(GeneratedSubFolder, StringComparison.OrdinalIgnoreCase) == true)
            {
                continue;
            }
            if (best is null || info.LastWriteTimeUtc > best.LastWriteTimeUtc)
            {
                best = info;
            }
        }

        if (best is null)
        {
            return null;
        }

        return new SessionFileCandidate(
            FileName: Path.GetFileName(best.Name),
            AbsolutePath: best.FullName,
            PreviewUrl: $"/uploads/{safe}/{best.Name}",
            LastModifiedUtc: best.LastWriteTimeUtc);
    }

    /// <summary>
    /// Delete every artefact belonging to the current session.
    /// Used by the <c>/api/claim-intake/clear</c> endpoint. Safe
    /// to call when the directory does not exist.
    /// </summary>
    public void PurgeCurrentSession()
    {
        var key = GetOrCreateSessionKey();
        var root = Path.Combine(UploadsRoot, key);
        if (!Directory.Exists(root))
        {
            return;
        }

        try
        {
            Directory.Delete(root, recursive: true);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to purge session directory {Root}", root);
        }
    }

    /// <summary>
    /// Delete only the generated artefacts (searchable PDF,
    /// redacted PDF) for the current session, leaving the
    /// user's original uploads and materialised template
    /// copies in place. Used by the soft-reset
    /// (<c>/api/claim-intake/reset-progress</c>) so the
    /// packet list survives a reset - the user keeps their
    /// default templates and user uploads, but the
    /// per-document extraction / redaction / review state
    /// is cleared.
    /// </summary>
    public void PurgeGeneratedOnly()
    {
        var key = GetOrCreateSessionKey();
        var root = Path.Combine(UploadsRoot, key);
        var generated = Path.Combine(root, GeneratedSubFolder);
        if (!Directory.Exists(generated))
        {
            return;
        }

        try
        {
            Directory.Delete(generated, recursive: true);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to purge generated directory {Generated}", generated);
        }
        // Recreate the empty folder so subsequent pipeline
        // steps (searchable PDF, redacted PDF) do not have
        // to special-case "directory does not exist yet".
        try
        {
            Directory.CreateDirectory(generated);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to recreate generated directory {Generated}", generated);
        }
    }

    /// <summary>
    /// Resolve the persistent uploads root, choosing
    /// <c>%HOME%\Data\Uploads</c> on Azure App Service Windows
    /// and <c>{ContentRoot}\App_Data\Uploads</c> everywhere else.
    /// Both locations survive app restarts and zip deploys.
    /// </summary>
    private string ResolveUploadsRoot()
    {
        var home = Environment.GetEnvironmentVariable("HOME");
        if (!string.IsNullOrWhiteSpace(home))
        {
            return Path.Combine(home, "Data", "Uploads");
        }

        return Path.Combine(_environment.ContentRootPath, "App_Data", "Uploads");
    }

    /// <summary>
    /// Returns the per-session key, creating the backing cookie
    /// if this is the first request we have seen for this user.
    /// The key is a 32-character URL-safe random string, which is
    /// safe to use as a directory name and as a URL segment.
    /// </summary>
    public string GetOrCreateSessionKey()
    {
        var ctx = _httpContextAccessor.HttpContext;
        if (ctx is null)
        {
            // No HttpContext (background work). Fall back to a
            // process-scoped key so the caller does not crash,
            // but log it - this path is only expected during
            // startup or non-request code.
            _logger.LogWarning("PerSessionFileStore invoked without an HttpContext. Falling back to a temporary key.");
            return "no-http-context";
        }

        // Per-request cache. The Request.Cookies collection is
        // a snapshot of the inbound headers - it does not see
        // cookies we add to Response.Cookies within the same
        // request. Without this cache the second call within a
        // single request would generate a brand-new key,
        // causing the upload to write under key A and the
        // URL (returned in the response body) to reference
        // key B - which the next request cannot fetch because
        // the inbound cookie now points at A. Stash the key
        // in HttpContext.Items so every call in the request
        // sees the same value.
        if (ctx.Items.TryGetValue(SessionCookieName, out var cached) && cached is string cachedKey)
        {
            return cachedKey;
        }

        if (ctx.Request.Cookies.TryGetValue(SessionCookieName, out var existing) &&
            !string.IsNullOrWhiteSpace(existing) &&
            IsValidSessionKey(existing))
        {
            ctx.Items[SessionCookieName] = existing;
            return existing;
        }

        var key = GenerateSessionKey();
        ctx.Items[SessionCookieName] = key;
        ctx.Response.Cookies.Append(
            SessionCookieName,
            key,
            new CookieOptions
            {
                HttpOnly = true,
                SameSite = SameSiteMode.Lax,
                // Use IsSecureRequest so the Secure flag is set correctly
                // behind TLS-terminating reverse proxies (AWS CloudFront,
                // Azure Front Door) even when UseForwardedHeaders has not
                // yet processed the X-Forwarded-Proto header. Without this
                // the cookie would be Secure=false on HTTPS pages and the
                // browser would silently drop it, causing every request to
                // start a new session.
                Secure = IsSecureRequest(ctx),
                MaxAge = SessionLifetime,
                Path = "/",
                IsEssential = true
            });
        return key;
    }

    /// <summary>
    /// Returns <c>true</c> when the connection that produced this
    /// request is HTTPS. Checks <c>Request.IsHttps</c> first (set
    /// by <c>UseForwardedHeaders</c> when the middleware is wired
    /// up), then falls back to reading <c>X-Forwarded-Proto</c>
    /// directly so the <c>Secure</c> cookie flag is correct even
    /// when the ForwardedHeaders middleware is absent or the proxy
    /// doesn't send a processed value — specifically AWS CloudFront
    /// TLS termination.
    /// </summary>
    private static bool IsSecureRequest(HttpContext context)
    {
        if (context.Request.IsHttps)
            return true;

        var proto = context.Request.Headers["X-Forwarded-Proto"].FirstOrDefault() ?? string.Empty;
        return string.Equals(proto.Trim(), "https", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsValidSessionKey(string candidate)
    {
        if (string.IsNullOrWhiteSpace(candidate) || candidate.Length < 16 || candidate.Length > 128)
        {
            return false;
        }
        foreach (var c in candidate)
        {
            var ok = (c >= '0' && c <= '9') ||
                     (c >= 'a' && c <= 'z') ||
                     (c >= 'A' && c <= 'Z') ||
                     c == '-' || c == '_';
            if (!ok)
            {
                return false;
            }
        }
        return true;
    }

    private static string GenerateSessionKey()
    {
        Span<byte> buffer = stackalloc byte[24];
        System.Security.Cryptography.RandomNumberGenerator.Fill(buffer);
        // URL-safe base64 without padding.
        return Convert.ToBase64String(buffer)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
    }

    private static bool IsSessionDirectoryStale(string root)
    {
        if (!Directory.Exists(root))
        {
            return true;
        }

        var age = DateTime.UtcNow - Directory.GetLastWriteTimeUtc(root);
        return age > TimeSpan.FromMinutes(15);
    }

    private static string SanitizeFileName(string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName))
        {
            return string.Empty;
        }

        // Strip any path the caller might have smuggled in.
        var justName = Path.GetFileName(fileName);
        if (string.IsNullOrWhiteSpace(justName))
        {
            return string.Empty;
        }

        foreach (var c in Path.GetInvalidFileNameChars())
        {
            justName = justName.Replace(c, '_');
        }
        return justName;
    }
}

public sealed record SessionFileCandidate(
    string FileName,
    string AbsolutePath,
    string PreviewUrl,
    DateTime LastModifiedUtc);
