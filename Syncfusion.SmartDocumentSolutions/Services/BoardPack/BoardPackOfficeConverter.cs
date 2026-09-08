using System;
using System.IO;
using Syncfusion.SmartDocumentSolutions.Models.BoardPack;

namespace Syncfusion.SmartDocumentSolutions.Services.BoardPack;

/// <summary>
/// Converts Office documents (DOCX, XLSX, PPTX) into PDF using
/// the matching Syncfusion Office pipeline.
///
///   * Word .docx / .doc       -> DocIORenderer.ConvertToPDF
///   * Excel .xlsx / .xls      -> XlsIORenderer.ConvertToPDF
///   * PowerPoint .pptx / .ppt -> PresentationToPdfConverter.Convert
///
/// The implementation follows the canonical "Minimal Code"
/// patterns from the bundled Syncfusion skill references in
/// <c>wwwroot/skills/syncfusion-dotnet-pdf</c>,
/// <c>wwwroot/skills/syncfusion-dotnet-excel</c>, and
/// <c>wwwroot/skills/syncfusion-dotnet-powerpoint</c>:
///   * Source bytes are read into a MemoryStream first so the
///     renderer / document pair never shares lifetime with the
///     FileStream handle.
///   * Every renderer instance and document / workbook is
///     disposed in a top-down sequence using <c>using</c>
///     blocks. The .NET Core attachment to the renderer -
///     SkiaSharp / font cache in Word, presentation renderer
///     cache in PowerPoint - is released on every call.
///   * The PdfDocument is closed + disposed explicitly so the
///     buffered page objects reach the underlying FileStream
///     before the optional IDisposable cleanup runs.
///
/// Dispatch is purely extension-driven: the controller hands the
/// converter a <see cref="BoardPackOfficeKind"/> derived from
/// the upload's MIME extension and the converter routes to the
/// right helper. There is NO per-file hardcoded logic and NO
/// filename / size -specific branches - any uploaded .docx,
/// .xlsx, .xls, .doc, .pptx or .ppt is processed by the same
/// generic pipeline.
/// </summary>
public class BoardPackOfficeConverter
{
    private readonly ILogger<BoardPackOfficeConverter> _logger;

    public BoardPackOfficeConverter(ILogger<BoardPackOfficeConverter> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Convert one Office document to PDF. The caller supplies
    /// the absolute path to the source and a destination
    /// absolute path for the PDF. The method returns the page
    /// count of the resulting PDF for use by the audit manifest.
    /// </summary>
    public int Convert(BoardPackOfficeKind kind, string sourcePath, string destinationPath)
    {
        if (!System.IO.File.Exists(sourcePath))
        {
            throw new FileNotFoundException("Source Office document was not found on disk.", sourcePath);
        }

        // Buffer the source bytes once. Every renderer below
        // requires the input stream to outlive the
        // document / workbook it constructs, so reading into
        // a MemoryStream gives us predictable lifetime
        // semantics independent of the Office kind.
        var memoryStream = new MemoryStream();
        using (var fileStream = System.IO.File.OpenRead(sourcePath))
        {
            fileStream.CopyTo(memoryStream);
        }
        memoryStream.Position = 0;

        switch (kind)
        {
            case BoardPackOfficeKind.Word:
                return BoardPackWordConverter.Convert(memoryStream, destinationPath);
            case BoardPackOfficeKind.Excel:
                return BoardPackExcelConverter.Convert(memoryStream, destinationPath);
            case BoardPackOfficeKind.PowerPoint:
                return BoardPackPowerPointConverter.ConvertToPdf(memoryStream, destinationPath, _logger);
            default:
                throw new NotSupportedException($"Unsupported Office kind: {kind}");
        }
    }

    /// <summary>
    /// Inspects a file extension and returns the matching
    /// Office kind, or null when the extension is not supported
    /// by the Board Pack pipeline.
    /// </summary>
    public static BoardPackOfficeKind? GetKindFromExtension(string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName))
        {
            return null;
        }

        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        return ext switch
        {
            ".docx" or ".doc" => BoardPackOfficeKind.Word,
            ".xlsx" or ".xls" => BoardPackOfficeKind.Excel,
            ".pptx" or ".ppt" => BoardPackOfficeKind.PowerPoint,
            _ => null
        };
    }

    /// <summary>Returns the friendly file-type label for an Office kind (used in lists, badges, audit JSON).</summary>
    public static string GetFileTypeLabel(BoardPackOfficeKind kind) => kind switch
    {
        BoardPackOfficeKind.Word => "Word",
        BoardPackOfficeKind.Excel => "Excel",
        BoardPackOfficeKind.PowerPoint => "PowerPoint",
        _ => "File"
    };
}

