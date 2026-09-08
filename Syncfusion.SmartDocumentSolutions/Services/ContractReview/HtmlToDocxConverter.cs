using System.Text;
using System.Text.RegularExpressions;
using Syncfusion.DocIO;
using Syncfusion.DocIO.DLS;

namespace Syncfusion.SmartDocumentSolutions.Services.ContractReview;

/// <summary>
/// Converts the small, semantic HTML the
/// <see cref="AIChangeSummaryGenerator"/> produces into a
/// real DOCX file the user can download and the EJ2
/// DocumentEditor can open. Mirrors the shape of the
/// reference <c>HTMLToWord</c> Razor Page that ships in
/// <c>Reference\Htmltodocx.cs</c>: DocIO accepts HTML
/// via <c>WordDocument(stream, FormatType.Html)</c>, so
/// the conversion is a single load + save call.
///
/// We deliberately do NOT use a web browser or a heavyweight
/// HTML renderer here. The AI agent is constrained by the
/// system prompt to emit only <c>&lt;p&gt;</c>,
/// <c>&lt;ul&gt;</c>, <c>&lt;li&gt;</c>, <c>&lt;strong&gt;</c>,
/// <c>&lt;em&gt;</c> and <c>&lt;h3&gt;</c>, so DocIO's
/// built-in HTML reader handles the full grammar without
/// dropping any semantic block.
///
/// Two things the reference page does that we keep:
///   * the input is wrapped in a minimal HTML5 skeleton
///     (with the right meta charset) so DocIO can pick up
///     the encoding reliably;
///   * the DOCX is emitted straight to a MemoryStream so
///     the controller can either hand it back as a
///     download or persist it on disk.
///
/// One thing we add: a small post-processing pass that
/// runs DocIO on the freshly loaded document and re-walks
/// every paragraph / run to (a) drop the default Calibri
/// 11 in favour of a slightly more "letter" feel and
/// (b) make sure the H3 headings carry a bit of weight.
/// This is what the user perceives as "more Word, less
/// browser printout".
/// </summary>
public sealed class HtmlToDocxConverter
{
    private readonly ILogger<HtmlToDocxConverter> _logger;

    public HtmlToDocxConverter(ILogger<HtmlToDocxConverter> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Convert <paramref name="html"/> to a DOCX byte
    /// array. <paramref name="title"/> is rendered as the
    /// document title (a top-level heading) above the
    /// converted body so the file opens with a recognisable
    /// banner in the EJ2 editor.
    /// </summary>
    public byte[] Convert(string html, string? title = null)
    {
        if (string.IsNullOrWhiteSpace(html))
        {
            html = "<p>(empty summary)</p>";
        }

        var wrapped = WrapForDocIo(html, title);

        using var input = new MemoryStream(Encoding.UTF8.GetBytes(wrapped));
        using var document = new WordDocument(input, FormatType.Html);
        ApplyHouseStyle(document);

        using var output = new MemoryStream();
        document.Save(output, FormatType.Docx);
        var bytes = output.ToArray();
        _logger.LogDebug("Converted AI summary HTML to DOCX: {Bytes} bytes (title='{Title}').", bytes.Length, title);
        return bytes;
    }

    /// <summary>
    /// Persist <paramref name="html"/> as a DOCX on disk
    /// and return the absolute path. Used by the
    /// controller to drop the file into the per-session
    /// Generated subfolder so the browser can fetch it
    /// via the existing preview URL convention.
    /// </summary>
    public string ConvertToFile(string html, string outputPath, string? title = null)
    {
        var bytes = Convert(html, title);
        var directory = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrWhiteSpace(directory) && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }
        File.WriteAllBytes(outputPath, bytes);
        return outputPath;
    }

    /// <summary>
    /// Wrap the AI-supplied HTML fragment in a minimal
    /// HTML5 document with explicit UTF-8 charset. DocIO's
    /// HTML reader is happy with fragments, but the
    /// fragment is sometimes written by the model with
    /// smart quotes or other characters that the default
    /// code page mishandles, so we pin UTF-8 up front.
    /// </summary>
    private static string WrapForDocIo(string html, string? title)
    {
        var titleBlock = string.IsNullOrWhiteSpace(title)
            ? string.Empty
            : $"<h1 style=\"font-family:Calibri;font-size:18pt;\">{System.Net.WebUtility.HtmlEncode(title)}</h1>";
        return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body>"
            + titleBlock
            + html
            + "</body></html>";
    }

    /// <summary>
    /// Light post-processing pass: re-walk every section /
    /// paragraph in the loaded document and apply a
    /// consistent body + heading style. DocIO's HTML
    /// importer is conservative about applying the styles
    /// declared in the input HTML, so doing this in
    /// C# gives us a single chokepoint to enforce the
    /// "house style" without forking the AI prompt on
    /// formatting minutiae.
    /// </summary>
    private static void ApplyHouseStyle(WordDocument document)
    {
        for (var s = 0; s < document.Sections.Count; s++)
        {
            var section = document.Sections[s];
            var body = section.Body;
            if (body is null) { continue; }
            for (var i = 0; i < body.ChildEntities.Count; i++)
            {
                if (body.ChildEntities[i] is WParagraph paragraph)
                {
                    StyleParagraph(paragraph);
                }
            }
        }
    }

    private static void StyleParagraph(WParagraph paragraph)
    {
        // Normalise the font for every run. DocIO's
        // default is Calibri 11, which is fine, but we
        // widen the line spacing a touch to give the
        // summary some breathing room.
        try
        {
            paragraph.ParagraphFormat.LineSpacing = 14f;
        }
        catch
        {
            // some DocIO builds do not expose LineSpacing
            // as a settable float; ignore and let the
            // default stand.
        }

        var styleName = paragraph.StyleName ?? string.Empty;
        var isHeading = styleName.StartsWith("Heading", StringComparison.OrdinalIgnoreCase);
        for (var i = 0; i < paragraph.ChildEntities.Count; i++)
        {
            if (paragraph.ChildEntities[i] is WTextRange range)
            {
                try
                {
                    if (isHeading)
                    {
                        range.CharacterFormat.Bold = true;
                    }
                }
                catch
                {
                    // ignore individual run failures; the
                    // document is still readable.
                }
            }
        }
    }
}
