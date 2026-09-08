using System.Text.Json;
using Syncfusion.SmartDocumentSolutions.Models.BoardPack;
using Syncfusion.SmartDocumentSolutions.Services;

namespace Syncfusion.SmartDocumentSolutions.Services.BoardPack;

/// <summary>
/// File-backed workspace store for the Board Pack demo.
///
/// Session management is fully delegated to
/// <see cref="PerSessionFileStore"/> so Board Pack uses exactly the
/// same <c>ci_session</c> cookie, <c>AdoptSessionKey</c> pattern, and
/// <c>X-Forwarded-Proto</c>-aware <c>Secure</c> flag logic as the
/// Claim Intake and Contract Review demos. This is what makes the
/// three-template initialisation sequence work correctly on AWS
/// CloudFront, where TLS is terminated at the CDN edge.
///
/// Board Pack artefacts are stored in a dedicated sub-folder
/// (<c>board-pack/</c>) inside the shared per-session uploads root
/// so the three demos share one cookie without sharing files:
///   * <c>%HOME%\Data\Uploads\&lt;key&gt;\board-pack\</c> on Azure
///   * <c>App_Data\Uploads\&lt;key&gt;\board-pack\</c> locally
/// </summary>
public class BoardPackWorkspaceStore
{
    // Sub-folder inside the per-session root that Board Pack owns.
    // Separates Board Pack artefacts from Claim Intake / Contract
    // Review files that share the same ci_session directory.
    private const string BoardPackSubFolder = "board-pack";

    public const string WorkspaceFileName = "bp_workspace.json";
    public const string WorkspaceSubFolder = "workspace";
    public const string OfficeSubFolder = "office";
    public const string PdfSubFolder = "pdf";
    public const string GeneratedSubFolder = "generated";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    private readonly PerSessionFileStore _fileStore;
    private readonly ILogger<BoardPackWorkspaceStore> _logger;

    public BoardPackWorkspaceStore(
        PerSessionFileStore fileStore,
        ILogger<BoardPackWorkspaceStore> logger)
    {
        _fileStore = fileStore;
        _logger = logger;
    }

    /// <summary>
    /// Absolute on-disk root for ALL Board Pack sessions.
    /// Board Pack lives under <c>board-pack/</c> inside the shared
    /// per-session uploads root managed by
    /// <see cref="PerSessionFileStore"/>. Using a sub-folder keeps
    /// Board Pack files separate from Claim Intake / Contract Review
    /// artefacts even though all three demos share one
    /// <c>ci_session</c> cookie.
    /// </summary>
    public string UploadsRoot
    {
        get
        {
            var root = Path.Combine(_fileStore.UploadsRoot, BoardPackSubFolder);
            Directory.CreateDirectory(root);
            return root;
        }
    }

    /// <summary>On-disk root for the current request's session.</summary>
    public string GetSessionRoot()
    {
        var key = GetOrCreateSessionKey();
        var root = Path.Combine(UploadsRoot, key);
        EnsureDirectoryTree(root);
        return root;
    }

    /// <summary>Office source uploads for the current session.</summary>
    public string GetOfficeRoot()
    {
        var root = Path.Combine(GetSessionRoot(), OfficeSubFolder);
        Directory.CreateDirectory(root);
        return root;
    }

    /// <summary>Converted PDF cache for the current session.</summary>
    public string GetPdfRoot()
    {
        var root = Path.Combine(GetSessionRoot(), PdfSubFolder);
        Directory.CreateDirectory(root);
        return root;
    }

    /// <summary>Generated outputs (final PDF, ZIP, manifest, ...).</summary>
    public string GetGeneratedRoot()
    {
        var root = Path.Combine(GetSessionRoot(), GeneratedSubFolder);
        Directory.CreateDirectory(root);
        return root;
    }

    /// <summary>Web-relative URL the front-end can use to fetch an Office / PDF preview.</summary>
    public string GetSessionRelativeUrl(string relativeTail)
    {
        var key = GetOrCreateSessionKey();
        var safe = SanitizeTail(relativeTail);
        return $"/uploads/board-pack/{key}/{safe}";
    }