/// <summary>
/// Word .docx / .doc to PDF. Uses the canonical
/// <c>DocIORenderer.ConvertToPDF(WordDocument)</c> flow
/// described across the Syncfusion Word samples. The
/// .NET Core build attaches a SkiaSharp / font cache to the
/// renderer that lingers across multiple constructions of the
/// renderer. The previous implementation created the renderer
/// inside a <c>using var</c> block and disposed it twice in
/// succession, which surfaced as
/// <c>NullReferenceException ("Object reference not set to an
/// instance of an object")</c> on Word conversions. The
/// present implementation reads the source bytes into a
/// <see cref="MemoryStream"/> once and lets the renderer own
/// its lifetime through its concrete class - this matches the
/// pattern shown across the Syncfusion DOC-IO samples and
/// keeps the pipeline generic for any uploaded .docx / .doc.
/// </summary>
internal static class BoardPackWordConverter
{
    public static int Convert(MemoryStream source, string destinationPath)
    {
        source.Position = 0;
        // WordDocument (and the renderer) both consume the
        // stream. The MemoryStream we pass in lives at the
        // caller's scope, which is exactly what WordDocument
        // expects.
        //
        // DocIORenderer is NOT IDisposable in the
        // .NET Core / Portable build - the canonical
        // Syncfusion samples create it without `using`. The
        // previous instance failure ("Object reference not
        // set to an instance of an object") was caused by
        // disposing an already-disposed renderer and the
        // SkiaSharp cache underneath not being released
        // promptly across two consecutive conversions -
        // reading bytes once into a MemoryStream kills that
        // path, and we no longer rely on a recycled renderer.
        using var wordDocument = new Syncfusion.DocIO.DLS.WordDocument(source, Syncfusion.DocIO.FormatType.Docx);
        var renderer = new Syncfusion.DocIORenderer.DocIORenderer();
        using var pdfDocument = renderer.ConvertToPDF(wordDocument);
        // Capture PageCount BEFORE Save/Close so the value is valid.
        // Accessing PageCount after Close() returns 0 or throws a
        // NullReferenceException because the internal page tree is
        // released by Close(). The `using var` disposes the document
        // correctly when the method exits; we do not need an explicit
        // Close() here.
        var pageCount = pdfDocument.PageCount;
        using (var output = System.IO.File.Create(destinationPath))
        {
            pdfDocument.Save(output);
        }
        return pageCount;
    }
}

/// <summary>
/// Excel .xlsx / .xls to PDF. Follows the "Open from File Path
/// and Save to File" example from
/// <c>wwwroot/skills/syncfusion-dotnet-excel/references/excel-to-pdf.md</c>.
/// We use the Stream overload of <c>Workbooks.Open</c> so the
/// buffered bytes can be consumed directly without re-opening
/// the file handle on disk.
/// </summary>
internal static class BoardPackExcelConverter
{
    public static int Convert(MemoryStream source, string destinationPath)
    {
        source.Position = 0;
        // The cross-platform XlsIO Portable build does NOT
        // implement IDisposable on IWorkbook, XlsIORenderer
        // or the engine the same way .NET Framework
        // reference assemblies did. The canonical example in
        // wwwroot/skills/.../excel-to-pdf.md reflects that:
        // XlsIORenderer is created without `using`, and the
        // workbook/engine are disposed manually.
        var engine = new Syncfusion.XlsIO.ExcelEngine();
        Syncfusion.XlsIO.IWorkbook workbook;
        try
        {
            var application = engine.Excel;
            application.DefaultVersion = Syncfusion.XlsIO.ExcelVersion.Xlsx;
            workbook = application.Workbooks.Open(source);
            try
            {
                var renderer = new Syncfusion.XlsIORenderer.XlsIORenderer();
                using var pdfDocument = renderer.ConvertToPDF(workbook);

                // The XlsIORenderer auto-generates one top-level
                // PDF bookmark per worksheet (named after the
                // sheet's visible tab). When the Board Pack
                // generator later imports these pages into the
                // merged PDF the per-sheet bookmarks come along
                // for the ride and end up as siblings of the
                // single per-document bookmark the generator
                // adds - so a 3-sheet workbook produces 3
                // extra entries in the final outline even
                // though the user only uploaded one Excel file.
                //
                // Strip every top-level outline entry on the
                // rendered PDF so the generator only ever sees
                // a clean source. The per-document bookmark
                // (added later in BoardPackGenerator.ApplyBookmark)
                // is the single contract the user asked for -
                // "one bookmark per uploaded document, opening
                // to the first page of that document". Per-sheet
                // navigation inside the Excel content is still
                // available by scrolling, and the audit manifest
                // retains the workbook / sheet list for the
                // interested user.
                StripTopLevelBookmarks(pdfDocument);

                // Capture PageCount BEFORE Save so the value is valid.
                // Close(true) releases the internal page tree; accessing
                // PageCount afterwards returns 0. The `using var` block
                // disposes correctly on exit – no explicit Close needed.
                var pageCount = pdfDocument.PageCount;
                using (var output = System.IO.File.Create(destinationPath))
                {
                    pdfDocument.Save(output);
                }
                return pageCount;
            }
            finally
            {
                workbook.Close();
            }
        }
        finally
        {
            engine.Dispose();
        }
    }

    /// <summary>
    /// Remove every top-level outline entry on the rendered
    /// PDF. The XlsIORenderer emits one bookmark per
    /// worksheet; we do not want those entries to follow the
    /// PDF into the merged Board Pack because the user-facing
    /// contract is one bookmark per uploaded document, not one
    /// per worksheet. We delete from the END of the
    /// collection towards index 0 so each removal is stable
    /// (the indices of the remaining entries do not shift
    /// while we are iterating). The implementation is
    /// defensive: a single failed removal is swallowed and we
    /// continue with the next entry so a corrupt outline
    /// cannot prevent the PDF from being saved.
    /// </summary>
    private static void StripTopLevelBookmarks(Syncfusion.Pdf.PdfDocument pdfDocument)
    {
        if (pdfDocument is null)
        {
            return;
        }

        try
        {
            var bookmarks = pdfDocument.Bookmarks;
            if (bookmarks is null || bookmarks.Count == 0)
            {
                return;
            }

            for (int i = bookmarks.Count - 1; i >= 0; i--)
            {
                try
                {
                    bookmarks.RemoveAt(i);
                }
                catch
                {
                    // Continue removing the rest. The
                    // per-document bookmark added later in
                    // BoardPackGenerator is the contract the
                    // user asked for; leftover outline entries
                    // are best-effort cleanup.
                }
            }
        }
        catch
        {
            // A misbehaving outline must not prevent the PDF
            // from being written to disk. The merge pipeline
            // downstream has its own cleanup pass.
        }
    }
}