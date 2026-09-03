using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;

using Syncfusion.SmartDemo.Models;
using Syncfusion.SmartDemo.Models.BoardPack;
using Syncfusion.SmartDemo.Services;
using Syncfusion.SmartDemo.Services.BoardPack;

namespace Syncfusion.SmartDemo.Controllers;

/// <summary>
/// REST surface for the Board Pack demo. Mirrors the routing
/// pattern used by <see cref="ClaimIntakeController"/> (a single
/// /api/board-pack prefix with dumb endpoints that read / write
/// the per-session workspace snapshot) so the front-end controller
/// stays a thin client over the workspace.
/// </summary>
[ApiController]
[Route("api/board-pack")]
public class BoardPackController : ControllerBase
{
    private static readonly HashSet<string> SupportedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt"
    };

    private readonly BoardPackWorkspaceStore _store;
    private readonly BoardPackOfficeConverter _converter;
    private readonly BoardPackGenerator _generator;
    private readonly IWebHostEnvironment _environment;
    private readonly ILogger<BoardPackController> _logger;

    public BoardPackController(
        BoardPackWorkspaceStore store,
        BoardPackOfficeConverter converter,
        BoardPackGenerator generator,
        IWebHostEnvironment environment,
        ILogger<BoardPackController> logger)
    {
        _store = store;
        _converter = converter;
        _generator = generator;
        _environment = environment;
        _logger = logger;
    }

    // -----------------------------------------------------------------
    // GET /api/board-pack/workspace
    //
    // Single source of truth for the front-end state owner. The
    // response holds every per-document status, the merge order,
    // the watermark configs, and the latest `Card` content the
    // user has produced. If the on-disk snapshot is missing or
    // corrupt an empty workspace is minted so the client always
    // receives a JSON body it can render.
    // -----------------------------------------------------------------
    [HttpGet("workspace")]
    public async Task<IActionResult> GetWorkspace(CancellationToken cancellationToken)
    {
        AdoptBpSession();
        var workspace = await _store.LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);
        // First-time seed: a brand-new session (no documents yet)
        // gets the three default demo templates pre-populated on
        // disk so the very first /workspace response already
        // contains the full packet. This collapses the original
        // "HTML loads -> JS boots -> 3 sequential
        // upload-by-template round-trips -> re-render" boot chain
        // into a single GET /workspace, eliminating the
        // multi-second blank page users were reporting on the
        // first click. Once seeded, the client only needs to call
        // /workspace to pick up the existing snapshot.
        if (workspace.Documents.Count == 0)
        {
            await SeedDefaultTemplatesAsync(workspace, cancellationToken).ConfigureAwait(false);
            await _store.SaveWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);
        }
        // Per-session JSON snapshot. MUST be no-store at the CDN
        // edge: CloudFront's default Cache Policy caches GET
        // responses by URL, so the second call from the same
        // browser (after convert/pack/reorder changes the
        // workspace on disk) would otherwise receive the stale
        // pre-change snapshot — which is why the live site was
        // rolling the document statuses back to "Waiting" right
        // after the user clicked "Process the selected files".
        // The query-string `bpSession` already makes the cache
        // key per-user, but CloudFront still serves a cached
        // hit while a different user with the SAME key (very
        // rare, but possible if localStorage was restored from
        // another device) re-uses it. Belt-and-braces: the
        // response is never cacheable.
        Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
        Response.Headers["Pragma"] = "no-cache";
        return Ok(BuildWorkspaceResponse(workspace));
    }

    // Materialises the three default demo templates into the
    // current session's Office folder. Shared by the
    // first-time-seed path in GetWorkspace() and the legacy
    // /upload-by-template endpoint so the same per-document
    // defaults (bookmark title, merge order, watermark config)
    // are applied regardless of which entry point the client
    // uses.
    private async Task SeedDefaultTemplatesAsync(
        BoardPackWorkspace workspace,
        CancellationToken cancellationToken)
    {
        var webRoot = _environment.WebRootPath ?? Path.Combine(_environment.ContentRootPath, "wwwroot");
        var templateRoot = Path.Combine(webRoot, "templatefiles", "BoardPack");
        if (!System.IO.Directory.Exists(templateRoot)) { return; }

        var defaultNames = new[]
        {
            "Executive_Board_Report.docx",
            "Financial_Performance_Dashboard.xlsx",
            "Board_Performance_Presentation.pptx"
        };

        var mergeOrder = workspace.Documents.Count;
        foreach (var safeName in defaultNames)
        {
            if (workspace.Documents.Any(d => string.Equals(d.FileName, safeName, StringComparison.OrdinalIgnoreCase)))
            {
                continue;
            }
            var templatePath = Path.Combine(templateRoot, safeName);
            if (!System.IO.File.Exists(templatePath)) { continue; }

            var kind = BoardPackOfficeConverter.GetKindFromExtension(safeName);
            if (kind is null) { continue; }

            var ext = Path.GetExtension(safeName);
            var safeBase = SanitizeFileStem(Path.GetFileNameWithoutExtension(safeName));
            var storedFileName = $"{safeBase}-{Guid.NewGuid():N}{ext}";
            var storedPath = _store.GetOfficeFilePath(storedFileName);

            try
            {
                await using (var source = System.IO.File.OpenRead(templatePath))
                await using (var dest = System.IO.File.Create(storedPath))
                {
                    await source.CopyToAsync(dest, cancellationToken).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not seed default Board Pack template {FileName}.", safeName);
                continue;
            }

            var docId = Guid.NewGuid().ToString("N");
            workspace.Documents.Add(new BoardPackSourceDocument
            {
                Id = docId,
                FileName = safeName,
                StoredFileName = storedFileName,
                FileSize = new FileInfo(storedPath).Length,
                Kind = kind.Value,
                FileType = BoardPackOfficeConverter.GetFileTypeLabel(kind.Value),
                DisplayName = safeBase,
                BookmarkTitle = safeBase,
                MergeOrder = mergeOrder++,
                UploadedAtUtc = DateTime.UtcNow,
                PreviewUrl = string.Empty,
                Watermark = new BoardPackWatermarkConfig
                {
                    Enabled = true,
                    Text = safeBase,
                    Color = "#1d4ed8",
                    FontSize = 48f,
                    Opacity = 0.2f,
                    Rotation = -40f
                }
            });
        }
    }

    // -----------------------------------------------------------------
    // POST /api/board-pack/upload
    //
    // Accepts one Office document (.docx/.xlsx/.pptx) and stores
    // it under the per-session office folder. The endpoint does not
    // touch any global state - the response is the updated
    // workspace snapshot so the client can re-render the packet
    // panel without re-fetching from /workspace.
    // -----------------------------------------------------------------
    [HttpPost("upload")]
    [RequestSizeLimit(long.MaxValue)]
    public async Task<IActionResult> Upload([FromForm] IFormFile document, CancellationToken cancellationToken)
    {
        AdoptBpSession();
        if (document is null || document.Length == 0)
        {
            return BadRequest(NewFailure("Upload an Office document (.docx, .xlsx or .pptx)."));
        }

        var kind = BoardPackOfficeConverter.GetKindFromExtension(document.FileName);
        if (kind is null)
        {
            return BadRequest(NewFailure($"'{document.FileName}' is not a supported Office format. Use .docx, .xlsx or .pptx."));
        }

        var ext = Path.GetExtension(document.FileName);
        var workspace = await _store.LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);

        // Reject duplicates (same name + extension already in the
        // packet) so the user is asked to remove first. We only
        // warn at upload time so a fresh upload of a file with the
        // same name going to the audit trail looks unambiguous.
        if (workspace.Documents.Any(d => string.Equals(d.FileName, document.FileName, StringComparison.OrdinalIgnoreCase)))
        {
            return Conflict(NewFailure($"'{document.FileName}' is already in the packet. Remove it first to re-upload."));
        }

        var safeBase = SanitizeFileStem(Path.GetFileNameWithoutExtension(document.FileName));
        var storedFileName = $"{safeBase}-{Guid.NewGuid():N}{ext}";
        var storedPath = _store.GetOfficeFilePath(storedFileName);

        await using (var fileStream = System.IO.File.Create(storedPath))
        {
            await document.CopyToAsync(fileStream, cancellationToken).ConfigureAwait(false);
        }

        var docId = Guid.NewGuid().ToString("N");
        var displayName = string.IsNullOrWhiteSpace(safeBase) ? document.FileName : safeBase;
        var entry = new BoardPackSourceDocument
        {
            Id = docId,
            FileName = document.FileName,
            StoredFileName = storedFileName,
            FileSize = new FileInfo(storedPath).Length,
            Kind = kind.Value,
            FileType = BoardPackOfficeConverter.GetFileTypeLabel(kind.Value),
            DisplayName = displayName,
            BookmarkTitle = displayName,
            MergeOrder = workspace.Documents.Count,
            UploadedAtUtc = DateTime.UtcNow,
            // The Office preview URL is a friendly placeholder -
            // the front-end shows it as a meta-card because the
            // browser cannot natively render DOCX/XLSX/PPTX.
            PreviewUrl = string.Empty,
            Watermark = new BoardPackWatermarkConfig
            {
                Enabled = true,
                Text = displayName,
                Color = "#1d4ed8",
                FontSize = 48f,
                Opacity = 0.2f,
                Rotation = -40f
            }
        };

        workspace.Documents.Add(entry);
        // Adding a new document to a packet that already has a
        // generated Board Pack invalidates the deliverable - the
        // uploaded file is not in the merged PDF yet. Setting
        // PackDirty here means the next /workspace poll will
        // re-enable the Build button on the Pack step.
        if (!string.IsNullOrWhiteSpace(workspace.BoardPackPdfFileName))
        {
            workspace.PackDirty = true;
        }
        await _store.SaveWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);

        return Ok(BuildUploadResponse(workspace, entry));
    }

    // -----------------------------------------------------------------
    // POST /api/board-pack/upload-by-template
    //
    // Materialises a read-only demo template into the current
    // session's Office folder and adds it to the workspace — the
    // same pattern used by ClaimIntakeController and
    // ContractReviewController for their default documents.
    //
    // The client sends {"fileName":"Executive_Board_Report.docx"};
    // the server reads the file from
    // wwwroot/templatefiles/BoardPack/{fileName} and treats it
    // exactly like a regular /upload — no CDN round-trip, no
    // multipart re-upload, no static-file fetch that could be
    // blocked by CloudFront.
    // -----------------------------------------------------------------
    [HttpPost("upload-by-template")]
    public async Task<IActionResult> UploadByTemplate(
        [FromBody] UploadByTemplateRequest body,
        CancellationToken cancellationToken)
    {
        AdoptBpSession();
        if (body is null || string.IsNullOrWhiteSpace(body.FileName))
        {
            return BadRequest(NewFailure("Missing file name."));
        }

        // When the client forwards the session key it read from
        // state.sessionId, pin this request to that session.  This
        // guarantees all three sequential template uploads land in
        // the same workspace even when the ci_session cookie is
        // absent (CloudFront TLS termination + Secure-flag race).
        if (!string.IsNullOrWhiteSpace(body.SessionKey))
        {
            _store.AdoptSessionKey(body.SessionKey);
        }

        // Reject path-traversal attempts before touching the disk.
        var safeName = Path.GetFileName(body.FileName);
        if (string.IsNullOrWhiteSpace(safeName))
        {
            return BadRequest(NewFailure("Invalid file name."));
        }

        var kind = BoardPackOfficeConverter.GetKindFromExtension(safeName);
        if (kind is null)
        {
            return BadRequest(NewFailure($"'{safeName}' is not a supported Office format."));
        }

        var webRoot = _environment.WebRootPath ?? Path.Combine(_environment.ContentRootPath, "wwwroot");
        var templatePath = Path.Combine(webRoot, "templatefiles", "BoardPack", safeName);
        if (!System.IO.File.Exists(templatePath))
        {
            return NotFound(NewFailure($"Template '{safeName}' not found."));
        }

        // Load the workspace early so we can enforce the
        // duplicate-name guard that /upload applies.
        var workspace = await _store.LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);
        if (workspace.Documents.Any(d => string.Equals(d.FileName, safeName, StringComparison.OrdinalIgnoreCase)))
        {
            // Idempotent: return the existing workspace so the
            // client can render the already-present document
            // without treating the duplicate as an error.
            return Ok(BuildWorkspaceResponse(workspace));
        }

        var ext = Path.GetExtension(safeName);
        var safeBase = SanitizeFileStem(Path.GetFileNameWithoutExtension(safeName));
        var storedFileName = $"{safeBase}-{Guid.NewGuid():N}{ext}";
        var storedPath = _store.GetOfficeFilePath(storedFileName);

        await using (var source = System.IO.File.OpenRead(templatePath))
        await using (var dest = System.IO.File.Create(storedPath))
        {
            await source.CopyToAsync(dest, cancellationToken).ConfigureAwait(false);
        }

        var docId = Guid.NewGuid().ToString("N");
        var displayName = safeBase;
        var entry = new BoardPackSourceDocument
        {
            Id = docId,
            FileName = safeName,
            StoredFileName = storedFileName,
            FileSize = new FileInfo(storedPath).Length,
            Kind = kind.Value,
            FileType = BoardPackOfficeConverter.GetFileTypeLabel(kind.Value),
            DisplayName = displayName,
            BookmarkTitle = displayName,
            MergeOrder = workspace.Documents.Count,
            UploadedAtUtc = DateTime.UtcNow,
            PreviewUrl = string.Empty,
            Watermark = new BoardPackWatermarkConfig
            {
                Enabled = true,
                Text = displayName,
                Color = "#1d4ed8",
                FontSize = 48f,
                Opacity = 0.2f,
                Rotation = -40f
            }
        };

        workspace.Documents.Add(entry);
        if (!string.IsNullOrWhiteSpace(workspace.BoardPackPdfFileName))
        {
            workspace.PackDirty = true;
        }
        await _store.SaveWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);

        return Ok(BuildUploadResponse(workspace, entry));
    }

    public class UploadByTemplateRequest
    {
        public string? FileName { get; set; }

        /// <summary>
        /// Optional: the <c>ci_session</c> key the JS client read from
        /// <c>state.sessionId</c> after the initial
        /// <c>GET /workspace</c> call. When present, the server calls
        /// <c>AdoptSessionKey</c> (via <c>PerSessionFileStore</c>) so
        /// all three sequential upload-by-template requests land in the
        /// same session even when CloudFront TLS termination causes the
        /// browser to drop the cookie between requests.
        /// </summary>
        public string? SessionKey { get; set; }
    }

    // -----------------------------------------------------------------
    // DELETE /api/board-pack/documents/{id}
    //
    // Removes a document from the packet. The on-disk artefacts
    // (Office upload, converted PDF) are also deleted so a fresh
    // upload of the same file does not hit the cache.
    // -----------------------------------------------------------------
    [HttpDelete("documents/{id}")]
    public async Task<IActionResult> RemoveDocument(string id, CancellationToken cancellationToken)
    {
        AdoptBpSession();
        var workspace = await _store.LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);
        var entry = workspace.Documents.FirstOrDefault(d => d.Id == id);
        if (entry is null)
        {
            return NotFound(NewFailure("Document not found."));
        }

        TryDelete(_store.GetOfficeFilePath(entry.StoredFileName));
        if (!string.IsNullOrWhiteSpace(entry.ConvertedFileName))
        {
            TryDelete(_store.GetPdfFilePath(entry.ConvertedFileName));
        }

        workspace.Documents.Remove(entry);
        ReindexMergeOrders(workspace);
        // Removing a document invalidates the previously
        // generated Board Pack - the merged PDF no longer
        // matches the contents of the packet. The user must
        // re-run Pack before the Export step is in sync again.
        workspace.PackDirty = true;
        await _store.SaveWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);

        return Ok(BuildWorkspaceResponse(workspace));
    }

    // -----------------------------------------------------------------
    // POST /api/board-pack/reorder
    //
    // Accepts a JSON body with the new document order
    // (`{"ids":["id1","id2",...]}`) and rewrites every
    // `MergeOrder` so the next render of the Pack step produces
    // the right sequence.
    // -----------------------------------------------------------------
    [HttpPost("reorder")]
    public async Task<IActionResult> Reorder([FromBody] ReorderRequest body, CancellationToken cancellationToken)
    {
        AdoptBpSession();
        if (body is null || body.Ids is null)
        {
            return BadRequest(NewFailure("Missing document order."));
        }

        var workspace = await _store.LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);
        var pending = body.Ids
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        // Documents that were not included in the order list are
        // appended to the end so the user's drag-and-drop never
        // *loses* a document.
        var missing = workspace.Documents
            .Select(d => d.Id)
            .Where(id => !pending.Contains(id, StringComparer.Ordinal))
            .ToList();
        var ordered = pending.Concat(missing).ToList();

        for (int i = 0; i < ordered.Count; i++)
        {
            var doc = workspace.Documents.FirstOrDefault(d => d.Id == ordered[i]);
            if (doc is not null)
            {
                doc.MergeOrder = i;
            }
        }
        // Changing the merge order invalidates the previously
        // generated Board Pack PDF. The Pack step will surface
        // the outdated state on the next render so the user
        // must re-run Pack before the Export deliverables can
        // be considered current.
        workspace.PackDirty = true;
        await _store.SaveWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);
        return Ok(BuildWorkspaceResponse(workspace));
    }

    public class ReorderRequest
    {
        public List<string>? Ids { get; set; }
    }

    // -----------------------------------------------------------------
    // POST /api/board-pack/watermarks/{id}
    //
    // Legacy per-document watermark endpoint. The Pack step now
    // exposes a single packet-wide watermark (see
    // <see cref="UpdateCommonWatermark"/>) but the endpoint is
    // kept for backwards compatibility with snapshots that still
    // carry per-document watermark overrides.
    // -----------------------------------------------------------------
    [HttpPost("watermarks/{id}")]
    public async Task<IActionResult> UpdateWatermark(string id, [FromBody] WatermarkUpdate body, CancellationToken cancellationToken)
    {
        AdoptBpSession();
        var workspace = await _store.LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);
        var doc = workspace.Documents.FirstOrDefault(d => d.Id == id);
        if (doc is null)
        {
            return NotFound(NewFailure("Document not found."));
        }

        if (body is null)
        {
            return BadRequest(NewFailure("Missing watermark configuration."));
        }

        doc.Watermark.Enabled = body.Enabled ?? doc.Watermark.Enabled;
        if (!string.IsNullOrWhiteSpace(body.Text))
        {
            doc.Watermark.Text = body.Text!;
        }
        if (!string.IsNullOrWhiteSpace(body.Color))
        {
            doc.Watermark.Color = body.Color!;
        }
        if (body.FontSize.HasValue) doc.Watermark.FontSize = body.FontSize.Value;
        if (body.Opacity.HasValue) doc.Watermark.Opacity = Math.Clamp(body.Opacity.Value, 0.05f, 1f);
        if (body.Rotation.HasValue) doc.Watermark.Rotation = body.Rotation.Value;

        // Any per-document watermark tweak invalidates the
        // previously exported Board Pack - the user must re-run
        // Pack so the merge produces a deck matching the new
        // watermark config.
        workspace.PackDirty = true;
        await _store.SaveWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);
        return Ok(BuildWorkspaceResponse(workspace));
    }

    public class WatermarkUpdate
    {
        public bool? Enabled { get; set; }
        public string? Text { get; set; }
        public string? Color { get; set; }
        public float? FontSize { get; set; }
        public float? Opacity { get; set; }
        public float? Rotation { get; set; }
    }

    // -----------------------------------------------------------------
    // POST /api/board-pack/watermark
    //
    // Updates the SINGLE packet-wide watermark applied to every
    // page of the final Board Pack. The Pack page renders a single
    // editor (toggle + text "Confidential" + color picker) so the
    // user does not have to configure the same watermark N times
    // for N documents.
    // -----------------------------------------------------------------
    [HttpPost("watermark")]
    public async Task<IActionResult> UpdateCommonWatermark([FromBody] WatermarkUpdate body, CancellationToken cancellationToken)
    {
        AdoptBpSession();
        var workspace = await _store.LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);
        if (body is null)
        {
            return BadRequest(NewFailure("Missing watermark configuration."));
        }

        workspace.CommonWatermark ??= new BoardPackWatermarkConfig
        {
            Enabled = false,
            Text = "Confidential",
            Color = "#1d4ed8",
            FontSize = 48f,
            Opacity = 0.25f,
            Rotation = -40f
        };

        workspace.CommonWatermark.Enabled = body.Enabled ?? workspace.CommonWatermark.Enabled;
        if (!string.IsNullOrWhiteSpace(body.Text))
        {
            workspace.CommonWatermark.Text = body.Text!;
        }
        if (!string.IsNullOrWhiteSpace(body.Color))
        {
            workspace.CommonWatermark.Color = body.Color!;
        }
        if (body.FontSize.HasValue) workspace.CommonWatermark.FontSize = body.FontSize.Value;
        if (body.Opacity.HasValue) workspace.CommonWatermark.Opacity = Math.Clamp(body.Opacity.Value, 0.05f, 1f);
        if (body.Rotation.HasValue) workspace.CommonWatermark.Rotation = body.Rotation.Value;

        // Toggling / editing the common watermark invalidates
        // the previously generated Board Pack - the next Pack
        // run is what will draw the new watermark onto every
        // page of the merged PDF.
        workspace.PackDirty = true;
        await _store.SaveWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);
        return Ok(BuildWorkspaceResponse(workspace));
    }

    // -----------------------------------------------------------------
    // POST /api/board-pack/bookmarks/{id}
    //
    // Updates the bookmark title shown in the PDF outline. The
    // destination is always the first page of the document's
    // section in the final PDF so the user only ever edits the
    // visible label.
    // -----------------------------------------------------------------
    [HttpPost("bookmarks/{id}")]
    public async Task<IActionResult> UpdateBookmark(string id, [FromBody] BookmarkUpdate body, CancellationToken cancellationToken)
    {
        AdoptBpSession();
        var workspace = await _store.LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);
        var doc = workspace.Documents.FirstOrDefault(d => d.Id == id);
        if (doc is null)
        {
            return NotFound(NewFailure("Document not found."));
        }
        if (body is null || string.IsNullOrWhiteSpace(body.Title))
        {
            return BadRequest(NewFailure("Missing bookmark title."));
        }
        doc.BookmarkTitle = body.Title.Trim();
        if (body.AutoBookmark.HasValue)
        {
            doc.AutoBookmark = body.AutoBookmark.Value;
        }
        // Editing a bookmark title invalidates the previously
        // exported Board Pack because the merged PDF's outline
        // is generated at Pack time. The user must re-run Pack
        // to see the new bookmark label in the final PDF.
        workspace.PackDirty = true;
        await _store.SaveWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);
        return Ok(BuildWorkspaceResponse(workspace));
    }

    public class BookmarkUpdate
    {
        public string? Title { get; set; }
        public bool? AutoBookmark { get; set; }
    }

    // -----------------------------------------------------------------
    // POST /api/board-pack/security
    //
    // Toggles password protection for the final Board Pack and
    // updates / clears the password. The password itself is
    // persisted alongside the workspace snapshot because the
    // generator runs out-of-process during the Pack step.
    // -----------------------------------------------------------------
    [HttpPost("security")]
    public async Task<IActionResult> UpdateSecurity([FromBody] SecurityUpdate body, CancellationToken cancellationToken)
    {
        AdoptBpSession();
        var workspace = await _store.LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);
        if (body is null)
        {
            return BadRequest(NewFailure("Missing security configuration."));
        }

        if (body.PasswordProtect.HasValue)
        {
            workspace.PasswordProtect = body.PasswordProtect.Value;
            if (!workspace.PasswordProtect)
            {
                workspace.Password = string.Empty;
            }
        }
        if (!string.IsNullOrWhiteSpace(body.Password))
        {
            // The Pack page no longer asks for a password
            // confirmation input - the user toggles protection
            // on, types a password once, and the generator
            // applies it. ConfirmPassword is still accepted on
            // the DTO for backwards compatibility with older
            // clients but is no longer required to match.
            workspace.Password = body.Password;
        }
        // Toggling password protection (or saving a new
        // password) invalidates the previously exported Board
        // Pack because the generator re-encrypts the merged PDF
        // with the new password on the next Pack run.
        workspace.PackDirty = true;
        await _store.SaveWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);
        return Ok(BuildWorkspaceResponse(workspace));
    }

    public class SecurityUpdate
    {
        public bool? PasswordProtect { get; set; }
        public string? Password { get; set; }
        public string? ConfirmPassword { get; set; }
    }

    // -----------------------------------------------------------------
    // POST /api/board-pack/convert
    //
    // Runs the Office -> PDF pipeline for every uploaded document
    // that is still waiting or has failed on a previous attempt.
    // Status updates are written to the workspace snapshot *before*
    // conversion; the front-end polls /workspace between calls or
    // just calls /workspace when the request completes.
    // -----------------------------------------------------------------
    [HttpPost("convert")]
    public async Task<IActionResult> ConvertAll(CancellationToken cancellationToken)
    {
        AdoptBpSession();
        var workspace = await _store.LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);
        if (workspace.Documents.Count == 0)
        {
            return BadRequest(NewFailure("Upload at least one document before converting."));
        }

        // Mark every Waiting / Failed document as Converting
        // and persist so an interrupted request does not leave
        // orphan "Converting" badges on the UI.
        foreach (var doc in workspace.Documents)
        {
            if (doc.Status is BoardPackConversionStatus.Waiting or BoardPackConversionStatus.Failed)
            {
                doc.Status = BoardPackConversionStatus.Converting;
                doc.ErrorMessage = null;
            }
        }
        await _store.SaveWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);

        foreach (var doc in workspace.Documents)
        {
            if (doc.Status != BoardPackConversionStatus.Converting)
            {
                continue;
            }

            try
            {
                var sourcePath = _store.GetOfficeFilePath(doc.StoredFileName);
                var pdfStoredFile = Path.GetFileNameWithoutExtension(doc.StoredFileName) + ".pdf";
                var pdfPath = _store.GetPdfFilePath(pdfStoredFile);
                Directory.CreateDirectory(Path.GetDirectoryName(pdfPath)!);

                var pageCount = _converter.Convert(doc.Kind, sourcePath, pdfPath);

                doc.ConvertedFileName = pdfStoredFile;
                doc.ConvertedPageCount = pageCount;
                doc.ConvertedPreviewUrl = BuildConvertedPreviewUrl(pdfStoredFile);
                doc.Status = BoardPackConversionStatus.Converted;
                doc.ErrorMessage = null;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to convert {Doc} for session {Session}.", doc.FileName, workspace.SessionId);
                doc.Status = BoardPackConversionStatus.Failed;
                doc.ErrorMessage = ex.Message?.Length > 240 ? ex.Message.Substring(0, 240) : ex.Message ?? "Conversion failed.";
            }

            await _store.SaveWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);
        }

        return Ok(BuildWorkspaceResponse(workspace));
    }

    // -----------------------------------------------------------------
    // POST /api/board-pack/convert/{id}
    //
    // Converts a single document identified by its ID. Used by the
    // front-end to convert documents one at a time so that the UI can
    // show per-document live status updates (Waiting → Converting →
    // Converted / Failed) without waiting for all documents to finish
    // in a single blocking request.
    //
    // Only documents in Waiting or Failed state are re-processed;
    // a document already in Converted / Converting state is returned
    // as-is so duplicate calls are idempotent.
    // -----------------------------------------------------------------
    [HttpPost("convert/{id}")]
    public async Task<IActionResult> ConvertDocument(string id, CancellationToken cancellationToken)
    {
        AdoptBpSession();
        if (string.IsNullOrWhiteSpace(id))
        {
            return BadRequest(NewFailure("Missing document ID."));
        }

        var workspace = await _store.LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);
        var doc = workspace.Documents.FirstOrDefault(d => d.Id == id);
        if (doc is null)
        {
            return NotFound(NewFailure($"Document '{id}' not found."));
        }

        // Skip documents that are already converted or being converted
        // by a concurrent request (idempotent guard).
        if (doc.Status is BoardPackConversionStatus.Converted or BoardPackConversionStatus.Converting)
        {
            return Ok(BuildWorkspaceResponse(workspace));
        }

        doc.Status = BoardPackConversionStatus.Converting;
        doc.ErrorMessage = null;
        await _store.SaveWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);

        try
        {
            var sourcePath = _store.GetOfficeFilePath(doc.StoredFileName);
            var pdfStoredFile = Path.GetFileNameWithoutExtension(doc.StoredFileName) + ".pdf";
            var pdfPath = _store.GetPdfFilePath(pdfStoredFile);
            Directory.CreateDirectory(Path.GetDirectoryName(pdfPath)!);

            var pageCount = _converter.Convert(doc.Kind, sourcePath, pdfPath);

            doc.ConvertedFileName = pdfStoredFile;
            doc.ConvertedPageCount = pageCount;
            doc.ConvertedPreviewUrl = BuildConvertedPreviewUrl(pdfStoredFile);
            doc.Status = BoardPackConversionStatus.Converted;
            doc.ErrorMessage = null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to convert {Doc} for session {Session}.", doc.FileName, workspace.SessionId);
            doc.Status = BoardPackConversionStatus.Failed;
            doc.ErrorMessage = ex.Message?.Length > 240 ? ex.Message.Substring(0, 240) : ex.Message ?? "Conversion failed.";
        }

        await _store.SaveWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);
        return Ok(BuildWorkspaceResponse(workspace));
    }

    // -----------------------------------------------------------------
    // POST /api/board-pack/pack
    //
    // Runs the merge pipeline. The endpoint is synchronous (small
    // boards typically take under a second) so the front-end can
    // retry cleanly when the user changes merge order after
    // initial generation.
    // -----------------------------------------------------------------
    [HttpPost("pack")]
    public async Task<IActionResult> Pack(CancellationToken cancellationToken)
    {
        AdoptBpSession();
        var workspace = await _store.LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);
        if (workspace.Documents.Count == 0)
        {
            return BadRequest(NewFailure("Upload at least one document before packing."));
        }
        if (!workspace.Documents.Any(d => d.Status == BoardPackConversionStatus.Converted))
        {
            return BadRequest(NewFailure("Run conversion before packing."));
        }

        try
        {
            var result = _generator.Generate(workspace);
            workspace.BoardPackPdfFileName = Path.GetFileName(result.FinalPdfPath);
            workspace.BoardPackPreviewUrl = BuildGeneratedPreviewUrl(workspace.BoardPackPdfFileName);
            workspace.SourcesZipFileName = string.IsNullOrWhiteSpace(result.SourcesZipPath)
                ? null
                : Path.GetFileName(result.SourcesZipPath);
            workspace.ManifestFileName = string.IsNullOrWhiteSpace(result.ManifestPath)
                ? null
                : Path.GetFileName(result.ManifestPath);
            // The Pack run just produced a fresh Board Pack
            // PDF, ZIP and audit manifest from the user's
            // current configuration. The Export step is once
            // again "in sync" with the packet - the user can
            // rely on the deliverables until they change a
            // Pack-side setting.
            workspace.PackDirty = false;
            await _store.SaveWorkspaceAsync(workspace, cancellationToken).ConfigureAwait(false);
            return Ok(BuildWorkspaceResponse(workspace));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to generate Board Pack for session {Session}.", workspace.SessionId);
            return BadRequest(NewFailure($"Failed to build the Board Pack: {ex.Message}"));
        }
    }

    // -----------------------------------------------------------------
    // GET /api/board-pack/manifest
    //
    // Streams the audit JSON. The Export page uses the same JSON
    // for the inline preview panel.
    // -----------------------------------------------------------------
    [HttpGet("manifest")]
    public async Task<IActionResult> GetManifest(CancellationToken cancellationToken)
    {
        AdoptBpSession();
        // Per-session artefact. The manifest is regenerated on
        // every /pack call, so a CDN-cached copy would serve the
        // pre-rebuild JSON to the next browser that opened the
        // modal. Set the no-store headers BEFORE the 404 branch
        // so even a not-yet-generated response cannot be cached
        // and re-served as a stale "manifest unavailable" once
        // the user has actually generated one.
        Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
        Response.Headers["Pragma"] = "no-cache";
        var workspace = await _store.LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);
        var sessionRoot = _store.GetSessionRoot();
        var manifestPath = Path.Combine(sessionRoot, BoardPackGeneratorPaths.GeneratedSubFolder, BoardPackGeneratorPaths.ManifestFileName);
        if (!System.IO.File.Exists(manifestPath))
        {
            return NotFound(NewFailure("Audit manifest is not available yet. Pack the documents first."));
        }

        var text = await System.IO.File.ReadAllTextAsync(manifestPath, cancellationToken).ConfigureAwait(false);
        return Content(text, "application/json");
    }

    // -----------------------------------------------------------------
    // GET /api/board-pack/download/{kind}
    //
    // Stream the chosen deliverable. `kind` is one of
    // <c>document</c> | <c>zip</c> | <c>manifest</c>. The ZIP
    // path is used by the Export page button, and a single
    // document download covers the Pack page "Preview" button.
    // -----------------------------------------------------------------
    [HttpGet("download/{kind}")]
    public async Task<IActionResult> Download(string kind, CancellationToken cancellationToken)
    {
        AdoptBpSession();
        var workspace = await _store.LoadWorkspaceAsync(cancellationToken).ConfigureAwait(false);
        string generatedRoot = _store.GetGeneratedRoot();
        // The downloaded artefacts (Board Pack PDF, source ZIP,
        // audit manifest) are all regenerated on every /pack
        // call with fresh watermarks / bookmarks / passwords,
        // so the CDN MUST NOT serve a cached copy. The previous
        // implementation left the Cache-Control header unset,
        // which let CloudFront (default Cache Policy) cache the
        // response keyed by URL — the second download after a
        // Pack rebuild would then serve the previous PDF/ZIP.
        Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
        Response.Headers["Pragma"] = "no-cache";

        switch ((kind ?? string.Empty).ToLowerInvariant())
        {
            case "board-pack":
                {
                    var fileName = workspace.BoardPackPdfFileName;
                    if (string.IsNullOrWhiteSpace(fileName))
                    {
                        return NotFound(NewFailure("Board Pack PDF has not been generated yet."));
                    }
                    var path = Path.Combine(generatedRoot, fileName);
                    if (!System.IO.File.Exists(path))
                    {
                        return NotFound(NewFailure("Board Pack PDF not found on disk."));
                    }
                    return await StreamFileAsync(path, fileName, "application/pdf", cancellationToken).ConfigureAwait(false);
                }
            case "source-zip":
                {
                    var fileName = workspace.SourcesZipFileName;
                    if (string.IsNullOrWhiteSpace(fileName))
                    {
                        return NotFound(NewFailure("Source ZIP has not been generated yet."));
                    }
                    var path = Path.Combine(generatedRoot, fileName);
                    if (!System.IO.File.Exists(path))
                    {
                        return NotFound(NewFailure("Source ZIP not found on disk."));
                    }
                    return await StreamFileAsync(path, fileName, "application/zip", cancellationToken).ConfigureAwait(false);
                }
            case "manifest":
                {
                    var fileName = workspace.ManifestFileName ?? BoardPackGeneratorPaths.ManifestFileName;
                    var path = Path.Combine(generatedRoot, fileName);
                    if (!System.IO.File.Exists(path))
                    {
                        return NotFound(NewFailure("Audit manifest not found."));
                    }
                    return await StreamFileAsync(path, fileName, "application/json", cancellationToken).ConfigureAwait(false);
                }
            default:
                return BadRequest(NewFailure($"Unknown download kind '{kind}'."));
        }
    }

    // -----------------------------------------------------------------
    // GET /api/board-pack/preview/{kind}/{fileName}
    //
    // Streams a file from the per-session folder for inline previ
    // ew in iframes / modal viewers. Same security boundary as
    // the existing /uploads path under ClaimIntakeController.
    // -----------------------------------------------------------------
    [HttpGet("preview/{kind}/{fileName}")]
    public IActionResult Preview(string kind, string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName))
        {
            return BadRequest(NewFailure("Missing file name."));
        }
        if (fileName.Contains("..", StringComparison.Ordinal))
        {
            return BadRequest(NewFailure("Invalid file path."));
        }

        var sessionRoot = _store.GetSessionRoot();
        var target = (kind ?? string.Empty).ToLowerInvariant() switch
        {
            "office" => Path.Combine(_store.GetOfficeRoot(), fileName),
            "pdf" => Path.Combine(_store.GetPdfRoot(), fileName),
            "generated" => Path.Combine(_store.GetGeneratedRoot(), fileName),
            _ => null
        };
        if (target is null || !System.IO.File.Exists(target))
        {
            return NotFound(NewFailure("File not found."));
        }

        // Cache the SOURCE PDFs (office + converted) aggressively
        // because they never change after the Office -> PDF
        // conversion. The GENERATED Board Pack PDF, however, is
        // regenerated every time the user clicks Build (with
        // potentially different watermark, bookmark titles or
        // password settings) so it MUST be served with no-store;
        // the cache-busting query string in
        // BuildGeneratedPreviewUrl is the primary defence, but
        // the no-store header is a belt-and-braces guarantee in
        // case a reverse proxy / browser shares cache across
        // query strings.
        var isGenerated = (kind ?? string.Empty).Equals("generated", StringComparison.OrdinalIgnoreCase);
        Response.Headers["Cache-Control"] = isGenerated
            ? "no-store, no-cache, must-revalidate, max-age=0"
            : "private, max-age=86400, immutable";
        Response.Headers["Accept-Ranges"] = "bytes";
        if (target.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase))
        {
            Response.Headers["Content-Type"] = "application/pdf";
        }
        else if (target.EndsWith(".docx", StringComparison.OrdinalIgnoreCase) ||
                 target.EndsWith(".xlsx", StringComparison.OrdinalIgnoreCase) ||
                 target.EndsWith(".pptx", StringComparison.OrdinalIgnoreCase))
        {
            Response.Headers["Content-Type"] = "application/octet-stream";
        }
        return new FileStreamResult(System.IO.File.OpenRead(target), "application/octet-stream")
        {
            EnableRangeProcessing = true
        };
    }

    // -----------------------------------------------------------------
    // GET /uploads/board-pack/{*path}
    //
    // CATCH-ALL route that serves the session-scoped preview URLs
    // the front-end actually receives. BoardPackWorkspaceStore.
    // GetSessionRelativeUrl() returns URLs of the form
    //   /uploads/board-pack/{sessionKey}/pdf/{file}.pdf
    //   /uploads/board-pack/{sessionKey}/generated/{file}.pdf
    // and the Syncfusion PdfViewer fetches them as-is. Without
    // this endpoint the viewer receives a 404 and reports
    // "Invalid PDF file type or PDF file not found" - the modal
    // opens but the host stays empty.
    //
    // Security boundary (mirrors ClaimIntakeController.ServeUploadsPath):
    //   * Block path traversal (".." segments).
    //   * Validate the URL's session key matches the current
    //     session cookie so a user cannot enumerate another
    //     session's PDFs.
    //   * Resolve the path under the session root and refuse
    //     any tail that escapes the root.
    //   * Set Content-Type based on extension (PDFs MUST be
    //     application/pdf so the EJ2 viewer can render them
    //     inline).
    // -----------------------------------------------------------------
    [HttpGet("/uploads/board-pack/{*path}")]
    public IActionResult ServeUploadsPath(string? path)
    {
        AdoptBpSession();
        if (string.IsNullOrWhiteSpace(path))
        {
            return BadRequest(NewFailure("Missing file path."));
        }

        var decoded = Uri.UnescapeDataString(path);
        var safeRelative = decoded
            .Replace('\\', '/')
            .TrimStart('/');

        if (safeRelative.Contains("..", StringComparison.Ordinal))
        {
            return BadRequest(NewFailure("Invalid file path."));
        }

        // URL shape: {sessionKey}/{subFolder}/{fileName}
        // e.g. 9ee9892b23b36fc0ce1c2b485a35b475/pdf/board-pack-xxx.pdf
        var slashIndex = safeRelative.IndexOf('/');
        if (slashIndex <= 0)
        {
            return BadRequest(NewFailure("Invalid file path."));
        }

        var urlKey = safeRelative[..slashIndex];
        var currentKey = _store.GetOrCreateSessionKey();
        if (!string.Equals(urlKey, currentKey, StringComparison.OrdinalIgnoreCase))
        {
            return NotFound(NewFailure("File not found."));
        }

        var tail = safeRelative[(slashIndex + 1)..];

        var sessionRoot = _store.GetSessionRoot();
        var absolute = Path.GetFullPath(Path.Combine(sessionRoot, tail.Replace('/', Path.DirectorySeparatorChar)));
        var rootWithSep = sessionRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!absolute.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase))
        {
            // Defensive: ensure path is under session root
            return BadRequest(NewFailure("Invalid file path."));
        }

        if (!System.IO.File.Exists(absolute))
        {
            return NotFound(NewFailure("File not found."));
        }

        // Same logic as the /api/board-pack/preview route:
        // source PDFs cache aggressively, the generated Board
        // Pack PDF is no-store because the user can re-build
        // with new password / watermark / bookmark settings
        // and the browser must always serve the freshest copy.
        var isGeneratedServe = tail.Replace('\\', '/').StartsWith(BoardPackWorkspaceStore.GeneratedSubFolder, StringComparison.OrdinalIgnoreCase);
        Response.Headers["Cache-Control"] = isGeneratedServe
            ? "no-store, no-cache, must-revalidate, max-age=0"
            : "private, max-age=86400, immutable";
        Response.Headers["Accept-Ranges"] = "bytes";
        string contentType = "application/octet-stream";
        if (absolute.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase))
        {
            contentType = "application/pdf";
        }
        else if (absolute.EndsWith(".docx", StringComparison.OrdinalIgnoreCase) ||
                 absolute.EndsWith(".xlsx", StringComparison.OrdinalIgnoreCase) ||
                 absolute.EndsWith(".pptx", StringComparison.OrdinalIgnoreCase))
        {
            contentType = "application/octet-stream";
        }
        return new FileStreamResult(System.IO.File.OpenRead(absolute), contentType)
        {
            EnableRangeProcessing = true
        };
    }
    //
    // Final-test-friendly Reset endpoint: drops the workspace and
    // every artefact for the current session so the UI can boot a
    // fresh Upload page.
    // -----------------------------------------------------------------
    [HttpPost("reset")]
    public IActionResult Reset()
    {
        AdoptBpSession();
        var key = _store.GetOrCreateSessionKey();
        _store.PurgeSession(key);
        return Ok(BuildWorkspaceResponse(new BoardPackWorkspace
        {
            SessionId = key,
            ActiveMode = "upload",
            Documents = new List<BoardPackSourceDocument>()
        }));
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    /// <summary>
    /// Pins the current HTTP request to the Board Pack session the JS
    /// client is operating on. Tries three sources in order of
    /// reliability behind a TLS-terminating reverse proxy:
    /// <list type="number">
    ///   <item><description><c>?bpSession=&lt;key&gt;</c> query string parameter
    ///   — CloudFront / Cloudflare always forward query strings to the
    ///   origin under their default policies, so this is the
    ///   authoritative transport on AWS CloudFront.</description></item>
    ///   <item><description><c>X-BP-Session</c> custom request header —
    ///   forwarded by the CDN only when its Origin Request Policy
    ///   whitelists custom headers, but harmless when dropped.</description></item>
    ///   <item><description>The <c>ci_session</c> cookie — handled
    ///   transparently by <c>AdoptSessionKey</c> via the shared
    ///   <c>PerSessionFileStore</c>.</description></item>
    /// </list>
    /// Without this, every action on AWS CloudFront minted a new
    /// session (the inbound <c>Cookie</c> header is dropped by the
    /// default CloudFront Origin Request Policy) and the user saw
    /// <c>404 Not Found</c> on every Convert / Delete call.
    /// </summary>
    private void AdoptBpSession()
    {
        // 1. Query string (the only transport CloudFront forwards
        //    by default — this is the one that always works).
        var key = Request.Query["bpSession"].FirstOrDefault();

        // 2. Custom header (forwards only if the CDN is configured
        //    to allow it, but harmless to read when present).
        if (string.IsNullOrWhiteSpace(key))
        {
            key = Request.Headers["X-BP-Session"].FirstOrDefault();
        }

        if (!string.IsNullOrWhiteSpace(key))
        {
            _store.AdoptSessionKey(key);
        }
    }

    private object BuildUploadResponse(BoardPackWorkspace workspace, BoardPackSourceDocument entry)
    {
        var response = BuildWorkspaceResponse(workspace);
        return new
        {
            success = true,
            document = SerializeDocument(entry),
            workspace = response
        };
    }

    private object BuildWorkspaceResponse(BoardPackWorkspace workspace)
    {
        var sessionRoot = _store.GetSessionRoot();
        return new
        {
            success = true,
            workspace = new
            {
                sessionId = workspace.SessionId,
                createdAtUtc = workspace.CreatedAtUtc,
                lastModifiedUtc = workspace.LastModifiedUtc,
                activeMode = workspace.ActiveMode,
                passwordProtect = workspace.PasswordProtect,
                commonWatermark = new
                {
                    enabled = workspace.CommonWatermark?.Enabled ?? false,
                    text = workspace.CommonWatermark?.Text ?? "Confidential",
                    color = workspace.CommonWatermark?.Color ?? "#1d4ed8",
                    fontSize = workspace.CommonWatermark?.FontSize ?? 48f,
                    opacity = workspace.CommonWatermark?.Opacity ?? 0.25f,
                    rotation = workspace.CommonWatermark?.Rotation ?? -40f
                },
                documents = workspace.Documents.Select(SerializeDocument).ToList(),
                boardPackPreviewUrl = string.IsNullOrWhiteSpace(workspace.BoardPackPdfFileName)
                    ? string.Empty
                    : BuildGeneratedPreviewUrl(workspace.BoardPackPdfFileName),
                sourcesPreviewUrl = string.Empty,
                boardPackGenerated = !string.IsNullOrWhiteSpace(workspace.BoardPackPdfFileName),
                sourcesGenerated = !string.IsNullOrWhiteSpace(workspace.SourcesZipFileName),
                manifestGenerated = !string.IsNullOrWhiteSpace(workspace.ManifestFileName),
                // PackDirty tells the client whether the current
                // Pack configuration matches the last successful
                // Pack run. When true, the previously generated
                // Board Pack is OUT OF DATE - the user must
                // re-run Pack before the Export step can be
                // ticked as "complete" again.
                packDirty = workspace.PackDirty
            }
        };
    }

    private object SerializeDocument(BoardPackSourceDocument doc)
    {
        return new
        {
            id = doc.Id,
            fileName = doc.FileName,
            storedFileName = doc.StoredFileName,
            displayName = doc.DisplayName,
            bookmarkTitle = doc.BookmarkTitle,
            autoBookmark = doc.AutoBookmark,
            fileType = doc.GetFriendlyFileType(),
            kind = doc.Kind.ToString(),
            fileSize = doc.FileSize,
            uploadedAtUtc = doc.UploadedAtUtc,
            status = doc.Status.ToString(),
            errorMessage = doc.ErrorMessage,
            mergeOrder = doc.MergeOrder,
            convertedFileName = doc.ConvertedFileName,
            convertedPageCount = doc.ConvertedPageCount,
            // Regenerate the preview URL on every response so that stale
            // on-disk values (e.g. from a session that was saved before the
            // SanitizeTail path-separator fix) are never served.
            convertedPreviewUrl = string.IsNullOrWhiteSpace(doc.ConvertedFileName)
                ? doc.ConvertedPreviewUrl
                : BuildConvertedPreviewUrl(doc.ConvertedFileName),
            watermark = new
            {
                enabled = doc.Watermark.Enabled,
                text = doc.Watermark.Text,
                color = doc.Watermark.Color,
                fontSize = doc.Watermark.FontSize,
                opacity = doc.Watermark.Opacity,
                rotation = doc.Watermark.Rotation
            }
        };
    }

    private string BuildConvertedPreviewUrl(string storedFile)
    {
        return _store.GetSessionRelativeUrl(Path.Combine(BoardPackWorkspaceStore.PdfSubFolder, storedFile).Replace('\\', '/'));
    }

    private string BuildGeneratedPreviewUrl(string storedFile)
    {
        // Append a cache-busting query string so the browser
        // does not keep serving the OLD Board Pack PDF after a
        // re-build (e.g. when the user enables password
        // protection after the first Build, navigates to
        // Export, and comes back to Pack). The file name on
        // disk is reused (BoardPackPdfFileName is the same
        // constant) so without a unique URL the browser
        // would return the cached, unprotected copy. We use
        // the file's last-write-time so the URL is stable for
        // a given build but changes every time the file is
        // regenerated.
        var baseUrl = _store.GetSessionRelativeUrl(Path.Combine(BoardPackWorkspaceStore.GeneratedSubFolder, storedFile).Replace('\\', '/'));
        var fullPath = Path.Combine(_store.GetGeneratedRoot(), storedFile);
        if (System.IO.File.Exists(fullPath))
        {
            var ticks = System.IO.File.GetLastWriteTimeUtc(fullPath).Ticks;
            var separator = baseUrl.IndexOf('?') >= 0 ? '&' : '?';
            return baseUrl + separator + "v=" + ticks.ToString();
        }
        return baseUrl;
    }

    private static string SanitizeFileStem(string input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return "Document";
        }
        var bad = Path.GetInvalidFileNameChars();
        foreach (var ch in bad)
        {
            input = input.Replace(ch, '_');
        }
        return input.Trim();
    }

    private static async Task<IActionResult> StreamFileAsync(string path, string downloadName, string contentType, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var stream = System.IO.File.OpenRead(path);
        try
        {
            await Task.Yield();
        }
        catch
        {
            // best-effort: streaming handles cancellation via the framework
            stream.Dispose();
            throw;
        }
        return new FileStreamResult(stream, contentType)
        {
            EnableRangeProcessing = true,
            FileDownloadName = downloadName
        };
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (System.IO.File.Exists(path))
            {
                System.IO.File.Delete(path);
            }
        }
        catch
        {
            // best-effort cleanup
        }
    }

    private static void ReindexMergeOrders(BoardPackWorkspace workspace)
    {
        for (int i = 0; i < workspace.Documents.Count; i++)
        {
            workspace.Documents[i].MergeOrder = i;
        }
    }

    private object NewFailure(string message)
    {
        return new
        {
            success = false,
            message
        };
    }
}