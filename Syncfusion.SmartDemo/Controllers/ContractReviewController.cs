using Microsoft.AspNetCore.Mvc;
using Syncfusion.DocIO;
using Syncfusion.DocIO.DLS;
// DocIO renders Word to PDF via the DocIORenderer type, which
// lives in a namespace that shares its name. Use a using
// alias so `DocIORenderer` resolves to the type rather than the
// namespace.
using DocIORendererType = Syncfusion.DocIORenderer.DocIORenderer;
using Syncfusion.SmartDemo.Services;
using Syncfusion.SmartDemo.Services.ContractReview;
using System.Security.Cryptography;

namespace Syncfusion.SmartDemo.Controllers;

/// <summary>
/// Server-side pipeline runner for the Contract Review demo.
///
/// The flow is intentionally narrow compared with Claims
/// Intake. The server only needs to:
///   * list default DOCX templates,
///   * accept a user-uploaded DOCX,
///   * copy a default template into the per-session folder,
///   * run <c>WordDocument.Compare</c> on the user's chosen
///     "original" + "revised" and write the negotiated DOCX
///     (with track-changes markers) to the per-session
///     Generated subfolder so the editor can fetch it,
///   * render the final accepted DOCX bytes into a clean PDF
///     via <c>DocIORenderer</c>, and
///   * serve previews + session lifecycle (inherited from
///     <see cref="PerSessionFileStore"/>).
///
/// The DOCX editor runs entirely client-side:
///   * On boot the centre panel fetches the negotiated DOCX
///     from its previewUrl, calls
///     <c>container.documentEditor.open(arrayBuffer, 'Docx')</c>,
///     and the editor renders the inline track-changes
///     automatically (DocIO's Compare writes Word-style
///     <c>&lt;w:ins&gt;</c> / <c>&lt;w:del&gt;</c> markers).
///   * When the user clicks Accept/Reject, the editor's
///     <c>beforeAcceptRejectChanges</c> event fires; the event
///     handler captures the new content + author + action type
///     and stores them on the in-memory state.
///   * When the user reaches the Export step, the client pulls
///     the editor's finalised DOCX via
///     <c>documentEditor.saveAsBlob('Docx')</c>, base64-encodes
///     it, and POSTs it to <c>/api/contract-review/export-pdf</c>.
///     The server decodes -> renders PDF -> returns the
///     previewUrl to the client for both the inline EJ2
///     PDF viewer and the download link.
/// </summary>
[ApiController]
[Route("api/contract-review")]
public class ContractReviewController : ControllerBase
{
    private readonly IWebHostEnvironment _environment;
    private readonly PerSessionFileStore _fileStore;
    private readonly ILogger<ContractReviewController> _logger;
    private readonly AIChangeSummaryGenerator _summaryGenerator;
    private readonly HtmlToDocxConverter _htmlToDocxConverter;

    public ContractReviewController(
        IWebHostEnvironment environment,
        PerSessionFileStore fileStore,
        ILogger<ContractReviewController> logger,
        AIChangeSummaryGenerator summaryGenerator,
        HtmlToDocxConverter htmlToDocxConverter)
    {
        _environment = environment;
        _fileStore = fileStore;
        _logger = logger;
        _summaryGenerator = summaryGenerator;
        _htmlToDocxConverter = htmlToDocxConverter;
    }

    private string AppUrl(string path)
    {
        var basePath = HttpContext?.Request.PathBase.Value?.TrimEnd('/') ?? string.Empty;
        if (string.IsNullOrWhiteSpace(path))
        {
            return string.IsNullOrWhiteSpace(basePath) ? "/" : basePath;
        }
        if (!path.StartsWith('/'))
        {
            path = "/" + path;
        }
        return string.IsNullOrWhiteSpace(basePath) ? path : basePath + path;
    }

