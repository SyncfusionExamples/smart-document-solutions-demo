using Microsoft.AspNetCore.Mvc;
using Syncfusion.Drawing;
using Syncfusion.Pdf;
using Syncfusion.Pdf.Parsing;
using Syncfusion.Pdf.Redaction;
using Syncfusion.SmartDataExtractor;
using Syncfusion.SmartDemo.Models;
using Syncfusion.SmartDemo.Services;
using System.Net;
using System.Text.Json;

namespace Syncfusion.SmartDemo.Controllers;

[ApiController]
[Route("api/claim-intake")]
public class ClaimIntakeController : ControllerBase
{
    private readonly IWebHostEnvironment _environment;
    private readonly PerSessionFileStore _fileStore;
    private readonly ILogger<ClaimIntakeController> _logger;

    public ClaimIntakeController(
        IWebHostEnvironment environment,
        PerSessionFileStore fileStore,
        ILogger<ClaimIntakeController> logger)
    {
        _environment = environment;
        _fileStore = fileStore;
        _logger = logger;
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

    // Session-authorized file preview from persistent storage
    // (supports both /api/claim-intake/preview and legacy /uploads routes)
    [HttpGet("preview/{*fileName}")]
    public IActionResult PreviewSessionFile(string? fileName)
    {
        return ServeSessionFileByRelativePath(fileName);
    }

    [HttpGet("/uploads/{*path}")]
    public IActionResult ServeUploadsPath(string? path)
    {
        return ServeSessionFileByRelativePath(path);
    }

    private IActionResult ServeSessionFileByRelativePath(string? relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath))
        {
            return BadRequest(new { success = false, message = "Missing file path." });
        }

        // Normalize path and prevent traversal attacks
        var decoded = Uri.UnescapeDataString(relativePath);
        var safeRelative = decoded
            .Replace('\\', '/')
            .TrimStart('/');

        if (safeRelative.Contains("..", StringComparison.Ordinal))
        {
            return BadRequest(new { success = false, message = "Invalid file path." });
        }

        // Validate session ownership before serving file
        var slashIndex = safeRelative.IndexOf('/');
        if (slashIndex <= 0)
        {
            return BadRequest(new { success = false, message = "Invalid file path." });
        }

        var urlKey = safeRelative[..slashIndex];
        var currentKey = _fileStore.GetOrCreateSessionKey();
        if (!string.Equals(urlKey, currentKey, StringComparison.OrdinalIgnoreCase))
        {
            return NotFound(new { success = false, message = "File not found." });
        }

        var tail = safeRelative[(slashIndex + 1)..];

