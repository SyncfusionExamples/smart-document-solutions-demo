using System;
using System.IO;
using Syncfusion.Presentation;
using Syncfusion.PresentationRenderer;
using Syncfusion.Pdf;

namespace Syncfusion.SmartDocumentSolutions.Services.BoardPack;

/// <summary>
/// PowerPoint .pptx / .ppt -> PDF for the Board Pack pipeline.
///
/// Follows the canonical cross-platform pattern documented in
/// <c>wwwroot/skills/syncfusion-dotnet-powerpoint/references/conversions.md</c>:
///
/// <code>
/// using Syncfusion.Presentation;
/// using Syncfusion.PresentationRenderer;
/// using Syncfusion.Pdf;
///
/// using (PdfDocument pdfDocument =
///     PresentationToPdfConverter.Convert(pptxDoc))
/// {
///     using (FileStream outputStream =
///         new FileStream(destinationPath, FileMode.Create, FileAccess.ReadWrite))
///     {
///         pdfDocument.Save(outputStream);
///     }
/// }
/// </code>
///
/// The previous in-house implementation rasterised each slide to
/// a bitmap through a hand-rolled reflection-based
/// <c>ConvertToImage</c> walker, which was fragile and depended
/// on Syncfusion internal API surface that differs across
/// builds. Switching to the published
/// <c>PresentationToPdfConverter.Convert</c> helper removes
/// every reflection call - the pipeline now uses only
/// documented APIs for any uploaded presentation.
/// </summary>
public static class BoardPackPowerPointConverter
{
    /// <summary>
    /// Convert the .pptx / .ppt bytes in <paramref name="source"/>
    /// to <paramref name="destinationPath"/> as a multi-page PDF.
    /// Returns the page count of the resulting PDF for the
    /// audit manifest. No filename- or size-specific branching -
    /// any uploaded presentation flows through the same generic
    /// pipeline.
    /// </summary>
    public static int ConvertToPdf(MemoryStream source, string destinationPath, ILogger logger)
    {
        source.Position = 0;
        // Open the presentation from the buffered stream. The
        // underlying zip directory stays readable until we
        // Close() the IPresentation below.
        IPresentation presentation = Syncfusion.Presentation.Presentation.Open(source);
        try
        {
            // PresentationToPdfConverter lives in the
            // Syncfusion.PresentationRenderer assembly, which
            // the csproj already references through
            // Syncfusion.PresentationRenderer.Net.Core.
            using (var pdfDocument = PresentationToPdfConverter.Convert(presentation))
            {
                // Capture PageCount BEFORE Save so the value is valid.
                // Close(true) releases the internal page tree; accessing
                // PageCount afterwards returns 0 or throws.
                var pageCount = pdfDocument.PageCount;
                using (var outputStream = System.IO.File.Create(destinationPath))
                {
                    pdfDocument.Save(outputStream);
                }
                logger?.LogInformation(
                    "Board Pack: converted {SlideCount}-slide presentation to a {PageCount}-page PDF.",
                    presentation.Slides.Count,
                    pageCount);
                return pageCount;
            }
        }
        finally
        {
            presentation.Close();
        }
    }
}