    /// <summary>Resolves a web-relative URL into an absolute on-disk path belonging to the current session.</summary>
    public string? ResolveSessionFile(string webRelativeUrl)
    {
        if (string.IsNullOrWhiteSpace(webRelativeUrl))
        {
            return null;
        }

        var path = webRelativeUrl.Replace('\\', '/').TrimStart('/');
        var queryIndex = path.IndexOf('?', StringComparison.Ordinal);
        if (queryIndex >= 0)
        {
            path = path[..queryIndex];
        }

        const string prefix = "uploads/board-pack/";
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
        var current = GetOrCreateSessionKey();
        if (!string.Equals(urlKey, current, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var tail = afterPrefix[(slashIndex + 1)..];
        var absolute = Path.GetFullPath(Path.Combine(UploadsRoot, urlKey, tail.Replace('/', Path.DirectorySeparatorChar)));
        var rootWithSep = UploadsRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!absolute.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        return System.IO.File.Exists(absolute) ? absolute : null;
    }

    /// <summary>
    /// Loads (or initialises an empty) workspace for the current
    /// session. Follows the same simple async pattern as
    /// <see cref="PerSessionFileStore"/>: no locks, no retry loops.
    /// Returns a fresh workspace when the snapshot file is absent
    /// or unreadable.
    /// </summary>
    public async Task<BoardPackWorkspace> LoadWorkspaceAsync(CancellationToken cancellationToken = default)
    {
        var key = GetOrCreateSessionKey();
        EnsureDirectoryTree(Path.Combine(UploadsRoot, key));

        var workspacePath = Path.Combine(UploadsRoot, key, WorkspaceSubFolder, WorkspaceFileName);
        if (!System.IO.File.Exists(workspacePath))
        {
            return FreshWorkspace(key);
        }

        try
        {
            await using var stream = System.IO.File.OpenRead(workspacePath);
            var snapshot = await JsonSerializer.DeserializeAsync<BoardPackWorkspace>(
                stream, JsonOptions, cancellationToken).ConfigureAwait(false);

            if (snapshot is null)
            {
                return FreshWorkspace(key);
            }

            // Reset transient runtime fields that should never survive
            // a process recycle: a document left in "Converting" state
            // means the conversion request never completed, so flip it
            // back to Waiting so the user can retry.
            foreach (var doc in snapshot.Documents)
            {
                if (doc.Status == BoardPackConversionStatus.Converting)
                {
                    doc.Status = BoardPackConversionStatus.Waiting;
                }
            }

            snapshot.SessionId = key;
            return snapshot;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "Board Pack workspace for session {Key} could not be read; recreating empty workspace.", key);
            return FreshWorkspace(key);
        }
    }

    /// <summary>
    /// Persists <paramref name="workspace"/> to disk so the next
    /// request can read it back. Follows the same simple async
    /// pattern as <see cref="PerSessionFileStore"/>: no locks.
    /// Uses a temp-file + rename so an interrupted write never
    /// leaves a half-written snapshot on disk.
    /// </summary>
    public async Task SaveWorkspaceAsync(BoardPackWorkspace workspace, CancellationToken cancellationToken = default)
    {
        if (workspace is null)
        {
            return;
        }

        workspace.LastModifiedUtc = DateTime.UtcNow;
        if (string.IsNullOrWhiteSpace(workspace.SessionId))
        {
            workspace.SessionId = GetOrCreateSessionKey();
        }

        var directory = Path.Combine(UploadsRoot, workspace.SessionId, WorkspaceSubFolder);
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, WorkspaceFileName);

        // Stage to a temp file then atomically rename so that a
        // concurrent reader never observes a half-written snapshot.
        var tempPath = path + ".tmp";
        await using (var stream = new FileStream(
            tempPath, FileMode.Create, FileAccess.Write, FileShare.Read))
        {
            await JsonSerializer.SerializeAsync(stream, workspace, JsonOptions, cancellationToken)
                .ConfigureAwait(false);
        }

        if (System.IO.File.Exists(path))
        {
            System.IO.File.Replace(tempPath, path, destinationBackupFileName: null);
        }
        else
        {
            System.IO.File.Move(tempPath, path);
        }
    }

    /// <summary>
    /// Removes every file and folder owned by <paramref name="sessionKey"/>.
    /// Used by the Reset button so the user can start a new pack
    /// without leaving stale Office / PDF artefacts on disk.
    /// </summary>
    public void PurgeSession(string sessionKey)
    {
        if (string.IsNullOrWhiteSpace(sessionKey))
        {
            return;
        }

        var path = Path.Combine(UploadsRoot, sessionKey);
        if (Directory.Exists(path))
        {
            try
            {
                Directory.Delete(path, recursive: true);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Unable to fully purge Board Pack session directory at {Path}.", path);
            }
        }

        // The controller always serves per-session files via
        // /uploads/board-pack/{key}/... and expires the ci_session
        // cookie on the response. This helper is a no-op for the
        // cookie itself — the controller does that to keep the
        // store HTTP-agnostic.
    }