        var sessionRoot = _fileStore.GetSessionRoot();
        var absolute = Path.GetFullPath(Path.Combine(sessionRoot, tail.Replace('/', Path.DirectorySeparatorChar)));
        var rootWithSep = sessionRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!absolute.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase))
        {
            // Defensive: ensure path is under session root
            return BadRequest(new { success = false, message = "Invalid file path." });
        }

        if (!System.IO.File.Exists(absolute))
        {
            return NotFound(new { success = false, message = "File not found." });
        }

        var contentType = "application/octet-stream";
        if (absolute.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase))
        {
            contentType = "application/pdf";
        }
        else if (absolute.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
        {
            contentType = "image/png";
        }
        else if (absolute.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase) ||
                 absolute.EndsWith(".jpeg", StringComparison.OrdinalIgnoreCase))
        {
            contentType = "image/jpeg";
        }

        // Cache headers: the preview URL is per-session but
        // immutable for its lifetime (the file at that path
        // never changes once written), so the browser can
        // cache it aggressively. `private` because the URL
        // is keyed to the user's ci_session cookie, and
        // `immutable` so the browser skips revalidation on
        // repeat visits - this is the single biggest win for
        // live deployments where the network round-trip
        // dominates the EJ2 viewer's first-paint time.
        Response.Headers["Cache-Control"] = "private, max-age=86400, immutable";
        Response.Headers["Accept-Ranges"] = "bytes";

        var stream = System.IO.File.OpenRead(absolute);
        return new FileStreamResult(stream, contentType)
        {
            EnableRangeProcessing = true
        };
    }

    // Lists the PDF templates that the front-end offers on the "Choose" step.
    //
    // NEW (stateless) shape: the server returns the read-only
    // default template list from wwwroot/templatefiles only. The
    // client owns the per-document workflow state in localStorage
    // so the server has nothing to merge in here.
    [HttpGet("templates")]
    public IActionResult GetTemplates()
    {
        var webRoot = _environment.WebRootPath ?? Path.Combine(_environment.ContentRootPath, "wwwroot");
        var templatesRoot = Path.Combine(webRoot, "templatefiles");

        var templates = new List<object>();

        if (System.IO.Directory.Exists(templatesRoot))
        {
            foreach (var file in System.IO.Directory.EnumerateFiles(templatesRoot, "*.pdf", SearchOption.TopDirectoryOnly))
            {
                var fileName = System.IO.Path.GetFileName(file);
                if (string.IsNullOrWhiteSpace(fileName))
                {
                    continue;
                }

                var fileInfo = new FileInfo(file);
                templates.Add(new
                {
                    fileName,
                    displayName = System.IO.Path.GetFileNameWithoutExtension(fileName),
                    fileType = "PDF",
                    fileSize = fileInfo.Exists ? fileInfo.Length : 0L,
                    pageCount = GetPdfPageCount(file, fileName)
                });
            }
        }

        var orderedTemplates = templates
            .OrderBy(t =>
            {
                var prop = t.GetType().GetProperty("fileName");
                return prop?.GetValue(t) as string ?? string.Empty;
            }, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return Ok(new { templates = orderedTemplates });
    }


    /// <summary>
    /// Convert a web-relative URL to an absolute on-disk session
    /// path. Strips the request's PathBase prefix, then tries
    /// three resolvers in order: (1) the inbound ci_session
    /// cookie, (2) the caller's explicit SessionKey, (3) the
    /// key embedded in the URL itself. Returns null if the URL
    /// is invalid or the file does not exist.
    /// </summary>
    private string? ResolveSessionPath(string? webRelativeUrl, string? explicitSessionKey = null)
    {
        if (string.IsNullOrWhiteSpace(webRelativeUrl))
        {
            return null;
        }

        var path = webRelativeUrl.Replace('\\', '/').TrimStart('/');

        // Strip PathBase - AppUrl() prepends it on the live
        // site, but ASP.NET does not strip it from JSON body
        // values the way it strips it from the request path.
        var pathBase = HttpContext?.Request.PathBase.Value?.TrimEnd('/') ?? string.Empty;
        if (!string.IsNullOrWhiteSpace(pathBase))
        {
            var pathBasePrefix = pathBase.TrimStart('/');
            if (path.StartsWith(pathBasePrefix + "/", StringComparison.OrdinalIgnoreCase))
            {
                path = path[(pathBasePrefix.Length + 1)..];
            }
            else if (string.Equals(path, pathBasePrefix, StringComparison.OrdinalIgnoreCase))
            {
                path = string.Empty;
            }
        }

        // Drop any query string.
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
        var tail = afterPrefix[(slashIndex + 1)..];
        var root = _fileStore.UploadsRoot;
        var rootWithSep = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var absolute = Path.GetFullPath(Path.Combine(root, urlKey, tail.Replace('/', Path.DirectorySeparatorChar)));
        if (!absolute.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        // 1) Cookie / in-request cache matches the URL's key.
        var currentKey = _fileStore.InboundSessionKey;
        if (!string.IsNullOrEmpty(currentKey) &&
            string.Equals(urlKey, currentKey, StringComparison.OrdinalIgnoreCase) &&
            System.IO.File.Exists(absolute))
        {
            return absolute;
        }

        // 2) Caller passed an explicit SessionKey.
        if (!string.IsNullOrWhiteSpace(explicitSessionKey) &&
            string.Equals(urlKey, explicitSessionKey, StringComparison.OrdinalIgnoreCase))
        {
            _fileStore.AdoptSessionKey(explicitSessionKey);
            if (System.IO.File.Exists(absolute))
            {
                return absolute;
            }
        }

        // 3) Last resort: trust the URL's embedded key.
        if (System.IO.File.Exists(absolute))
        {
            _fileStore.AdoptSessionKey(urlKey);
            return absolute;
        }

        return null;
    }

    /// <summary>
    /// Build preview URL for a file in the current session.
    /// </summary>
    private string BuildSessionPreviewUrl(string storedFileName, bool inGenerated = false)
    {
        var sessionKey = _fileStore.GetOrCreateSessionKey();
        var tail = inGenerated
            ? PerSessionFileStore.GeneratedSubFolder + "/" + storedFileName
            : storedFileName;
        return $"/uploads/{sessionKey}/{tail}";
    }

    /// <summary>
    /// Build preview URL for a generated file (searchable/redacted PDF).
    /// </summary>
    private string BuildGeneratedPreviewUrl(string storedFileName)
    {
        return BuildSessionPreviewUrl(storedFileName, inGenerated: true);
    }

    // POST /api/claim-intake/upload
    //
    // Accepts a single PDF (or image/doc) via multipart form and
    // stores it in the per-session folder. No session writes, no
    // workflow state - the returned previewUrl is the only
    // handle the client needs.
    [HttpPost("upload")]
    [RequestSizeLimit(long.MaxValue)]
    public async Task<IActionResult> Upload([FromForm] IFormFile document, CancellationToken cancellationToken)
    {
        if (document is null || document.Length == 0)
        {
            return BadRequest(new { message = "Upload a PDF, image, or document file." });
        }

        // Per-session uploads folder so the uploaded file is only visible to its uploader.
        var sessionRoot = _fileStore.GetSessionRoot();

        var safeName = Path.GetFileNameWithoutExtension(document.FileName);
        var extension = Path.GetExtension(document.FileName);
        var storedFileName = $"{safeName}-{Guid.NewGuid():N}{extension}";
        var storedPath = Path.Combine(sessionRoot, storedFileName);

        await using (var fileStream = System.IO.File.Create(storedPath))
        {
            await document.CopyToAsync(fileStream, cancellationToken);
        }

        // The server is a dumb file store now. The client
        // owns the workflow state in localStorage, so the
        // upload endpoint does not touch HttpContext.Session
        // at all - it just returns the previewUrl so the
        // browser can fetch the file from
        // /api/claim-intake/preview/{file}.
        var previewUrl = BuildSessionPreviewUrl(storedFileName);
        var publicPreviewUrl = AppUrl(previewUrl);

        var fileTypeLabel = GetFileTypeLabel(document.FileName);
        var fileSize = new FileInfo(storedPath).Length;
        var pageCount = GetPdfPageCount(storedPath, document.FileName);

        return Ok(new
        {
            success = true,
            fileName = document.FileName,
            // Echoed back on subsequent calls as a fallback
            // when the ci_session cookie is dropped.
            sessionKey = _fileStore.GetOrCreateSessionKey(),
            previewUrl = publicPreviewUrl,
            contentType = document.ContentType,
            fileType = fileTypeLabel,
            fileSize = fileSize,
            pageCount = pageCount,
            isPdf = string.Equals(document.ContentType, "application/pdf", StringComparison.OrdinalIgnoreCase) ||
                    extension.Equals(".pdf", StringComparison.OrdinalIgnoreCase)
        });
    }


    private static string GetFileTypeLabel(string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName))
        {
            return "File";
        }

        var lower = fileName.ToLowerInvariant();
        if (lower.EndsWith(".pdf")) return "PDF";
        if (lower.EndsWith(".doc") || lower.EndsWith(".docx")) return "Word";
        if (lower.EndsWith(".png") || lower.EndsWith(".jpg") || lower.EndsWith(".jpeg") || lower.EndsWith(".gif")) return "Image";
        if (lower.EndsWith(".xls") || lower.EndsWith(".xlsx")) return "Excel";
        return "File";
    }

    private static int GetPdfPageCount(string filePath, string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName) || !fileName.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase))
        {
            return 0;
        }

        if (string.IsNullOrWhiteSpace(filePath) || !System.IO.File.Exists(filePath))
        {
            return 0;
        }

        try
        {
            using var document = new PdfLoadedDocument(filePath);
            return document.Pages.Count;
        }
        catch
        {
            return 1;
        }
    }


    // True when the supplied previewUrl is owned by the given
    // session key. The URL is "owned" when its first segment
    // matches the session key exactly. Used to drop stale
    // entries that point at a different session's folder.


    #region Extract Field & Values

    // Builds the review rows from the extractor JSON and decorates each with an IsSensitive flag
    // (one batched AI call instead of N).
    public async Task<List<ReviewFieldInfo>> BuildReviewRowsFromJsonAsync(string extractorJson, CancellationToken cancellationToken)
    {
        var rows = new List<ReviewFieldInfo>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        if (string.IsNullOrWhiteSpace(extractorJson))
        {
            return rows;
        }

        try
        {
            using var doc = JsonDocument.Parse(extractorJson);
            CollectJsonRows(doc.RootElement, rows, seen);
        }
        catch
        {
            // Ignore malformed JSON and return an empty result.
        }

        var pairs = new List<(string Field, string Value)>(rows.Count);
        for (var i = 0; i < rows.Count; i++)
        {
            var row = rows[i];
            if (row.Field == row.Value)
            {
                row.Field = string.Empty;
            }
            pairs.Add((row.Field, row.Value));
        }

        if (pairs.Count > 0)
        {
            var verdicts = await SensitiveFieldClassifier
                .IsSensitiveBatchAsync(pairs, cancellationToken)
                .ConfigureAwait(false);
            for (var i = 0; i < rows.Count && i < verdicts.Count; i++)
            {
                rows[i].IsSensitive = verdicts[i];
            }
        }

        return rows;
    }

    // Sync shim for any caller that has not been converted to async yet. Blocks on the AI call.
    public static List<ReviewFieldInfo> BuildReviewRowsFromJson(string extractorJson)
    {
        var rows = new List<ReviewFieldInfo>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        if (string.IsNullOrWhiteSpace(extractorJson))
        {
            return rows;
        }

        try
        {
            using var doc = JsonDocument.Parse(extractorJson);
            CollectJsonRows(doc.RootElement, rows, seen);
        }
        catch
        {
            // Ignore malformed JSON and return an empty result.
        }

        var pairs = new List<(string Field, string Value)>(rows.Count);
        for (var i = 0; i < rows.Count; i++)
        {
            var row = rows[i];
            if (row.Field == row.Value)
            {
                row.Field = string.Empty;
            }
            pairs.Add((row.Field, row.Value));
        }

        if (pairs.Count > 0)
        {
            var verdicts = SensitiveFieldClassifier
                .IsSensitiveBatchAsync(pairs, CancellationToken.None)
                .GetAwaiter()
                .GetResult();
            for (var i = 0; i < rows.Count && i < verdicts.Count; i++)
            {
                rows[i].IsSensitive = verdicts[i];
            }
        }

        return rows;
    }

    // The PII decision itself is owned by AISensitiveFieldClassifier.


    private static void CollectJsonRows(JsonElement element, List<ReviewFieldInfo> rows, HashSet<string> seen, int currentPageNumber = 1)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            if (TryGetPropertyElement(element, "Pages", out var pages) && pages.ValueKind == JsonValueKind.Array)
            {
                foreach (var page in pages.EnumerateArray())
                {
                    CollectJsonRows(page, rows, seen, currentPageNumber);
                }
            }

            if (TryReadPageNumber(element, out var pageNumber))
            {
                currentPageNumber = pageNumber;
            }

            if (TryExtractTableRow(element, out var tableField, out var tableHtml, out var tableConfidence, out var confidenceSource))
            {
                RegisterExtractedField(rows, seen, tableField, tableHtml, tableConfidence, confidenceSource, isTable: true, pageNumber: currentPageNumber);
            }

            if (TryGetPropertyElement(element, "PageObjects", out var pageObjects) && pageObjects.ValueKind == JsonValueKind.Array)
            {
                foreach (var pageObject in pageObjects.EnumerateArray())
                {
                    CollectJsonRows(pageObject, rows, seen, currentPageNumber);
                }
            }

            if (TryGetPropertyText(element, "Type", out var type))
            {
                if (TryGetPropertyText(element, "Content", out var contentText))
                {
                    ExtractTextFieldValue(type ?? "text", contentText ?? string.Empty, element, rows, seen, currentPageNumber);
                }

                if (TryGetPropertyElement(element, "Content", out var contentEl) && contentEl.ValueKind == JsonValueKind.Object)
                {
                    if (TryGetPropertyText(contentEl, "Text", out var nestedText))
                    {
                        ExtractTextFieldValue(type ?? "text", nestedText, element, rows, seen, currentPageNumber);
                    }
                }
            }

            if (TryExtractFieldAndValue(element, out var field, out var value))
            {
                var confidence = ReadConfidenceScore(element);
                TryReadBounds(element, out var bounds);
                RegisterExtractedField(rows, seen, field!, value!, confidence, string.Empty, false, currentPageNumber, bounds);
            }

            foreach (var property in element.EnumerateObject())
            {
                if (property.Value.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
                {
                    if (property.NameEquals("Pages") || property.NameEquals("PageObjects") || property.NameEquals("Rows") || property.NameEquals("Cells") || property.NameEquals("Content") || property.NameEquals("Style") || property.NameEquals("TableFormat") || property.NameEquals("FormObjects"))
                    {
                        continue;
                    }

                    CollectJsonRows(property.Value, rows, seen, currentPageNumber);
                }
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
            {
                CollectJsonRows(item, rows, seen, currentPageNumber);
            }
        }
    }

    // Extract field and value from text content (handles colon-separated format)
    private static void ExtractTextFieldValue(string contentType, string? text, JsonElement element, List<ReviewFieldInfo> rows, HashSet<string> seen, int pageNumber)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }

        var confidence = ReadConfidenceScore(element);
        TryReadBounds(element, out var bounds);
        var source = $"{(contentType ?? "text").ToLowerInvariant()} text";

        // Preferred path: text contains a "Field : Value" pair. Both
        // halves are populated and the row renders normally in the
        // Review table.
        if (TryParseColonSeparatedText(text, out var pairedField, out var pairedValue)
            && !string.IsNullOrWhiteSpace(pairedField)
            && !string.IsNullOrWhiteSpace(pairedValue))
        {
            RegisterExtractedField(rows, seen, pairedField!, pairedValue!, confidence, source, false, pageNumber, bounds);
            return;
        }

        // Fallback path: the extracted text did not contain a
        // colon-separated pair (e.g. a free-form paragraph, a
        // single-value field rendered without a label, or a
        // non-English label that the parser rejected). Previously
        // these values were dropped on the floor, leaving an empty
        // Review page even though the extractor had clearly found
        // something. Instead, surface the entire text as the row's
        // "Value" and mark it IsUnpairedText so the Review UI can
        // hide the Field column and render only the three options
        // the user asked for: Extracted value, Confidence, Edit.
        var trimmedText = text.Trim();
        if (string.IsNullOrWhiteSpace(trimmedText))
        {
            return;
        }

        // Use the trimmed text as BOTH the Field and the Value so
        // that downstream code (SaveCorrection, the data-edit
        // handler, the redaction target lookup) still has a stable
        // key to operate on. The Field column is hidden in the UI
        // via the IsUnpairedText flag, so the duplication is never
        // visible to the user.
        RegisterUnpairedTextRow(rows, seen, trimmedText, confidence, source, pageNumber, bounds);
    }

    // Register a row that came from text without a colon-separated
    // field/value pair. Mirrors RegisterExtractedField but also
    // flips IsUnpairedText so the Review page knows to hide the
    // Field column. The de-duplication key intentionally differs
    // from the paired-row key ("<field>|<value>") so that the same
    // raw text cannot collide with a real "Field : Value" entry
    // that happens to share the text.
    private static void RegisterUnpairedTextRow(
        List<ReviewFieldInfo> rows,
        HashSet<string> seen,
        string text,
        decimal confidence,
        string confidenceSource,
        int pageNumber,
        RectangleF bounds)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }

        var dedupeKey = $"__unpaired__|{text}";
        if (!seen.Add(dedupeKey))
        {
            return;
        }

        var hasBounds = bounds.Width > 0 && bounds.Height > 0;
        rows.Add(new ReviewFieldInfo
        {
            Field = text,
            Value = text,
            Confidence = confidence,
            ConfidenceSource = confidenceSource,
            IsTable = false,
            IsUnpairedText = true,
            PageNumber = pageNumber,
            Left = hasBounds ? bounds.Left : 0,
            Top = hasBounds ? bounds.Top : 0,
            Width = hasBounds ? bounds.Width : 0,
            Height = hasBounds ? bounds.Height : 0
        });
    }

    // Parse colon-separated text like "Policy Number: ABC123" into field and value
    private static bool TryParseColonSeparatedText(string text, out string? field, out string? value)
    {
        field = null;
        value = null;

        if (string.IsNullOrWhiteSpace(text))
            return false;

        // Normalize line breaks
        var normalizedText = text.Replace("\r\n", "\n").Replace("\r", "\n");
        var colonPos = normalizedText.IndexOf(':');
        
        if (colonPos < 0)
            return false;

        var fieldPart = normalizedText[..colonPos].Trim();
        var valuePart = normalizedText[(colonPos + 1)..].Trim();

        if (string.IsNullOrWhiteSpace(fieldPart) || string.IsNullOrWhiteSpace(valuePart))
            return false;

        field = fieldPart;
        value = string.Join(" ", valuePart.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)).Trim();

        return true;
    }

    // Extract table from JSON structure
    private static bool TryExtractTableRow(JsonElement element, out string field, out string value, out decimal confidence, out string confidenceSource)
    {
        field = string.Empty;
        value = string.Empty;
        confidence = 0m;
        confidenceSource = string.Empty;

        if (!TryGetPropertyElement(element, "Rows", out var rowsEl) || rowsEl.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        var tableRows = rowsEl.EnumerateArray().ToList();
        if (tableRows.Count == 0)
        {
            return false;
        }

        var label = GetFirstTextPropertyValue(element, "label", "title", "name")
                    ?? TryGetTableFormatLabel(element)
                    ?? "Table";

        var headers = ExtractTableRowCells(tableRows.FirstOrDefault());
        var bodyRows = tableRows.Skip(1)
            .Select(row => ExtractTableRowCells(row))
            .Where(cells => cells.Count > 0)
            .ToList();

        var columnCount = Math.Max(headers.Count, bodyRows.Count > 0 ? bodyRows.Max(r => r.Count) : 0);
        if (columnCount < 2 || bodyRows.Count == 0)
        {
            return false;
        }

        confidence = TryGetDecimal(element, out var tableConfidence, "confidence", "confidenceScore", "score")
            ? tableConfidence
            : 0m;

        confidenceSource = "table";
        value = BuildNestedTableHtml(label, headers, bodyRows, columnCount);
        field = label;

        return !string.IsNullOrWhiteSpace(value);
    }

    private static string BuildNestedTableHtml(string label, List<string> headers, List<List<string>> bodyRows, int columnCount)
    {
        var caption = WebUtility.HtmlEncode(label);
        var html = new System.Text.StringBuilder();
        html.Append("<span class='table-caption'>").Append(caption).Append("</span>");
        html.Append("<table class='nested-review-table'>");

        html.Append("<thead><tr>");
        for (var i = 0; i < columnCount; i++)
        {
            var header = i < headers.Count && !string.IsNullOrWhiteSpace(headers[i]) ? headers[i] : $"Column {i + 1}";
            html.Append("<th>").Append(WebUtility.HtmlEncode(header)).Append("</th>");
        }
        html.Append("</tr></thead>");

        html.Append("<tbody>");
        foreach (var row in bodyRows)
        {
            html.Append("<tr>");
            for (var i = 0; i < columnCount; i++)
            {
                var cell = i < row.Count ? row[i] : string.Empty;
                html.Append("<td>").Append(WebUtility.HtmlEncode(cell)).Append("</td>");
            }
            html.Append("</tr>");
        }
        html.Append("</tbody>");

        html.Append("</table>");
        return html.ToString();
    }

    // Extract cell text from table row
    private static List<string> ExtractTableRowCells(JsonElement rowElement)
    {
        var cells = new List<string>();
        if (rowElement.ValueKind != JsonValueKind.Object)
            return cells;

        if (TryGetPropertyElement(rowElement, "Cells", out var cellsElement) && cellsElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var cell in cellsElement.EnumerateArray())
            {
                var cellText = GetObjectText(cell);
                if (!string.IsNullOrWhiteSpace(cellText))
                    cells.Add(cellText.Trim());
            }
        }
        return cells;
    }

    // Get table label from table format metadata
    private static string? TryGetTableFormatLabel(JsonElement element)
    {
        if (TryGetPropertyElement(element, "TableFormat", out var tableFormat) && tableFormat.ValueKind == JsonValueKind.Object)
            return GetFirstTextPropertyValue(tableFormat, "label", "title", "name");
        return null;
    }

    // Add extracted field to review list (prevents duplicates)
    private static void RegisterExtractedField(List<ReviewFieldInfo> rows, HashSet<string> seen, string field, string value, decimal confidence, string confidenceSource, bool isTable, int pageNumber = 1, RectangleF bounds = default)
    {
        if (string.IsNullOrWhiteSpace(field) || string.IsNullOrWhiteSpace(value))
            return;

        var deduplicateKey = $"{field}|{value}";
        if (!seen.Add(deduplicateKey))
            return;  // Duplicate - skip

        var hasBounds = bounds.Width > 0 && bounds.Height > 0;
        rows.Add(new ReviewFieldInfo
        {
            Field = field.Trim(),
            Value = value.Trim(),
            Confidence = confidence,
            ConfidenceSource = confidenceSource,
            IsTable = isTable,
            PageNumber = pageNumber,
            Left = hasBounds ? bounds.Left : 0,
            Top = hasBounds ? bounds.Top : 0,
            Width = hasBounds ? bounds.Width : 0,
            Height = hasBounds ? bounds.Height : 0
        });
    }

    // Extract field and value: tries direct properties first, then text parsing as fallback
    private static bool TryExtractFieldAndValue(JsonElement element, out string? field, out string? value)
    {
        field = GetFirstTextPropertyValue(element, "name", "field", "fieldName", "label", "title", "key", "caption");
        value = GetFirstTextPropertyValue(element, "value", "text", "result", "extractedValue", "fieldValue", "displayValue", "answer");

        // Fallback to text parsing if direct properties not found
        if ((string.IsNullOrWhiteSpace(field) || string.IsNullOrWhiteSpace(value)) && 
            TryParseColonSeparatedText(GetObjectText(element) ?? string.Empty, out var parsedField, out var parsedValue))
        {
            field ??= parsedField;
            value ??= parsedValue;
        }

        return !string.IsNullOrWhiteSpace(field) && !string.IsNullOrWhiteSpace(value);
    }

    // Get first matching text property from element
    private static string? GetFirstTextPropertyValue(JsonElement element, params string[] propertyNames)
    {
        foreach (var name in propertyNames)
        {
            if (TryGetPropertyText(element, name, out var value))
                return value;
        }
        return null;
    }

    // Read confidence score from element (searches common property names)
    private static decimal ReadConfidenceScore(JsonElement element)
    {
        return TryGetDecimal(element, out var score, "confidence", "confidenceScore", "score") ? score : 0m;
    }

    #endregion Extract Field & Values

    #region Redact
    private static List<RedactionTarget> BuildRedactionTargetsFromJson(string extractorJson)
    {
        var targets = new List<RedactionTarget>();
        if (string.IsNullOrWhiteSpace(extractorJson))
        {
            return targets;
        }

        try
        {
            using var doc = JsonDocument.Parse(extractorJson);
            CollectRedactionTargets(doc.RootElement, targets, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
        }
        catch
        {
            // Ignore malformed JSON.
        }

        return targets;
    }

    private static void CollectRedactionTargets(JsonElement element, List<RedactionTarget> targets, HashSet<string> seen)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            if (TryExtractFieldAndValue(element, out var field, out var value) &&
                TryReadBounds(element, out var bounds))
            {
                var pageNumber = TryReadPageNumber(element, out var page) ? page : 1;
                var key = $"{field}|{value}|{pageNumber}|{bounds.Left:0.##}|{bounds.Top:0.##}|{bounds.Width:0.##}|{bounds.Height:0.##}";

                if (seen.Add(key))
                {
                    targets.Add(new RedactionTarget(field!.Trim(), value!.Trim(), pageNumber, bounds));
                }
            }

            foreach (var property in element.EnumerateObject())
            {
                if (property.Value.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
                {
                    if (IsMetadataProperty(property.Name))
                    {
                        continue;
                    }

                    CollectRedactionTargets(property.Value, targets, seen);
                }
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
            {
                CollectRedactionTargets(item, targets, seen);
            }
        }
    }


    private static List<RedactionTarget> ResolveSelectedTargets(List<RedactSelectedItem> items, List<RedactionTarget> allTargets)
    {
        var selected = new List<RedactionTarget>();

        foreach (var item in items)
        {
            if (string.IsNullOrWhiteSpace(item.Field) && string.IsNullOrWhiteSpace(item.Value))
            {
                continue;
            }

            var match = allTargets.FirstOrDefault(target =>
                string.Equals(target.Field, item.Field, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(target.Value, item.Value, StringComparison.OrdinalIgnoreCase));

            if (match is not null)
            {
                selected.Add(match);
            }
        }

        return selected;
    }

    #endregion Redact
    // Locate the precise bounds of a target's value inside the searchable PDF.
    private static bool TryFindValueBounds( PdfLoadedDocument loadedDocument, RedactionTarget target, out RectangleF valueBounds)
    {
        valueBounds = RectangleF.Empty;
        if (loadedDocument is null || target is null)
        {
            return false;
        }
        var candidates = BuildValueSearchCandidates(target.Value);
        if (candidates.Count == 0)
        {
            return false;
        }
        Dictionary<int, List<RectangleF>> matches = new();
        foreach (var candidate in candidates)
        {
            loadedDocument.FindText(candidate, out matches);
            if (matches is null || matches.Count == 0)
            {
                continue;
            }
            if (TrySelectRectangleForPage(matches, target.PageNumber, out var hit))
            {
                valueBounds = hit;
                return true;
            }
        }
        return false;
    }

    private static List<string> BuildValueSearchCandidates(string? value)
    {
        var candidates = new List<string>();
        if (string.IsNullOrWhiteSpace(value))
        {
            return candidates;
        }
        var trimmed = value.Trim();
        if (!string.IsNullOrWhiteSpace(trimmed))
        {
            candidates.Add(trimmed);
        }
        // Try progressively-shorter prefixes (dropping the last
        // word first) so we still match when the trailing
        // punctuation / spacing differs between the extraction
        // and the searchable text layer.
        var words = trimmed.Split(
            new[] { ' ', '\t', '\r', '\n' },
            StringSplitOptions.RemoveEmptyEntries);
        if (words.Length > 1)
        {
            for (var i = words.Length - 1; i >= 1; i--)
            {
                var prefix = string.Join(' ', words, 0, i);
                if (!string.IsNullOrWhiteSpace(prefix) && !candidates.Contains(prefix))
                {
                    candidates.Add(prefix);
                }
            }
        }
        return candidates;
    }
    private static bool TrySelectRectangleForPage( Dictionary<int, List<RectangleF>> matches, int pageNumber, out RectangleF rectangle)
    {
        rectangle = RectangleF.Empty;
        if (matches is null || matches.Count == 0)
        {
            return false;
        }
        // Prefer a match on the expected page; otherwise pick the
        // closest page so we still reda something sensible.
        if (matches.TryGetValue(pageNumber, out var exact) && exact is { Count: > 0 })
        {
            rectangle = exact[0];
            return true;
        }
        var nearest = matches
            .Where(kv => kv.Value is { Count: > 0 })
            .OrderBy(kv => Math.Abs(kv.Key - pageNumber))
            .Select(kv => (HasValue: true, Value: kv.Value[0]))
            .FirstOrDefault();
        if (!nearest.HasValue || nearest.Value == RectangleF.Empty)
        {
            return false;
        }
        rectangle = nearest.Value;
        return true;
    }
    private static bool TryReadBounds(JsonElement element, out RectangleF bounds)
    {
        bounds = RectangleF.Empty;

        if (TryReadBoundsRecursive(element, out bounds))
        {
            return true;
        }

        if (!TryGetBoundsElement(element, out var boundsElement))
        {
            return false;
        }

        if (TryReadBoundsFromObject(boundsElement, out bounds))
        {
            return true;
        }

        if (TryReadBoundsFromArray(boundsElement, out bounds))
        {
            return true;
        }

        return false;
    }

    private static bool TryReadBoundsRecursive(JsonElement element, out RectangleF bounds)
    {
        bounds = RectangleF.Empty;

        if (element.ValueKind == JsonValueKind.Object)
        {
            if (TryReadBoundsFromObject(element, out bounds))
            {
                return true;
            }

            if (TryGetBoundsElement(element, out var childBounds))
            {
                if (TryReadBoundsFromObject(childBounds, out bounds) || TryReadBoundsFromArray(childBounds, out bounds))
                {
                    return true;
                }
            }

            foreach (var property in element.EnumerateObject())
            {
                if (property.Value.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
                {
                    if (TryReadBoundsRecursive(property.Value, out bounds))
                    {
                        return true;
                    }
                }
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            if (TryReadBoundsFromArray(element, out bounds))
            {
                return true;
            }

            foreach (var item in element.EnumerateArray())
            {
                if (TryReadBoundsRecursive(item, out bounds))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool TryGetBoundsElement(JsonElement element, out JsonElement boundsElement)
    {
        return TryGetPropertyElement(element, "Bounds", out boundsElement)
               || TryGetPropertyElement(element, "Rect", out boundsElement)
               || TryGetPropertyElement(element, "BoundingBox", out boundsElement)
               || TryGetPropertyElement(element, "BBox", out boundsElement)
               || TryGetPropertyElement(element, "Location", out boundsElement)
               || TryGetPropertyElement(element, "Coordinates", out boundsElement)
               || TryGetPropertyElement(element, "Box", out boundsElement)
               || TryGetPropertyElement(element, "Polygon", out boundsElement)
               || TryGetPropertyElement(element, "Points", out boundsElement)
               || TryGetPropertyElement(element, "Vertices", out boundsElement)
               || TryGetPropertyElement(element, "bounds", out boundsElement)
               || TryGetPropertyElement(element, "rect", out boundsElement)
               || TryGetPropertyElement(element, "boundingBox", out boundsElement)
               || TryGetPropertyElement(element, "bbox", out boundsElement)
               || TryGetPropertyElement(element, "location", out boundsElement)
               || TryGetPropertyElement(element, "coordinates", out boundsElement)
               || TryGetPropertyElement(element, "box", out boundsElement)
               || TryGetPropertyElement(element, "polygon", out boundsElement)
               || TryGetPropertyElement(element, "points", out boundsElement)
               || TryGetPropertyElement(element, "vertices", out boundsElement)
               || TryReadInlineBounds(element, out boundsElement);
    }

    private static bool TryReadInlineBounds(JsonElement element, out JsonElement boundsElement)
    {
        boundsElement = default;

        if (element.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        var hasInlineBounds = false;
        decimal left = 0m, top = 0m, width = 0m, height = 0m;

        if (TryGetDecimal(element, out left, "x", "left")) hasInlineBounds = true;
        if (TryGetDecimal(element, out top, "y", "top")) hasInlineBounds = true;
        if (TryGetDecimal(element, out width, "width", "w")) hasInlineBounds = true;
        if (TryGetDecimal(element, out height, "height", "h")) hasInlineBounds = true;

        if (!hasInlineBounds)
        {
            return false;
        }

        var synthetic = $"{{\"x\":{left},\"y\":{top},\"width\":{width},\"height\":{height}}}";
        using var syntheticDoc = JsonDocument.Parse(synthetic);
        boundsElement = syntheticDoc.RootElement.Clone();
        return true;
    }

    private static bool TryReadBoundsFromObject(JsonElement boundsElement, out RectangleF bounds)
    {
        bounds = RectangleF.Empty;

        if (boundsElement.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (!TryGetDecimal(boundsElement, out var left, "x", "left", "X", "Left")
            && !TryGetDecimal(boundsElement, out left, "l"))
        {
            left = 0m;
        }

        if (!TryGetDecimal(boundsElement, out var top, "y", "top", "Y", "Top")
            && !TryGetDecimal(boundsElement, out top, "t"))
        {
            top = 0m;
        }

        var hasWidth = TryGetDecimal(boundsElement, out var width, "width", "w", "Width", "W");
        var hasHeight = TryGetDecimal(boundsElement, out var height, "height", "h", "Height", "H");

        if (!hasWidth && TryGetDecimal(boundsElement, out var right, "right", "r", "Right", "R"))
        {
            width = right - left;
            hasWidth = width > 0;
        }

        if (!hasHeight && TryGetDecimal(boundsElement, out var bottom, "bottom", "b", "Bottom", "B"))
        {
            height = bottom - top;
            hasHeight = height > 0;
        }

        if ((!hasWidth || !hasHeight) && TryReadBoundsFromPolygon(boundsElement, out bounds))
        {
            return true;
        }

        if (!hasWidth || !hasHeight || width <= 0 || height <= 0)
        {
            return false;
        }

        bounds = new RectangleF((float)left, (float)top, (float)width, (float)height);
        return true;
    }

    private static bool TryReadBoundsFromPolygon(JsonElement boundsElement, out RectangleF bounds)
    {
        bounds = RectangleF.Empty;

        if (boundsElement.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        foreach (var propertyName in new[] { "Polygon", "Points", "Vertices", "polygon", "points", "vertices" })
        {
            if (!TryGetPropertyElement(boundsElement, propertyName, out var points) || points.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            var xs = new List<float>();
            var ys = new List<float>();

            foreach (var point in points.EnumerateArray())
            {
                if (point.ValueKind == JsonValueKind.Object)
                {
                    if (TryGetDecimal(point, out var x, "x", "left", "X", "Left") &&
                        TryGetDecimal(point, out var y, "y", "top", "Y", "Top"))
                    {
                        xs.Add((float)x);
                        ys.Add((float)y);
                        continue;
                    }
                }
                else if (point.ValueKind == JsonValueKind.Array)
                {
                    var coords = point.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.Number && item.TryGetSingle(out var n) ? n : (float?)null).Where(v => v.HasValue).Select(v => v!.Value).ToList();
                    if (coords.Count >= 2)
                    {
                        xs.Add(coords[0]);
                        ys.Add(coords[1]);
                    }
                }
            }

            if (xs.Count == 0 || ys.Count == 0)
            {
                continue;
            }

            var minX = xs.Min();
            var minY = ys.Min();
            var maxX = xs.Max();
            var maxY = ys.Max();

            var width = maxX - minX;
            var height = maxY - minY;
            if (width > 0 && height > 0)
            {
                bounds = new RectangleF(minX, minY, width, height);
                return true;
            }
        }

        return false;
    }

    private static bool TryReadBoundsFromArray(JsonElement boundsElement, out RectangleF bounds)
    {
        bounds = RectangleF.Empty;

        if (boundsElement.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        var values = new List<float>(4);
        foreach (var item in boundsElement.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.Number && item.TryGetSingle(out var number))
            {
                values.Add(number);
            }
            else if (item.ValueKind == JsonValueKind.String && float.TryParse(item.GetString(), out var parsed))
            {
                values.Add(parsed);
            }
        }

        if (values.Count < 4)
        {
            return false;
        }

        if (values.Count == 4)
        {
            bounds = new RectangleF(values[0], values[1], values[2], values[3]);
            return bounds.Width > 0 && bounds.Height > 0;
        }

        var xs = new List<float>();
        var ys = new List<float>();
        for (var i = 0; i + 1 < values.Count; i += 2)
        {
            xs.Add(values[i]);
            ys.Add(values[i + 1]);
        }

        if (xs.Count == 0 || ys.Count == 0)
        {
            return false;
        }

        var minX = xs.Min();
        var minY = ys.Min();
        var maxX = xs.Max();
        var maxY = ys.Max();
        bounds = new RectangleF(minX, minY, maxX - minX, maxY - minY);
        return bounds.Width > 0 && bounds.Height > 0;
    }

    private static bool TryReadPageNumber(JsonElement element, out int pageNumber)
    {
        pageNumber = 1;

        if (TryGetDecimal(element, out var pageValue, "pageNumber", "page", "PageNumber", "Page", "pageIndex"))
        {
            pageNumber = Math.Max(1, (int)pageValue);
            return true;
        }

        return false;
    }

    private static bool TryGetPropertyElement(JsonElement element, string propertyName, out JsonElement propertyValue)
    {
        propertyValue = default;

        if (element.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        foreach (var prop in element.EnumerateObject())
        {
            if (prop.Name.Equals(propertyName, StringComparison.OrdinalIgnoreCase))
            {
                propertyValue = prop.Value;
                return true;
            }
        }

        return false;
    }

    private static bool TryGetPropertyText(JsonElement element, string propertyName, out string? value)
    {
        value = null;

        if (element.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        foreach (var prop in element.EnumerateObject())
        {
            if (!prop.Name.Equals(propertyName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            value = GetObjectText(prop.Value);
            return !string.IsNullOrWhiteSpace(value);
        }

        return false;
    }

    private static bool IsMetadataProperty(string name)
    {
        return name.Equals("confidence", StringComparison.OrdinalIgnoreCase)
               || name.Equals("confidenceScore", StringComparison.OrdinalIgnoreCase)
               || name.Equals("score", StringComparison.OrdinalIgnoreCase)
               || name.Equals("source", StringComparison.OrdinalIgnoreCase)
               || name.Equals("confidenceSource", StringComparison.OrdinalIgnoreCase)
               || name.Equals("page", StringComparison.OrdinalIgnoreCase)
               || name.Equals("location", StringComparison.OrdinalIgnoreCase)
               || name.Equals("box", StringComparison.OrdinalIgnoreCase)
               || name.Equals("x", StringComparison.OrdinalIgnoreCase)
               || name.Equals("y", StringComparison.OrdinalIgnoreCase)
               || name.Equals("width", StringComparison.OrdinalIgnoreCase)
               || name.Equals("height", StringComparison.OrdinalIgnoreCase)
               || name.Equals("left", StringComparison.OrdinalIgnoreCase)
               || name.Equals("top", StringComparison.OrdinalIgnoreCase)
               || name.Equals("right", StringComparison.OrdinalIgnoreCase)
               || name.Equals("bottom", StringComparison.OrdinalIgnoreCase)
               || name.Equals("bounds", StringComparison.OrdinalIgnoreCase)
               || name.Equals("rect", StringComparison.OrdinalIgnoreCase)
               || name.Equals("coordinates", StringComparison.OrdinalIgnoreCase)
               || name.StartsWith("page", StringComparison.OrdinalIgnoreCase)
               || name.StartsWith("formobj", StringComparison.OrdinalIgnoreCase)
               || name.StartsWith("formobject", StringComparison.OrdinalIgnoreCase);
    }

    private static string? GetObjectText(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.String)
        {
            return element.GetString();
        }

        if (element.ValueKind is JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False)
        {
            return element.ToString();
        }

        if (element.ValueKind == JsonValueKind.Object)
        {
            if (element.TryGetProperty("Content", out var contentEl) && contentEl.ValueKind == JsonValueKind.Object)
            {
                if (contentEl.TryGetProperty("Text", out var contentText) && contentText.ValueKind == JsonValueKind.String)
                {
                    return contentText.GetString();
                }

                if (contentEl.TryGetProperty("Value", out var contentValue))
                {
                    var nested = GetObjectText(contentValue);
                    if (!string.IsNullOrWhiteSpace(nested))
                    {
                        return nested;
                    }
                }
            }

            foreach (var textProperty in new[] { "Text", "Value", "Name", "Label", "Title", "Field", "FieldName" })
            {
                if (element.TryGetProperty(textProperty, out var candidate))
                {
                    var text = GetObjectText(candidate);
                    if (!string.IsNullOrWhiteSpace(text))
                    {
                        return text;
                    }
                }
            }
        }

        return null;
    }

    private static bool TryGetDecimal(JsonElement element, out decimal value, params string[] names)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            value = 0m;
            return false;
        }

        foreach (var name in names)
        {
            foreach (var prop in element.EnumerateObject())
            {
                if (!prop.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (prop.Value.ValueKind == JsonValueKind.Number && prop.Value.TryGetDecimal(out value))
                {
                    return true;
                }

                if (prop.Value.ValueKind == JsonValueKind.String && decimal.TryParse(prop.Value.GetString(), out value))
                {
                    return true;
                }
            }
        }

        value = 0m;
        return false;
    }

    private static bool TryGetInt32(JsonElement element, out int value, params string[] names)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            value = 0;
            return false;
        }

        foreach (var name in names)
        {
            foreach (var prop in element.EnumerateObject())
            {
                if (!prop.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (prop.Value.ValueKind == JsonValueKind.Number && prop.Value.TryGetInt32(out value))
                {
                    return true;
                }

                if (prop.Value.ValueKind == JsonValueKind.String && int.TryParse(prop.Value.GetString(), out value))
                {
                    return true;
                }
            }
        }

        value = 0;
        return false;
    }

    // =================================================================
    // NEW: stateless pipeline endpoints
    //
    // These endpoints take a previewUrl in the request body and
    // return JSON / PDF URLs without writing to HttpContext.Session.
    // The client (wwwroot/js/claimIntake.js) owns the workflow
    // state in localStorage; the server is just a dumb pipeline
    // runner. See .codestudio/workflows/current/artifacts/spec.md
    // sections 4 + 5 for the full contract.
    // =================================================================

    // POST /api/claim-intake/upload-by-template
    //
    // Default templates live in wwwroot/templatefiles. The client
    // cannot fetch them directly through the per-session preview
    // endpoint (which validates the ci_session key), so this
    // endpoint copies a default template into the per-session
    // folder and returns its previewUrl. Same shape as /upload.
    [HttpPost("upload-by-template")]
    public async Task<IActionResult> UploadByTemplate(
        [FromBody] UploadByTemplateRequest request,
        CancellationToken cancellationToken)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.FileName))
        {
            return BadRequest(new { success = false, message = "Missing file name." });
        }

        var webRoot = _environment.WebRootPath ?? Path.Combine(_environment.ContentRootPath, "wwwroot");
        var templatesRoot = Path.Combine(webRoot, "templatefiles");

        var safeName = Path.GetFileName(request.FileName);
        if (string.IsNullOrWhiteSpace(safeName) || !safeName.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest(new { success = false, message = "Template not found." });
        }

        var templatePath = Path.Combine(templatesRoot, safeName);
        if (!System.IO.File.Exists(templatePath))
        {
            return NotFound(new { success = false, message = "Template not found." });
        }

        var sessionRoot = _fileStore.GetSessionRoot();
        var storedFileName = $"{Path.GetFileNameWithoutExtension(safeName)}-{Guid.NewGuid():N}{Path.GetExtension(safeName)}";
        var storedPath = Path.Combine(sessionRoot, storedFileName);

        await using (var source = System.IO.File.OpenRead(templatePath))
        await using (var destination = System.IO.File.Create(storedPath))
        {
            await source.CopyToAsync(destination, cancellationToken);
        }

        var previewUrl = BuildSessionPreviewUrl(storedFileName);
        var publicPreviewUrl = AppUrl(previewUrl);
        var fileSize = new FileInfo(storedPath).Length;
        var pageCount = GetPdfPageCount(storedPath, safeName);

        return Ok(new
        {
            success = true,
            fileName = safeName,
            sessionKey = _fileStore.GetOrCreateSessionKey(),
            previewUrl = publicPreviewUrl,
            contentType = "application/pdf",
            fileType = "PDF",
            fileSize = fileSize,
            pageCount = pageCount,
            isPdf = true
        });
    }

    // POST /api/claim-intake/extract
    //
    // Takes a previewUrl (the user's uploaded PDF), runs the
    // Syncfusion DataExtractor, and returns the extraction JSON
    // plus a flattened rows[] array. Sensitivity classification
    // is run server-side so the client gets an `isSensitive` flag
    // baked in.
    [HttpPost("extract")]
    public async Task<IActionResult> Extract(
        [FromBody] StatelessPreviewRequest request,
        CancellationToken cancellationToken)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.PreviewUrl))
        {
            return BadRequest(new { success = false, message = "Missing previewUrl." });
        }

        var filePath = ResolveSessionPath(request.PreviewUrl, request.SessionKey);
        if (string.IsNullOrWhiteSpace(filePath) || !System.IO.File.Exists(filePath))
        {
            return NotFound(new { success = false, message = "File not found." });
        }

        // EnableFormDetection is off - it crashes the extractor
        // on a real-world subset of PDFs. Form fields are still
        // picked up by the LINES / TABLES passes.
        var extractor = new DataExtractor
        {
            EnableFormDetection = false,
            EnableTableDetection = true,
        };

        string extractorJson;
        try
        {
            await using var input = System.IO.File.OpenRead(filePath);
            extractorJson = extractor.ExtractDataAsJson(input);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                ex,
                "DataExtractor.ExtractDataAsJson failed for {File}",
                Path.GetFileName(filePath));

            // Return a structured 400 instead of crashing the
            // worker into a 502.
            return BadRequest(new
            {
                success = false,
                message = "Unable to extract fields from this file. Try re-uploading the PDF or use a different document."
            });
        }

        var rows = await BuildReviewRowsFromJsonAsync(extractorJson, cancellationToken);

        // Flatten the rows to a JSON-friendly shape the client
        // can store in localStorage.
        var flatRows = rows.Select(r => new
        {
            field = r.Field,
            value = r.Value,
            confidence = r.Confidence,
            isTable = r.IsTable,
            isSensitive = r.IsSensitive,
            isUnpairedText = r.IsUnpairedText,
            pageNumber = r.PageNumber,
            left = r.Left,
            top = r.Top,
            width = r.Width,
            height = r.Height,
            hasBounds = r.HasBounds
        }).ToList();

        return Ok(new
        {
            success = true,
            previewUrl = request.PreviewUrl,
            extraction = new
            {
                raw = extractorJson,
                rows = flatRows
            }
        });
    }

    // POST /api/claim-intake/searchable-pdf
    //
    // Generates a searchable PDF for the supplied previewUrl and
    // returns the generated file's previewUrl. The client caches
    // this on the document so the Final step has a download link
    // without an extra round-trip.
    [HttpPost("searchable-pdf")]
    public async Task<IActionResult> SearchablePdf(
        [FromBody] StatelessPreviewRequest request,
        CancellationToken cancellationToken)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.PreviewUrl))
        {
            return BadRequest(new { success = false, message = "Missing previewUrl." });
        }

        var filePath = ResolveSessionPath(request.PreviewUrl, request.SessionKey);
        if (string.IsNullOrWhiteSpace(filePath) || !System.IO.File.Exists(filePath))
        {
            return NotFound(new { success = false, message = "File not found." });
        }

        var extractor = new DataExtractor
        {
            EnableFormDetection = false,
            EnableTableDetection = true,
        };

        PdfLoadedDocument? searchableDocument = null;
        try
        {
            await using var input = System.IO.File.OpenRead(filePath);
            searchableDocument = extractor.ExtractDataAsPdfDocument(input);

            var sessionRoot = _fileStore.GetSessionRoot();
            var generatedDir = Path.Combine(sessionRoot, PerSessionFileStore.GeneratedSubFolder);
            Directory.CreateDirectory(generatedDir);

            var sourceName = Path.GetFileNameWithoutExtension(request.PreviewUrl);
            var processedFileName = $"{sourceName}-processed-{Guid.NewGuid():N}.pdf";
            var processedPath = Path.Combine(generatedDir, processedFileName);

            await using (var output = System.IO.File.Create(processedPath))
            {
                searchableDocument.Save(output);
            }

            var previewUrl = BuildGeneratedPreviewUrl(processedFileName);
            var publicPreviewUrl = AppUrl(previewUrl);

            return Ok(new
            {
                success = true,
                previewUrl = publicPreviewUrl
            });
        }
        catch
        {
            return BadRequest(new
            {
                success = false,
                message = "Unable to generate a searchable PDF for the chosen file."
            });
        }
        finally
        {
            searchableDocument?.Close(true);
        }
    }

    // POST /api/claim-intake/redact
    //
    // Takes the previewUrl plus the field/value pairs the user
    // selected, resolves bounds from the supplied extraction JSON
    // (sent in the body so we do not have to re-run extraction),
    // and writes a redacted PDF to the per-session generated
    // folder.
    [HttpPost("redact")]
    public async Task<IActionResult> RedactStateless(
        [FromBody] StatelessRedactRequest request,
        CancellationToken cancellationToken)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.PreviewUrl))
        {
            return BadRequest(new { success = false, message = "Missing previewUrl." });
        }

        var items = (request.Items ?? new List<RedactSelectedItem>())
            .Where(i => !string.IsNullOrWhiteSpace(i.Field) || !string.IsNullOrWhiteSpace(i.Value))
            .ToList();
        if (items.Count == 0)
        {
            return BadRequest(new { success = false, message = "No items selected." });
        }

        // Build the target list. Prefer the inline extraction rows
        // (so the client can pass whatever the user has corrected
        // locally without a server round-trip), fall back to a
        // raw JSON rebuild.
        List<RedactionTarget> targets;
        if (request.ExtractionRows is { Count: > 0 })
        {
            // Each row is raw JSON (the client serialises the
            // rows it cached on the document). Parse lazily so
            // the comparison is null-safe.
            var parsedRows = new List<System.Text.Json.JsonDocument>(request.ExtractionRows.Count);
            foreach (var raw in request.ExtractionRows)
            {
                if (string.IsNullOrWhiteSpace(raw)) { continue; }
                try { parsedRows.Add(System.Text.Json.JsonDocument.Parse(raw)); }
                catch { /* skip malformed */ }
            }
            targets = new List<RedactionTarget>(items.Count);
            foreach (var item in items)
            {
                JsonElement? match = null;
                foreach (var doc in parsedRows)
                {
                    var root = doc.RootElement;
                    if (root.ValueKind != JsonValueKind.Object) { continue; }
                    if (!string.Equals(root.GetProperty("field").GetString() ?? string.Empty, item.Field, StringComparison.OrdinalIgnoreCase)) { continue; }
                    if (!string.Equals(root.GetProperty("value").GetString() ?? string.Empty, item.Value, StringComparison.OrdinalIgnoreCase)) { continue; }
                    var hasBounds = root.TryGetProperty("hasBounds", out var hb) && hb.GetBoolean();
                    if (!hasBounds) { continue; }
                    match = root.Clone();
                    break;
                }
                if (match is null) { continue; }
                var m = match.Value;
                var left = m.TryGetProperty("left", out var l) ? (float)l.GetDouble() : 0f;
                var top = m.TryGetProperty("top", out var t) ? (float)t.GetDouble() : 0f;
                var width = m.TryGetProperty("width", out var w) ? (float)w.GetDouble() : 0f;
                var height = m.TryGetProperty("height", out var h) ? (float)h.GetDouble() : 0f;
                var pageNumber = m.TryGetProperty("pageNumber", out var p) ? p.GetInt32() : 1;
                targets.Add(new RedactionTarget(item.Field!, item.Value!, pageNumber, new RectangleF(left, top, width, height)));
            }
        }
        else if (!string.IsNullOrWhiteSpace(request.ExtractionRaw))
        {
            var all = BuildRedactionTargetsFromJson(request.ExtractionRaw!);
            targets = ResolveSelectedTargets(items, all);
        }
        else
        {
            return BadRequest(new { success = false, message = "Extraction rows required." });
        }

        if (targets.Count == 0)
        {
            return BadRequest(new { success = false, message = "No redaction bounds were found in the extracted JSON." });
        }

        // Use the supplied searchable preview URL if the client
        // has it, otherwise resolve from the original.
        var redactionSourcePreviewUrl = !string.IsNullOrWhiteSpace(request.SearchablePreviewUrl)
            ? request.SearchablePreviewUrl
            : request.PreviewUrl;

        var filePath = ResolveSessionPath(redactionSourcePreviewUrl, request.SessionKey);
        if (string.IsNullOrWhiteSpace(filePath) || !System.IO.File.Exists(filePath))
        {
            return NotFound(new { success = false, message = "File not found." });
        }

        await using var input = System.IO.File.OpenRead(filePath);
        using var loadedDocument = new PdfLoadedDocument(input);

        foreach (var target in targets)
        {
            if (target.PageNumber < 1 || target.PageNumber > loadedDocument.Pages.Count)
            {
                continue;
            }
            if (loadedDocument.Pages[target.PageNumber - 1] is not PdfLoadedPage page)
            {
                continue;
            }

            if (!TryFindValueBounds(loadedDocument, target, out var valueBounds))
            {
                valueBounds = target.Bounds;
            }

            var redaction = new PdfRedaction(valueBounds, Color.Black);
            page.AddRedaction(redaction);
        }

        loadedDocument.Redact();

        var generatedDir = Path.Combine(_fileStore.GetSessionRoot(), PerSessionFileStore.GeneratedSubFolder);
        Directory.CreateDirectory(generatedDir);

        var sourceName = Path.GetFileNameWithoutExtension(request.PreviewUrl);
        var redactedFileName = $"{sourceName}-redacted-{Guid.NewGuid():N}.pdf";
        var redactedPath = Path.Combine(generatedDir, redactedFileName);

        await using (var output = System.IO.File.Create(redactedPath))
        {
            loadedDocument.Save(output);
        }

        loadedDocument.Close(true);

        var previewUrl = BuildGeneratedPreviewUrl(redactedFileName);
        var publicPreviewUrl = AppUrl(previewUrl);

        // Pass the client's SearchablePreviewUrl through
        // UNCHANGED. The client stored a fully-qualified
        // web-relative URL (already PathBase-aware) returned
        // earlier by /searchable-pdf. Re-applying AppUrl()
        // here would double-prefix the path on a live
        // deployment behind PathBase, which the client would
        // then faithfully store and 404 on in the Final
        // step. When the client didn't supply one (the
        // background /searchable-pdf call had not finished
        // by the time the user applied redaction), emit
        // null so the client's `||` fallback keeps whatever
        // value it already had - empty in the race
        // scenario, in which case the Final step correctly
        // shows the "Generate searchable PDF" CTA.
        string? publicProcessedPreviewUrl = null;
        if (!string.IsNullOrWhiteSpace(request.SearchablePreviewUrl))
        {
            publicProcessedPreviewUrl = request.SearchablePreviewUrl;
        }

        return Ok(new
        {
            success = true,
            redactedPreviewUrl = publicPreviewUrl,
            processedPreviewUrl = publicProcessedPreviewUrl
        });
    }

    // POST /api/claim-intake/wipe
    //
    // Wipes every per-session file (the original upload, the
    // materialised template, the searchable PDF, the redacted
    // PDF) and rotates the ci_session cookie so the next upload
    // goes into a fresh folder. Called by the client's reset
    // button after it has cleared its own localStorage +
    // IndexedDB.
    [HttpPost("wipe")]
    public IActionResult Wipe()
    {
        _fileStore.PurgeCurrentSession();

        // Rotate the ci_session cookie so the next upload lands
        // in a brand new per-session folder.
        var newKey = System.Security.Cryptography.RandomNumberGenerator
            .GetInt32(int.MinValue, int.MaxValue)
            .ToString("X")
            + Guid.NewGuid().ToString("N");
        Response.Cookies.Append(
            PerSessionFileStore.SessionCookieName,
            newKey,
            new CookieOptions
            {
                HttpOnly = true,
                SameSite = SameSiteMode.Lax,
                Secure = Request.IsHttps,
                // Aligned with Session:LifetimeHours (default 2h)
                // so the rotated cookie expires on the same
                // timeline as every other browser session.
                MaxAge = _fileStore.SessionLifetime,
                IsEssential = true,
                Path = "/"
            });

        return Ok(new { success = true, message = "Workflow reset." });
    }

    // GET /api/claim-intake/policy
    //
    // Returns session-lifetime hints used by the client to apply
    // the same 2h expiry on its own localStorage entry. The JS
    // cannot read appsettings.json directly; instead it asks the
    // server on first load and stamps the packet with
    // `expiresAt = now + lifetimeMs` so the value is captured
    // at save time (sliding, not fixed).
    [HttpGet("policy")]
    public IActionResult GetPolicy()
    {
        var lifetime = _fileStore.SessionLifetime;
        return Ok(new
        {
            sessionLifetimeMs = (long)lifetime.TotalMilliseconds,
            sessionLifetimeHours = lifetime.TotalHours
        });
    }
    // POST /api/claim-intake/reset-progress
    //
    // Soft reset: clears the per-document extraction
    // (searchable PDF), the redacted PDF, and any other
    // generated artefacts - but KEEPS the original uploads
    // and materialised template copies so the packet list
    // on the client still shows every file. The ci_session
    // cookie is NOT rotated, so the previewUrl of every
    // existing document in the client state still resolves.
    //
    // This is the endpoint the client's "Reset" button
    // calls. The old /wipe endpoint is reserved for the
    // migration banner (full purge + cookie rotation) and
    // the future "Delete this file" affordance.
    [HttpPost("reset-progress")]
    public IActionResult ResetProgress()
    {
        _fileStore.PurgeGeneratedOnly();
        return Ok(new { success = true, message = "Per-document progress cleared. Packet preserved." });
    }

    // POST /api/claim-intake/processed-pdf (stateless variant)
    //
    // Lazy-rebuild the searchable PDF for a previewUrl supplied
    // by the client. Kept as a recovery endpoint per spec Â§4.6.
    [HttpPost("processed-pdf")]
    public async Task<IActionResult> ProcessedPdfStateless(
        [FromBody] StatelessPreviewRequest request,
        CancellationToken cancellationToken)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.PreviewUrl))
        {
            return BadRequest(new { success = false, message = "Missing previewUrl." });
        }
        var filePath = ResolveSessionPath(request.PreviewUrl, request.SessionKey);
        if (string.IsNullOrWhiteSpace(filePath) || !System.IO.File.Exists(filePath))
        {
            return NotFound(new { success = false, message = "File not found." });
        }

        var extractor = new DataExtractor
        {
            EnableFormDetection = false,
            EnableTableDetection = true,
        };

        PdfLoadedDocument? searchableDocument = null;
        try
        {
            await using var input = System.IO.File.OpenRead(filePath);
            searchableDocument = extractor.ExtractDataAsPdfDocument(input);

            var sessionRoot = _fileStore.GetSessionRoot();
            var generatedDir = Path.Combine(sessionRoot, PerSessionFileStore.GeneratedSubFolder);
            Directory.CreateDirectory(generatedDir);

            var sourceName = Path.GetFileNameWithoutExtension(request.PreviewUrl);
            var processedFileName = $"{sourceName}-processed-{Guid.NewGuid():N}.pdf";
            var processedPath = Path.Combine(generatedDir, processedFileName);

            await using (var output = System.IO.File.Create(processedPath))
            {
                searchableDocument.Save(output);
            }

            var previewUrl = BuildGeneratedPreviewUrl(processedFileName);
            var publicPreviewUrl = AppUrl(previewUrl);

            return Ok(new
            {
                success = true,
                previewUrl = publicPreviewUrl
            });
        }
        catch
        {
            return BadRequest(new
            {
                success = false,
                message = "Unable to generate a searchable PDF for the chosen file."
            });
        }
        finally
        {
            searchableDocument?.Close(true);
        }
    }
}