    // -----------------------------------------------------------------
    // GET /api/contract-review/templates
    // -----------------------------------------------------------------
    [HttpGet("templates")]
    public IActionResult GetTemplates()
    {
        var webRoot = _environment.WebRootPath ?? Path.Combine(_environment.ContentRootPath, "wwwroot");
        var templatesRoot = Path.Combine(webRoot, "templatefiles", "contract-review");
        var templates = new List<object>();
        if (Directory.Exists(templatesRoot))
        {
            foreach (var file in Directory.EnumerateFiles(templatesRoot, "*.docx", SearchOption.TopDirectoryOnly))
            {
                var fileName = Path.GetFileName(file);
                var info = new FileInfo(file);
                templates.Add(new
                {
                    fileName,
                    displayName = Path.GetFileNameWithoutExtension(fileName),
                    side = GuessSide(fileName),
                    fileType = "Word",
                    fileSize = info.Exists ? info.Length : 0L
                });
            }
        }
        var ordered = templates
            .OrderBy(t =>
            {
                var p = t.GetType().GetProperty("fileName");
                return p?.GetValue(t) as string ?? string.Empty;
            }, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return Ok(new { templates = ordered });
    }

    // -----------------------------------------------------------------
    // POST /api/contract-review/upload
    // -----------------------------------------------------------------
    [HttpPost("upload")]
    [RequestSizeLimit(long.MaxValue)]
    public async Task<IActionResult> Upload([FromForm] IFormFile document, CancellationToken ct)
    {
        if (document is null || document.Length == 0)
        {
            return BadRequest(new { success = false, message = "Upload a DOCX file." });
        }
        var extension = Path.GetExtension(document.FileName);
        if (!extension.Equals(".docx", StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest(new { success = false, message = "Only .docx files are supported." });
        }
        var sessionRoot = _fileStore.GetSessionRoot();
        var baseName = Path.GetFileNameWithoutExtension(document.FileName);
        var storedFileName = $"{baseName}-{Guid.NewGuid():N}{extension}";
        var storedPath = Path.Combine(sessionRoot, storedFileName);
        await using (var fs = System.IO.File.Create(storedPath))
        {
            await document.CopyToAsync(fs, ct);
        }
        return Ok(new
        {
            success = true,
            fileName = document.FileName,
            displayName = baseName,
            previewUrl = AppUrl(BuildSessionPreviewUrl(storedFileName)),
            contentType = document.ContentType,
            fileType = "Word",
            fileSize = new FileInfo(storedPath).Length,
            side = GuessSide(document.FileName)
        });
    }

    // -----------------------------------------------------------------
    // POST /api/contract-review/upload-by-template
    // -----------------------------------------------------------------
    [HttpPost("upload-by-template")]
    public async Task<IActionResult> UploadByTemplate(
        [FromBody] ContractReviewUploadByTemplateRequest request,
        CancellationToken ct)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.FileName))
        {
            return BadRequest(new { success = false, message = "Missing file name." });
        }
        var webRoot = _environment.WebRootPath ?? Path.Combine(_environment.ContentRootPath, "wwwroot");
        var templatePath = Path.Combine(webRoot, "templatefiles", "contract-review", Path.GetFileName(request.FileName));
        if (!System.IO.File.Exists(templatePath))
        {
            return NotFound(new { success = false, message = "Template not found." });
        }
        // Honour an explicit SessionKey from the
        // client so two parallel /upload-by-template
        // calls land in the same per-session folder.
        // Without this, each parallel request has its
        // own HttpContext with no inbound cookie and
        // mints a different session key, scattering
        // the two files across two folders. See
        // ContractReviewUploadByTemplateRequest for
        // the full rationale.
        var sessionRoot = !string.IsNullOrWhiteSpace(request.SessionKey)
            ? _fileStore.AdoptSessionKey(request.SessionKey)
            : _fileStore.GetSessionRoot();
        var safe = Path.GetFileName(request.FileName);
        var storedFileName = $"{Path.GetFileNameWithoutExtension(safe)}-{Guid.NewGuid():N}{Path.GetExtension(safe)}";
        var storedPath = Path.Combine(sessionRoot, storedFileName);
        await using (var source = System.IO.File.OpenRead(templatePath))
        await using (var destination = System.IO.File.Create(storedPath))
        {
            await source.CopyToAsync(destination, ct);
        }
        return Ok(new
        {
            success = true,
            fileName = safe,
            displayName = Path.GetFileNameWithoutExtension(safe),
            previewUrl = AppUrl(BuildSessionPreviewUrl(storedFileName)),
            contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            fileType = "Word",
            fileSize = new FileInfo(storedPath).Length,
            side = GuessSide(safe)
        });
    }

    // -----------------------------------------------------------------
    // -----------------------------------------------------------------
    // POST /api/contract-review/import-sfdt
    //
    // Convert a per-session DOCX (resolved via previewUrl) into
    // SFDT JSON so the EJ2 DocumentEditor can open it directly.
    // Syncfusion.DocIO does not expose a FormatType.Sfdt, so
    // the conversion is implemented in
    // <see cref="SfdtEmitter"/>: we walk every WParagraph /
    // WTextRange in the DocIO model and emit the minimal JSON
    // envelope the EJ2 DocumentEditorContainer expects when
    // serviceUrl is empty.
    // -----------------------------------------------------------------
    [HttpPost("import-sfdt")]
    public IActionResult ImportSfdt([FromBody] ContractReviewPreviewRequest request)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.PreviewUrl))
        {
            return BadRequest(new { success = false, message = "Missing previewUrl." });
        }
        var filePath = ResolveSessionPath(request.PreviewUrl);
        if (string.IsNullOrWhiteSpace(filePath) || !System.IO.File.Exists(filePath))
        {
            return NotFound(new { success = false, message = "File not found." });
        }
        try
        {
            using var document = new WordDocument(filePath, FormatType.Docx);
            var sfdt = SfdtEmitter.Build(document);
            return Ok(new { success = true, sfdt, previewUrl = request.PreviewUrl });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to import DOCX as SFDT");
            return StatusCode(500, new { success = false, message = "Could not load document into the editor." });
        }
    }

    // -----------------------------------------------------------------
    // POST /api/contract-review/import
    //
    // Multipart upload counterpart to ImportSfdt: the EJ2
    // DocumentEditor calls POST /api/documenteditor/Import
    // when serviceUrl is set. We expose the same shape on the
    // contract-review controller so the Syncfusion Compare sample
    // can drop straight into our pipeline (top toolbar Compare
    // button submits FormData with originalFile + revisedFile to
    // /CompareDocuments; per-file openers submit a single
    // FormData with `file` to /Import). Returns the SFDT
    // envelope plus the persisted previewUrl so the page can
    // refresh chip metadata.
    // -----------------------------------------------------------------
    [HttpPost("import")]
    [RequestSizeLimit(long.MaxValue)]
    public async Task<IActionResult> Import([FromForm] IFormFile file, CancellationToken ct)
    {
        if (file is null || file.Length == 0)
        {
            return BadRequest(new { success = false, message = "Upload a DOCX file." });
        }
        if (!string.Equals(Path.GetExtension(file.FileName), ".docx", StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest(new { success = false, message = "Only .docx files are supported." });
        }
        var storedName = await SaveUploadedAsync(file, ct);
        var previewUrl = AppUrl(BuildSessionPreviewUrl(storedName));
        try
        {
            var storedPath = Path.Combine(_fileStore.GetSessionRoot(), storedName);
            using var document = new WordDocument(storedPath, FormatType.Docx);
            var sfdt = SfdtEmitter.Build(document);
            return Ok(new { success = true, sfdt, previewUrl });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to import DOCX ({stored})", storedName);
            return StatusCode(500, new { success = false, message = "Could not load document into the editor." });
        }
    }

    // -----------------------------------------------------------------
    // POST /api/contract-review/compare-documents
    //
    // Mirrors Syncfusion's CompareDocuments reference sample.
    // Accepts multipart upload with `originalFile` + `revisedFile`
    // (plus optional `author` and `dateTime`), runs
    // WordDocument.Compare, emits the resulting track-changes
    // SFDT as the response body so the Result document editor
    // can `open(sfdt)` directly. Persists the negotiated DOCX
    // to the per-session Generated subfolder for later export.
    // -----------------------------------------------------------------
    [HttpPost("compare-documents")]
    [RequestSizeLimit(long.MaxValue)]
    public async Task<IActionResult> CompareDocuments(
        [FromForm] IFormFile originalFile,
        [FromForm] IFormFile revisedFile,
        [FromForm] string? author,
        [FromForm] string? dateTime,
        CancellationToken ct)
    {
        if (originalFile is null || originalFile.Length == 0)
        {
            return BadRequest(new { success = false, message = "Missing original document." });
        }
        if (revisedFile is null || revisedFile.Length == 0)
        {
            return BadRequest(new { success = false, message = "Missing revised document." });
        }
        if (!string.Equals(Path.GetExtension(originalFile.FileName), ".docx", StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetExtension(revisedFile.FileName), ".docx", StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest(new { success = false, message = "Both files must be .docx." });
        }
        var authorName = string.IsNullOrWhiteSpace(author) ? "Counterparty" : author!;
        DateTime authorDate;
        if (!DateTime.TryParse(dateTime, out authorDate))
        {
            authorDate = DateTime.Now;
        }

        var tempDir = Path.Combine(Path.GetTempPath(), $"cr-compare-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempDir);
        var originalPath = Path.Combine(tempDir, "original.docx");
        var revisedPath = Path.Combine(tempDir, "revised.docx");
        var negotiatedPath = Path.Combine(tempDir, "negotiated.docx");

        try
        {
            await using (var ofs = System.IO.File.Create(originalPath))
            {
                await originalFile.CopyToAsync(ofs, ct);
            }
            await using (var rfs = System.IO.File.Create(revisedPath))
            {
                await revisedFile.CopyToAsync(rfs, ct);
            }

            using (var originalStream = System.IO.File.OpenRead(originalPath))
            using (var original = new WordDocument(originalStream, FormatType.Docx))
            using (var revisedStream = System.IO.File.OpenRead(revisedPath))
            using (var revised = new WordDocument(revisedStream, FormatType.Docx))
            {
                original.Compare(revised, authorName, authorDate);
                using (var negotiatedFs = System.IO.File.Create(negotiatedPath))
                {
                    original.Save(negotiatedFs, FormatType.Docx);
                }
            }

            // Persist the negotiated DOCX in Generated/ so the
            // Export step can hand it straight back to DocIO's
            // renderer without going back through the client.
            var generatedDir = Path.Combine(_fileStore.GetSessionRoot(), PerSessionFileStore.GeneratedSubFolder);
            Directory.CreateDirectory(generatedDir);
            var storedNegotiated = $"negotiated-{Guid.NewGuid():N}.docx";
            var storedNegotiatedPath = Path.Combine(generatedDir, storedNegotiated);
            System.IO.File.Copy(negotiatedPath, storedNegotiatedPath, overwrite: true);

            using (var fs = System.IO.File.OpenRead(storedNegotiatedPath))
            using (var doc = new WordDocument(fs, FormatType.Docx))
            {
                var sfdt = SfdtEmitter.Build(doc);
                return Ok(new
                {
                    success = true,
                    author = authorName,
                    negotiatedPreviewUrl = AppUrl(BuildGeneratedPreviewUrl(storedNegotiated)),
                    sfdt
                });
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "CompareDocuments failed");
            return StatusCode(500, new
            {
                success = false,
                message = "Could not compare the documents. Make sure both are valid DOCX files."
            });
        }
        finally
        {
            try { if (Directory.Exists(tempDir)) { Directory.Delete(tempDir, recursive: true); } }
            catch { /* best-effort cleanup */ }
        }
    }

    private async Task<string> SaveUploadedAsync(IFormFile file, CancellationToken ct)
    {
        var sessionRoot = _fileStore.GetSessionRoot();
        var baseName = Path.GetFileNameWithoutExtension(file.FileName);
        var storedFileName = $"{baseName}-{Guid.NewGuid():N}{Path.GetExtension(file.FileName)}";
        var storedPath = Path.Combine(sessionRoot, storedFileName);
        await using (var fs = System.IO.File.Create(storedPath))
        {
            await file.CopyToAsync(fs, ct);
        }
        return storedFileName;
    }

    // POST /api/contract-review/compare
    //
    // Body: { originalPreviewUrl, revisedPreviewUrl, author }
    // Resolves both per-session DOCX files, opens them with
    // DocIO, calls WordDocument.Compare(), and writes the
    // resulting DOCX (with track-changes markers preserved)
    // to the Generated subfolder. Returns the negotiated
    // previewUrl so the centre-panel DOCX editor can fetch
    // it directly.
    // -----------------------------------------------------------------
    [HttpPost("compare")]
    public IActionResult Compare([FromBody] CompareRequest request)
    {
        if (request is null ||
            string.IsNullOrWhiteSpace(request.OriginalPreviewUrl) ||
            string.IsNullOrWhiteSpace(request.RevisedPreviewUrl))
        {
            return BadRequest(new { success = false, message = "Missing original or revised previewUrl." });
        }
        var originalPath = ResolveSessionPath(request.OriginalPreviewUrl);
        var revisedPath = ResolveSessionPath(request.RevisedPreviewUrl);
        if (string.IsNullOrWhiteSpace(originalPath) || !System.IO.File.Exists(originalPath))
        {
            return NotFound(new { success = false, message = "Original document not found." });
        }
        if (string.IsNullOrWhiteSpace(revisedPath) || !System.IO.File.Exists(revisedPath))
        {
            return NotFound(new { success = false, message = "Revised document not found." });
        }

        try
        {
            var author = string.IsNullOrWhiteSpace(request.Author) ? "Counterparty" : request.Author!;
            using var originalStream = System.IO.File.OpenRead(originalPath);
            using var original = new WordDocument(originalStream, FormatType.Docx);
            using var revisedStream = System.IO.File.OpenRead(revisedPath);
            using var revised = new WordDocument(revisedStream, FormatType.Docx);
            // WordDocument.Compare mutates "original" to carry
            // every edit (insertion / deletion / formatting)
            // as a Word track-changes revision. After the call
            // the document is "in revision" and the EJ2 editor
            // will render those revisions inline on the
            // right-hand side; Accept / Reject mutates the
            // document body in place, then triggers our
            // beforeAcceptRejectChanges event.
            original.Compare(revised, author, DateTime.Now);

            var generatedDir = Path.Combine(_fileStore.GetSessionRoot(), PerSessionFileStore.GeneratedSubFolder);
            Directory.CreateDirectory(generatedDir);
            var negotiatedFileName = $"negotiated-{Guid.NewGuid():N}.docx";
            var negotiatedPath = Path.Combine(generatedDir, negotiatedFileName);
            using (var fs = System.IO.File.Create(negotiatedPath))
            {
                original.Save(fs, FormatType.Docx);
            }

            return Ok(new
            {
                success = true,
                author,
                originalPreviewUrl = request.OriginalPreviewUrl,
                revisedPreviewUrl = request.RevisedPreviewUrl,
                negotiatedPreviewUrl = AppUrl(BuildGeneratedPreviewUrl(negotiatedFileName)),
                negotiatedFileName,
                fileSize = new FileInfo(negotiatedPath).Length
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "WordDocument.Compare failed for original/revised pair");
            return StatusCode(500, new { success = false, message = "Could not compare the documents. Make sure both are valid DOCX files." });
        }
    }

    // -----------------------------------------------------------------
    // POST /api/contract-review/export-pdf
    //
    // Receives a base64-encoded DOCX blob captured via
    // editor.saveAsBlob('Docx') on the client. Decodes,
    // renders PDF via DocIORenderer, stores in Generated
    // subfolder, returns the previewUrl for both the embedded
    // EJ2 PDF viewer and the "Download PDF" link.
    // -----------------------------------------------------------------
    [HttpPost("export-pdf")]
    public IActionResult ExportPdf([FromBody] ExportPdfRequest request)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.DocxBase64))
        {
            return BadRequest(new { success = false, message = "Missing DOCX payload." });
        }

        byte[] docxBytes;
        try
        {
            docxBytes = Convert.FromBase64String(request.DocxBase64);
        }
        catch (FormatException)
        {
            return BadRequest(new { success = false, message = "The DOCX payload was not valid base64." });
        }
        if (docxBytes.Length == 0)
        {
            return BadRequest(new { success = false, message = "The DOCX payload was empty." });
        }

        // DocIO does not render Word's track-changes to PDF
        // by default. The user has already negotiated every
        // change in the editor (Accept/Reject) before reaching
        // Export, so the resulting DOCX must already be clean.
        // As a defence-in-depth measure, accept any leftover
        // revisions so the PDF reflects the negotiated state
        // even if the editor failed to drop them.
        var tempDir = Path.Combine(Path.GetTempPath(), $"contract-export-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempDir);
        var docxPath = Path.Combine(tempDir, "source.docx");
        try
        {
            System.IO.File.WriteAllBytes(docxPath, docxBytes);
            using (var doc = new WordDocument(docxPath, FormatType.Docx))
            {
                doc.Revisions.AcceptAll();
                using (var fs = System.IO.File.Create(docxPath))
                {
                    doc.Save(fs, FormatType.Docx);
                }
            }
            using (var clean = new WordDocument(docxPath, FormatType.Docx))
            {
                using var renderer = new DocIORendererType();
                using var pdf = renderer.ConvertToPDF(clean);
                var generatedDir = Path.Combine(_fileStore.GetSessionRoot(), PerSessionFileStore.GeneratedSubFolder);
                Directory.CreateDirectory(generatedDir);
                var pdfFileName = $"contract-review-{Guid.NewGuid():N}.pdf";
                var pdfPathFinal = Path.Combine(generatedDir, pdfFileName);
                using (var fs = System.IO.File.Create(pdfPathFinal))
                {
                    pdf.Save(fs);
                }
                var publicUrl = AppUrl(BuildGeneratedPreviewUrl(pdfFileName));
                return Ok(new
                {
                    success = true,
                    fileName = pdfFileName,
                    previewUrl = publicUrl,
                    downloadUrl = publicUrl,
                    fileSize = new FileInfo(pdfPathFinal).Length,
                    fileType = "PDF"
                });
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to render DOCX to PDF");
            return StatusCode(500, new { success = false, message = "Could not export the contract as a PDF." });
        }
        finally
        {
            try
            {
                if (Directory.Exists(tempDir))
                {
                    Directory.Delete(tempDir, recursive: true);
                }
            }
            catch { /* temp cleanup is best-effort */ }
        }
    }

    // -----------------------------------------------------------------
    // POST /api/contract-review/ai-summary-pdf
    //
    // Receives a base64-encoded DOCX captured via
    // editor.saveAsBlob('Docx') on the AI summary
    // page. The DOCX reflects the user's edits (the
    // AI summary page mounts an EDITABLE EJ2
    // DocumentEditor, so by the time the user clicks
    // "Proceed to Export" the document has whatever
    // changes they applied). Decodes -> renders PDF
    // via DocIORenderer.ConvertToPDF -> persists in
    // the per-session Generated subfolder -> returns
    // the previewUrl so the Export page can show a
    // Download + Preview button for the PDF.
    //
    // Eagerly invoked from the "Proceed to Export"
    // button on the AI summary page, in parallel with
    // the reviewed-contract PDF render. By the time
    // the user lands on the Export page, both PDFs
    // are on disk and Download + Preview are live.
    // -----------------------------------------------------------------
    [HttpPost("ai-summary-pdf")]
    public IActionResult ExportAiSummaryPdf([FromBody] ExportPdfRequest request)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.DocxBase64))
        {
            return BadRequest(new { success = false, message = "Missing DOCX payload." });
        }

        byte[] docxBytes;
        try
        {
            docxBytes = Convert.FromBase64String(request.DocxBase64);
        }
        catch (FormatException)
        {
            return BadRequest(new { success = false, message = "The DOCX payload was not valid base64." });
        }
        if (docxBytes.Length == 0)
        {
            return BadRequest(new { success = false, message = "The DOCX payload was empty." });
        }

        var tempDir = Path.Combine(Path.GetTempPath(), $"ai-summary-pdf-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempDir);
        var docxPath = Path.Combine(tempDir, "source.docx");
        try
        {
            System.IO.File.WriteAllBytes(docxPath, docxBytes);
            using (var doc = new WordDocument(docxPath, FormatType.Docx))
            using (var renderer = new DocIORendererType())
            using (var pdf = renderer.ConvertToPDF(doc))
            {
                var generatedDir = Path.Combine(_fileStore.GetSessionRoot(), PerSessionFileStore.GeneratedSubFolder);
                Directory.CreateDirectory(generatedDir);
                var pdfFileName = $"ai-summary-{Guid.NewGuid():N}.pdf";
                var pdfPathFinal = Path.Combine(generatedDir, pdfFileName);
                using (var fs = System.IO.File.Create(pdfPathFinal))
                {
                    pdf.Save(fs);
                }
                var publicUrl = AppUrl(BuildGeneratedPreviewUrl(pdfFileName));
                return Ok(new
                {
                    success = true,
                    fileName = pdfFileName,
                    previewUrl = publicUrl,
                    downloadUrl = publicUrl,
                    fileSize = new FileInfo(pdfPathFinal).Length,
                    fileType = "PDF"
                });
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to render AI summary DOCX to PDF");
            return StatusCode(500, new { success = false, message = "Could not export the AI summary as a PDF." });
        }
        finally
        {
            try
            {
                if (Directory.Exists(tempDir))
                {
                    Directory.Delete(tempDir, recursive: true);
                }
            }
            catch { /* temp cleanup is best-effort */ }
        }
    }

    // -----------------------------------------------------------------
    // POST /api/contract-review/ai-summary-save-pdf
    //
    // Save the AI summary as a PDF on the server. The
    // request body is the live SFDT JSON serialised
    // from the EJ2 DocumentEditor via
    // `container.documentEditor.serialize()`. The
    // shape `{ content: "<sfdt>" }` matches the
    // Syncfusion reference pattern (their
    // /api/documenteditor/ExportPdf endpoint uses the
    // same DTO). The server walks the canonical
    // Syncfusion pipeline:
    //   1. Parse the SFDT JSON into a WordDocument
    //      via SfdtIngestor.Build(sfdt). The modern
    //      DocIO/EJ2 NuGet packages (34.x) do not
    //      ship the static
    //      `WordDocument.Save(sfdt, FormatType.Docx)`
    //      helper that older Web API templates used;
    //      SfdtIngestor is the in-process equivalent
    //      that walks the SFDT schema (the same
    //      schema SfdtEmitter emits) and appends
    //      paragraphs + text runs to a fresh
    //      WordDocument.
    //   2. Render the Word document to PDF via
    //      DocIORenderer.ConvertToPDF.
    //   3. Persist the PDF in the per-session
    //      Generated subfolder.
    //   4. Return the previewUrl so the Export page
    //      can show Download / Preview.
    //
    // Invoked from the Save button in the AI summary
    // editor's toolbar. The user can hit Save
    // multiple times to refresh the PDF after
    // additional edits; the Export page picks up the
    // latest aiSummaryPdfPreviewUrl from state.
    // -----------------------------------------------------------------
    [HttpPost("ai-summary-save-pdf")]
    public IActionResult SaveAiSummaryAsPdf([FromBody] SaveAiSummaryRequest request)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.Content))
        {
            return BadRequest(new { success = false, message = "Missing SFDT content." });
        }
        try
        {
            // Step 1: SFDT -> WordDocument. The
            // parser is the inverse of SfdtEmitter:
            // it reads sections/blocks/inlines and
            // builds paragraphs in a fresh document
            // so DocIORenderer can render them. The
            // SFDT is the live editor state
            // (container.documentEditor.serialize()),
            // so any edits the user made to the AI
            // summary text are reflected in the PDF.
            using var doc = SfdtIngestor.Build(request.Content);
            // Step 2: WordDocument -> PDF.
            using var renderer = new DocIORendererType();
            using var pdf = renderer.ConvertToPDF(doc);
            // Step 3: persist under the per-session
            // Generated/ subfolder. A fresh Guid
            // per Save click avoids stale PDFs
            // accumulating and keeps each Save
            // click idempotent.
            var generatedDir = Path.Combine(_fileStore.GetSessionRoot(), PerSessionFileStore.GeneratedSubFolder);
            Directory.CreateDirectory(generatedDir);
            var pdfFileName = $"ai-summary-{Guid.NewGuid():N}.pdf";
            var pdfPathFinal = Path.Combine(generatedDir, pdfFileName);
            using (var fs = System.IO.File.Create(pdfPathFinal))
            {
                pdf.Save(fs);
            }
            // Step 4: return the public URL the
            // Export page will use for Download +
            // Preview.
            var publicUrl = AppUrl(BuildGeneratedPreviewUrl(pdfFileName));
            return Ok(new
            {
                success = true,
                fileName = pdfFileName,
                previewUrl = publicUrl,
                downloadUrl = publicUrl,
                fileSize = new FileInfo(pdfPathFinal).Length,
                fileType = "PDF"
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to save AI summary as PDF from SFDT");
            return StatusCode(500, new { success = false, message = "Could not save the AI summary as a PDF." });
        }
    }

    // POST /api/contract-review/ai-summary-save-docx
    //
    // Persist the user's edited AI summary DOCX verbatim
    // in the per-session Generated subfolder. Sister of
    // /ai-summary-pdf: same body shape, but writes DOCX
    // bytes instead of rendering to PDF. The client
    // (contractReview.js) stashes the returned previewUrl
    // on state.aiSummaryEditedDocxPreviewUrl and
    // openAiSummaryDocx prefers it over the original AI
    // model output, so the editor rehydrates with the
    // user's edits on revisit. Invoked from the Save
    // toolbar item and the "Proceed to Export" handler.
    [HttpPost("ai-summary-save-docx")]
    public IActionResult SaveAiSummaryDocx([FromBody] ExportPdfRequest request)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.DocxBase64))
        {
            return BadRequest(new { success = false, message = "Missing DOCX payload." });
        }

        byte[] docxBytes;
        try
        {
            docxBytes = Convert.FromBase64String(request.DocxBase64);
        }
        catch (FormatException)
        {
            return BadRequest(new { success = false, message = "The DOCX payload was not valid base64." });
        }
        if (docxBytes.Length < 1024)
        {
            // A real DOCX is always at least a few KB; reject
            // anything smaller so we don't litter the per-session
            // folder with corrupt files the editor will fail to open.
            return BadRequest(new { success = false, message = "The DOCX payload was too small to be a real Word document." });
        }

        try
        {
            var generatedDir = Path.Combine(_fileStore.GetSessionRoot(), PerSessionFileStore.GeneratedSubFolder);
            Directory.CreateDirectory(generatedDir);
            var docxFileName = $"ai-summary-edited-{Guid.NewGuid():N}.docx";
            var docxPathFinal = Path.Combine(generatedDir, docxFileName);
            System.IO.File.WriteAllBytes(docxPathFinal, docxBytes);
            var publicUrl = AppUrl(BuildGeneratedPreviewUrl(docxFileName));
            return Ok(new
            {
                success = true,
                fileName = docxFileName,
                previewUrl = publicUrl,
                downloadUrl = publicUrl,
                fileSize = docxBytes.Length,
                fileType = "Word"
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to save AI summary edited DOCX");
            return StatusCode(500, new { success = false, message = "Could not save the AI summary DOCX." });
        }
    }

    // -----------------------------------------------------------------
    // GET /api/contract-review/preview/{*fileName}
    // -----------------------------------------------------------------
    [HttpGet("preview/{*fileName}")]
    public IActionResult PreviewSessionFile(string? fileName)
    {
        return ServeSessionFileByRelativePath(fileName);
    }

    private IActionResult ServeSessionFileByRelativePath(string? relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath))
        {
            return BadRequest(new { success = false, message = "Missing file path." });
        }
        var decoded = Uri.UnescapeDataString(relativePath);
        var safeRelative = decoded.Replace('\\', '/').TrimStart('/');
        if (safeRelative.Contains("..", StringComparison.Ordinal))
        {
            return BadRequest(new { success = false, message = "Invalid file path." });
        }
        var sessionKey = _fileStore.GetOrCreateSessionKey();
        var sessionRoot = _fileStore.GetSessionRoot();
        if (!safeRelative.StartsWith(sessionKey + "/", StringComparison.Ordinal))
        {
            return NotFound(new { success = false, message = "File not found." });
        }
        var tail = safeRelative[(sessionKey.Length + 1)..];
        var cleaned = tail.Replace('/', Path.DirectorySeparatorChar);
        var resolved = Path.GetFullPath(Path.Combine(sessionRoot, cleaned));
        var rootWithSep = sessionRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!resolved.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest(new { success = false, message = "Invalid file path." });
        }
        if (!System.IO.File.Exists(resolved))
        {
            return NotFound(new { success = false, message = "File not found." });
        }

        var contentType = "application/octet-stream";
        if (resolved.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)) contentType = "application/pdf";
        else if (resolved.EndsWith(".docx", StringComparison.OrdinalIgnoreCase))
        {
            contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        }
        else if (resolved.EndsWith(".doc", StringComparison.OrdinalIgnoreCase))
        {
            contentType = "application/msword";
        }

        Response.Headers["Cache-Control"] = "private, max-age=86400, immutable";
        Response.Headers["Accept-Ranges"] = "bytes";
        var stream = System.IO.File.OpenRead(resolved);
        return new FileStreamResult(stream, contentType)
        {
            EnableRangeProcessing = true
        };
    }

    // -----------------------------------------------------------------
    // POST /api/contract-review/wipe
    // -----------------------------------------------------------------
    [HttpPost("wipe")]
    public IActionResult Wipe()
    {
        _fileStore.PurgeCurrentSession();
        var newKey = RandomNumberGenerator.GetInt32(int.MinValue, int.MaxValue).ToString("X") + Guid.NewGuid().ToString("N");
        Response.Cookies.Append(
            PerSessionFileStore.SessionCookieName,
            newKey,
            new CookieOptions
            {
                HttpOnly = true,
                SameSite = SameSiteMode.Lax,
                IsEssential = true,
                Path = "/",
                Secure = Request.IsHttps,
                MaxAge = _fileStore.SessionLifetime
            });
        return Ok(new { success = true });
    }

    // -----------------------------------------------------------------
    // GET /api/contract-review/policy
    // -----------------------------------------------------------------
    [HttpGet("policy")]
    public IActionResult Policy()
    {
        var lifetime = _fileStore.SessionLifetime;
        return Ok(new
        {
            sessionLifetimeMs = (long)lifetime.TotalMilliseconds,
            sessionLifetimeHours = lifetime.TotalHours
        });
    }

    // -----------------------------------------------------------------
    // POST /api/contract-review/ai-summary
    //
    // Accepts the in-memory change log captured by the
    // Compare view (one entry per Accept / Reject action,
    // each carrying the SFDT content snapshot, author,
    // action type and timestamp). The server hands the
    // payload to AIChangeSummaryGenerator, which returns a
    // concise HTML summary. The HTML is also converted to
    // DOCX via HtmlToDocxConverter, persisted into the
    // per-session Generated subfolder, and the response
    // carries the SFDT (so the EJ2 DocumentEditor on the
    // AI summary page can `documentEditor.open(sfdt)`
    // directly), the DOCX preview URL (for the Export
    // page's Download / Preview actions) and the raw HTML
    // (for any future inline preview surface).
    // -----------------------------------------------------------------
    [HttpPost("ai-summary")]
    public async Task<IActionResult> GenerateAiSummary([FromBody] AiSummaryRequest request, CancellationToken ct)
    {
        if (request is null || request.Entries is null || request.Entries.Count == 0)
        {
            return BadRequest(new { success = false, message = "Change log is empty." });
        }

        try
        {
            var entries = request.Entries
                .Select(e => new ChangeLogEntry
                {
                    At = e.At,
                    Author = e.Author,
                    Action = e.Action,
                    Detail = e.Detail,
                    ContentSfdt = e.ContentSfdt
                })
                .ToList();

            var summaryHtml = await _summaryGenerator
                .GenerateSummaryHtmlAsync(entries, ct)
                .ConfigureAwait(false);

            // Persist the DOCX in Generated/ so the
            // Export page can hand it back to the user.
            // The naming convention follows the
            // negotiated/exported DOCX so the existing
            // preview URL routing works without
            // modification.
            var generatedDir = Path.Combine(_fileStore.GetSessionRoot(), PerSessionFileStore.GeneratedSubFolder);
            Directory.CreateDirectory(generatedDir);
            var summaryFileName = $"ai-summary-{Guid.NewGuid():N}.docx";
            var summaryPath = Path.Combine(generatedDir, summaryFileName);
            _htmlToDocxConverter.ConvertToFile(
                summaryHtml,
                summaryPath,
                title: "AI Contract Review Summary");

            // Convert to SFDT for the EJ2 DocumentEditor
            // on the AI summary page. The converter is
            // the same one used by /api/contract-review/
            // import and import-sfdt, so the editor
            // receives a JSON envelope it can `open()`
            // directly.
            using (var doc = new WordDocument(summaryPath, FormatType.Docx))
            {
                var sfdt = SfdtEmitter.Build(doc);
                var previewUrl = AppUrl(BuildGeneratedPreviewUrl(summaryFileName));

                return Ok(new
                {
                    success = true,
                    summaryHtml,
                    sfdt,
                    previewUrl,
                    fileName = summaryFileName,
                    fileSize = new FileInfo(summaryPath).Length,
                    entryCount = entries.Count
                });
            }
        }
        catch (OperationCanceledException)
        {
            return StatusCode(499, new { success = false, message = "AI summary generation was cancelled." });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "AI summary generation failed");
            return StatusCode(500, new { success = false, message = "Could not generate the AI summary." });
        }
    }

    // -----------------------------------------------------------------
    // GET /api/contract-review/ai-summary-sfdt
    //
    // Re-emit the persisted AI summary DOCX as SFDT. Used
    // by the AI summary page when the user navigates back
    // to it after a page reload - the DOCX is already on
    // disk, so re-running the model is wasteful. The
    // client passes the fileName (which it persisted on
    // state.aiSummaryFileName) and we look the file up
    // under the per-session Generated subfolder.
    // -----------------------------------------------------------------
    [HttpGet("ai-summary-sfdt")]
    public IActionResult GetAiSummarySfdt([FromQuery] string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName))
        {
            return BadRequest(new { success = false, message = "Missing fileName." });
        }
        var generatedDir = Path.Combine(_fileStore.GetSessionRoot(), PerSessionFileStore.GeneratedSubFolder);
        var path = Path.Combine(generatedDir, Path.GetFileName(fileName));
        if (!System.IO.File.Exists(path))
        {
            return NotFound(new { success = false, message = "Summary file not found." });
        }
        try
        {
            using var document = new WordDocument(path, FormatType.Docx);
            var sfdt = SfdtEmitter.Build(document);
            return Ok(new { success = true, sfdt, previewUrl = AppUrl(BuildGeneratedPreviewUrl(fileName)) });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load AI summary DOCX as SFDT");
            return StatusCode(500, new { success = false, message = "Could not load the AI summary." });
        }
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------
    private string BuildSessionPreviewUrl(string storedFileName)
    {
        var key = _fileStore.GetOrCreateSessionKey();
        return $"/uploads/{key}/{storedFileName}";
    }

    private string BuildGeneratedPreviewUrl(string storedFileName)
    {
        var key = _fileStore.GetOrCreateSessionKey();
        return $"/uploads/{key}/{PerSessionFileStore.GeneratedSubFolder}/{storedFileName}";
    }

    private string? ResolveSessionPath(string webRelativeUrl)
    {
        var path = webRelativeUrl.Replace('\\', '/').TrimStart('/');
        var pathBase = HttpContext?.Request.PathBase.Value?.TrimEnd('/') ?? string.Empty;
        if (!string.IsNullOrWhiteSpace(pathBase))
        {
            var prefix = pathBase.TrimStart('/');
            if (path.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase))
            {
                path = path[(prefix.Length + 1)..];
            }
            else if (string.Equals(path, prefix, StringComparison.OrdinalIgnoreCase))
            {
                path = string.Empty;
            }
        }
        var queryIndex = path.IndexOf('?', StringComparison.Ordinal);
        if (queryIndex >= 0)
        {
            path = path[..queryIndex];
        }

        if (!path.StartsWith("uploads/", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        var afterPrefix = path["uploads/".Length..];
        var slashIndex = afterPrefix.IndexOf('/');
        if (slashIndex <= 0)
        {
            return null;
        }
        var urlKey = afterPrefix[..slashIndex];
        var tail = afterPrefix[(slashIndex + 1)..];
        var root = _fileStore.UploadsRoot;
        var absolute = Path.GetFullPath(Path.Combine(root, urlKey, tail.Replace('/', Path.DirectorySeparatorChar)));
        var rootWithSep = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!absolute.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        return absolute;
    }

    private static string GuessSide(string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName))
        {
            return "Either";
        }
        var lower = fileName.ToLowerInvariant();
        if (lower.Contains("original"))
        {
            return "Original";
        }
        if (lower.Contains("redline") || lower.Contains("revised"))
        {
            return "Revised";
        }
        return "Either";
    }
}