    /// <summary>
    /// The on-disk directory used by the current request, used by
    /// the controller helper that resolves preview URLs.
    /// </summary>
    public string GetUploadsRoot() => UploadsRoot;

    /// <summary>
    /// Build an absolute file-system path for an uploaded Office
    /// document. Returned path is guaranteed to live inside the
    /// session's <c>office/</c> folder.
    /// </summary>
    public string GetOfficeFilePath(string storedFileName)
    {
        var safe = SanitizeTail(storedFileName);
        return Path.Combine(GetOfficeRoot(), safe);
    }

    /// <summary>Absolute path for the converted PDF counterpart of an Office document.</summary>
    public string GetPdfFilePath(string storedFileName)
    {
        var safe = SanitizeTail(storedFileName);
        return Path.Combine(GetPdfRoot(), safe);
    }

    /// <summary>Absolute path for a generated output file.</summary>
    public string GetGeneratedFilePath(string storedFileName)
    {
        var safe = SanitizeTail(storedFileName);
        return Path.Combine(GetGeneratedRoot(), safe);
    }

    /// <summary>
    /// Returns the current session key, creating and persisting a new
    /// <c>ci_session</c> cookie when none exists. Delegates entirely to
    /// <see cref="PerSessionFileStore.GetOrCreateSessionKey"/> so Board
    /// Pack shares the same proven cookie lifecycle as Claim Intake and
    /// Contract Review.
    /// </summary>
    public string GetOrCreateSessionKey() => _fileStore.GetOrCreateSessionKey();

    /// <summary>
    /// Pins the current request to an explicit session key supplied by
    /// the client (e.g. the <c>sessionKey</c> JSON body field on
    /// <c>upload-by-template</c>). Delegates to
    /// <see cref="PerSessionFileStore.AdoptSessionKey"/> which caches
    /// the key in <c>HttpContext.Items</c> and writes the
    /// <c>ci_session</c> cookie with the correct <c>Secure</c> flag
    /// (derived from <c>X-Forwarded-Proto</c> on CloudFront). Returns
    /// the adopted key so callers can chain further operations.
    /// </summary>
    public string AdoptSessionKey(string? explicitKey)
    {
        if (string.IsNullOrWhiteSpace(explicitKey))
            return GetOrCreateSessionKey();

        // AdoptSessionKey returns the session root path; we only
        // need the side-effect (cookie + Items cache) and the key.
        _fileStore.AdoptSessionKey(explicitKey);
        return explicitKey;
    }

    private static BoardPackWorkspace FreshWorkspace(string key)
    {
        return new BoardPackWorkspace
        {
            SessionId = key,
            CreatedAtUtc = DateTime.UtcNow,
            LastModifiedUtc = DateTime.UtcNow,
            ActiveMode = "upload",
            Documents = new List<BoardPackSourceDocument>()
        };
    }

    private void EnsureDirectoryTree(string sessionRoot)
    {
        Directory.CreateDirectory(sessionRoot);
        Directory.CreateDirectory(Path.Combine(sessionRoot, WorkspaceSubFolder));
        Directory.CreateDirectory(Path.Combine(sessionRoot, OfficeSubFolder));
        Directory.CreateDirectory(Path.Combine(sessionRoot, PdfSubFolder));
        Directory.CreateDirectory(Path.Combine(sessionRoot, GeneratedSubFolder));
    }

    private static string SanitizeTail(string input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return string.Empty;
        }

        var trimmed = input.Replace('\\', '/').TrimStart('/');
        if (trimmed.Contains("..", StringComparison.Ordinal))
        {
            return string.Empty;
        }
        // Sanitise each path segment individually so that the '/'
        // separator is preserved.  Path.GetInvalidFileNameChars()
        // includes '/' on Windows (it is invalid inside a single
        // file-name component), which previously caused sub-folder
        // tails like "pdf/document.pdf" to become "pdf_document.pdf"
        // — producing a broken preview URL.
        var badChars = Path.GetInvalidFileNameChars().Where(c => c != '/').ToArray();
        var segments = trimmed.Split('/');
        for (var i = 0; i < segments.Length; i++)
        {
            var seg = segments[i];
            foreach (var ch in badChars)
            {
                seg = seg.Replace(ch, '_');
            }
            segments[i] = seg;
        }
        return string.Join('/', segments);
    }
}