// =================================================================
// Live DTOs (the client-state refactor moved the request bodies
// here from the legacy request DTOs that used to be at the
// bottom of the file).
// =================================================================

// Body for /api/claim-intake/extract, /searchable-pdf,
// /processed-pdf. The client supplies a web-relative previewUrl
// (validated by PerSessionFileStore); the server reads bytes
// from the per-session folder, no session writes.
public class StatelessPreviewRequest
{
    public string? PreviewUrl { get; set; }

    // Optional. Lets the client pin the session key when the
    // ci_session cookie has been lost between requests.
    public string? SessionKey { get; set; }
}

// Body for /api/claim-intake/redact. The client supplies the
// previewUrl plus the field/value pairs the user selected.
// ExtractionRows carries the per-row JSON the client cached
// during the extract step; ExtractionRaw is the full extractor
// JSON for the fallback path.
public class StatelessRedactRequest
{
    public string? PreviewUrl { get; set; }
    public string? SearchablePreviewUrl { get; set; }
    public string? ExtractionRaw { get; set; }
    public List<string> ExtractionRows { get; set; } = new();
    public List<RedactSelectedItem> Items { get; set; } = new();
    public string? SessionKey { get; set; }
}

// Body for /api/claim-intake/upload-by-template.
public class UploadByTemplateRequest
{
    public string? FileName { get; set; }
}

// One redaction selection. Reused by both legacy and live DTOs.
public class RedactSelectedItem
{
    public string? Field { get; set; }
    public string? Value { get; set; }
}

// Internal helper passed between the extraction / selection /
// redaction steps.
internal sealed record RedactionTarget(string Field, string Value, int PageNumber, RectangleF Bounds);