public class ContractReviewUploadByTemplateRequest
{
    public string? FileName { get; set; }

    /// <summary>
    /// Optional explicit per-session key the client
    /// wants this upload to land under. When set, the
    /// controller will mint a session cookie tied to
    /// this key BEFORE the upload, so two parallel
    /// /upload-by-template calls that pass the same
    /// <c>SessionKey</c> end up in the same per-session
    /// folder even though they were issued in
    /// parallel and would otherwise have been served
    /// by two different <c>HttpContext</c>s that
    /// each minted a fresh key.
    ///
    /// Clients that don't pass this (single-threaded
    /// usage, or the first request of a session)
    /// fall back to the cookie-based default, which
    /// works as before.
    /// </summary>
    public string? SessionKey { get; set; }
}

public class CompareRequest
{
    public string? OriginalPreviewUrl { get; set; }
    public string? RevisedPreviewUrl { get; set; }
    public string? Author { get; set; }
    public string? ResultPreviewUrl { get; set; }
}

public class ExportPdfRequest
{
    public string? DocxBase64 { get; set; }
}

public class ContractReviewPreviewRequest
{
    public string? PreviewUrl { get; set; }
}

public class AiSummaryRequest
{
    public List<AiSummaryEntryDto>? Entries { get; set; }
}

public class AiSummaryEntryDto
{
    public long At { get; set; }
    public string? Author { get; set; }
    public string? Action { get; set; }
    public string? Detail { get; set; }
    public string? ContentSfdt { get; set; }
}

/// <summary>
/// Request body for
/// <c>POST /api/contract-review/ai-summary-save-pdf</c>.
/// The shape mirrors the Syncfusion reference
/// pattern: <c>{ content: "&lt;sfdt-json-string&gt;" }</c>.
/// The SFDT is what the EJ2 DocumentEditor
/// produces from
/// <c>container.documentEditor.serialize()</c>.
/// </summary>
public class SaveAiSummaryRequest
{
    public string? Content { get; set; }
}