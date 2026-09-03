using System.Text.Json;
using System.Text.Json.Nodes;
using Syncfusion.DocIO;
using Syncfusion.DocIO.DLS;

namespace Syncfusion.SmartDemo.Services.ContractReview;

/// <summary>
/// Inverse of <see cref="SfdtEmitter"/>: walks an
/// EJ2 SFDT JSON string and builds a fresh
/// <see cref="WordDocument"/> that DocIO can render
/// to PDF via <c>DocIORenderer.ConvertToPDF</c>.
/// </summary>
/// <remarks>
/// Syncfusion's modern NuGet packages (DocIO.Net.Core
/// 34.x, EJ2.AspNet.Core 34.x) do NOT ship the
/// static <c>WordDocument.Save(sfdt, FormatType.Docx)</c>
/// helper that the older Web API template uses - that
/// lives in the now-deprecated "DocumentServer"
/// package. To replicate the canonical "SFDT -&gt; PDF"
/// pattern (the user-facing pattern documented in
/// Syncfusion's /api/documenteditor/ExportPdf
/// reference sample) without pulling in the legacy
/// package, we parse the SFDT ourselves using the
/// schema <see cref="SfdtEmitter"/> emits. The
/// SFDT schema is small and stable:
/// <code>
/// {
///   "sections": [
///     {
///       "blocks": [
///         {
///           "paragraphFormat": { "styleName": "Heading1" | ..., "alignment": "Center" | ..., ... },
///           "characterFormat": { "bold": true, "italic": true, "fontSize": 24, ... },
///           "inlines": [
///             { "characterFormat": { ... }, "text": [ { "insertText": "Hello" } ] }
///           ]
///         }
///       ]
///     }
///   ]
/// }
/// </code>
/// We preserve the same formatting subset
/// (bold/italic/underline/strikeOut,
/// fontSize/fontFamily, paragraph alignment,
/// paragraph styleName) that SfdtEmitter reads. Text
/// inside a paragraph is concatenated from all
/// inlines so multi-format runs (e.g. bold + plain)
/// land as separate text runs on the same
/// paragraph. Tables, hyperlinks, images and
/// revision markers are silently skipped - the same
/// limitations SfdtEmitter has, applied
/// symmetrically. For the Contract Review AI summary
/// the user only ever sees simple paragraphs (h3 /
/// p / ul / li emitted by HtmlToDocxConverter), so
/// a flat-paragraphs parser covers the live data
/// shape without exception paths.
/// </remarks>
public static class SfdtIngestor
{
    /// <summary>
    /// Build a fresh <see cref="WordDocument"/> from
    /// an SFDT JSON string. The document has one
    /// section, one body, and one paragraph per
    /// block in the first SFDT section. Returns an
    /// empty document (one space paragraph) when the
    /// SFDT is malformed or empty so the renderer
    /// does not throw.
    /// </summary>
    public static WordDocument Build(string sfdt)
    {
        var document = new WordDocument();
        // The parameterless `new WordDocument()`
        // does NOT auto-add a section - the
        // `Sections` collection is empty until we
        // add one. Calling `document.Sections[0]`
        // on this state throws
        // `ArgumentOutOfRangeException`. The
        // correct first step is to call
        // `document.AddSection()` so we have a
        // section / body to append paragraphs
        // into. The auto-added blank paragraph
        // some users report (present when the
        // document was loaded from a file) is NOT
        // present here, so we do not need to wipe
        // anything before appending. We still call
        // AddSection once and then re-use it for
        // every block in the SFDT.
        document.AddSection();

        if (string.IsNullOrWhiteSpace(sfdt))
        {
            AppendEmptyParagraph(document);
            return document;
        }

        JsonNode? root;
        try
        {
            root = JsonNode.Parse(sfdt);
        }
        catch (JsonException)
        {
            AppendEmptyParagraph(document);
            return document;
        }
        if (root is not JsonObject rootObj)
        {
            AppendEmptyParagraph(document);
            return document;
        }

        var sections = rootObj["sections"] as JsonArray;
        if (sections is null || sections.Count == 0)
        {
            AppendEmptyParagraph(document);
            return document;
        }

        // Only the first section is rendered - the
        // Contract Review AI summary always emits a
        // single-section document (see SfdtEmitter),
        // and DocIORenderer uses section[0] for the
        // body. Mirrors the minimal-SFDT design.
        var firstSection = sections[0] as JsonObject;
        var blocks = firstSection?["blocks"] as JsonArray;
        if (blocks is null || blocks.Count == 0)
        {
            AppendEmptyParagraph(document);
            return document;
        }

        for (var i = 0; i < blocks.Count; i++)
        {
            if (blocks[i] is JsonObject block)
            {
                AppendBlock(document, block);
            }
        }
        if (document.Sections[0].Body!.ChildEntities.Count == 0)
        {
            AppendEmptyParagraph(document);
        }
        return document;
    }

    private static void AppendEmptyParagraph(WordDocument document)
    {
        var paragraph = new WParagraph(document);
        paragraph.AppendText(" ");
        document.Sections[0].Body!.ChildEntities.Add(paragraph);
    }

    private static void AppendBlock(WordDocument document, JsonObject block)
    {
        var paragraphFormat = block["paragraphFormat"] as JsonObject;
        var paragraph = new WParagraph(document);
        ApplyParagraphFormat(paragraph, paragraphFormat);

        var inlines = block["inlines"] as JsonArray;
        if (inlines is null || inlines.Count == 0)
        {
            // Empty paragraph: still surface a
            // placeholder text run so DocIO does not
            // drop the paragraph on render.
            paragraph.AppendText(string.Empty);
        }
        else
        {
            for (var i = 0; i < inlines.Count; i++)
            {
                if (inlines[i] is JsonObject inline)
                {
                    AppendInline(paragraph, inline);
                }
            }
        }

        document.Sections[0].Body!.ChildEntities.Add(paragraph);
    }

    private static void AppendInline(WParagraph paragraph, JsonObject inline)
    {
        var characterFormat = inline["characterFormat"] as JsonObject;
        var textArr = inline["text"] as JsonArray;
        if (textArr is null) { return; }
        for (var i = 0; i < textArr.Count; i++)
        {
            if (textArr[i] is not JsonObject textNode) { continue; }
            var insertText = TryGetString(textNode, "insertText") ?? string.Empty;
            // Syncfusion's SFDT encodes soft line
            // breaks as a literal "\v" or by an empty
            // text node followed by an inline
            // break. We treat "\v" / "\u000B" as a
            // paragraph-internal line break.
            if (insertText == "\v" || insertText == "\u000B")
            {
                paragraph.AppendBreak(BreakType.LineBreak);
                continue;
            }
            var run = paragraph.AppendText(insertText);
            ApplyCharacterFormat(run, characterFormat);
        }
    }

    private static void ApplyParagraphFormat(WParagraph paragraph, JsonObject? format)
    {
        if (format is null) { return; }
        var styleName = TryGetString(format, "styleName");
        if (!string.IsNullOrEmpty(styleName))
        {
            try
            {
                // ApplyStyle accepts a built-in or
                // user-defined style name. The AI
                // summary SFDT only ever uses
                // built-in styles, but a malformed
                // client could send anything. Skip
                // rather than throw - the rest of the
                // paragraph still renders.
                paragraph.ApplyStyle(styleName);
            }
            catch
            {
                // Unknown style; ignore.
            }
        }
        var alignment = TryGetString(format, "alignment");
        if (!string.IsNullOrEmpty(alignment))
        {
            var hAlign = alignment switch
            {
                "Center" => Syncfusion.DocIO.DLS.HorizontalAlignment.Center,
                "Right" => Syncfusion.DocIO.DLS.HorizontalAlignment.Right,
                "Justify" => Syncfusion.DocIO.DLS.HorizontalAlignment.Justify,
                _ => Syncfusion.DocIO.DLS.HorizontalAlignment.Left,
            };
            // ParagraphFormat is exposed via the
            // IWParagraph interface that WParagraph
            // implements. Cast through the interface
            // so the parser is resilient to future
            // shape changes in the concrete class.
            if (paragraph is IWParagraph iwp)
            {
                iwp.ParagraphFormat.HorizontalAlignment = hAlign;
            }
        }
    }

    private static void ApplyCharacterFormat(IWTextRange run, JsonObject? format)
    {
        if (format is null) { return; }
        if (TryGetBool(format, "bold") == true)
        {
            run.CharacterFormat.Bold = true;
        }
        if (TryGetBool(format, "italic") == true)
        {
            run.CharacterFormat.Italic = true;
        }
        if (TryGetBool(format, "underline") == true)
        {
            // DocIO 34.x: underline is a style enum,
            // not a bool. The single-line underline
            // matches what SFDT's "underline": true
            // conventionally means.
            run.CharacterFormat.UnderlineStyle = Syncfusion.Drawing.UnderlineStyle.Single;
        }
        if (TryGetBool(format, "strikeThrough") == true)
        {
            // DocIO 34.x renamed the property from
            // StrikeThrough to Strikeout.
            run.CharacterFormat.Strikeout = true;
        }
        if (TryGetNumber(format, "fontSize") is { } fontSize && fontSize > 0)
        {
            // SFDT emits fontSize in half-points
            // (matches Word's internal storage), so a
            // 24 = 12pt. DocIO's CharacterFormat
            // .FontSize is in points.
            run.CharacterFormat.FontSize = (float)(fontSize / 2.0);
        }
        if (TryGetString(format, "fontFamily") is { Length: > 0 } fontFamily)
        {
            run.CharacterFormat.FontName = fontFamily;
        }
    }

    private static string? TryGetString(JsonObject obj, string key)
    {
        if (!obj.TryGetPropertyValue(key, out var node) || node is null) { return null; }
        try { return node.GetValue<string>(); }
        catch (InvalidOperationException) { return null; }
    }

    private static bool? TryGetBool(JsonObject obj, string key)
    {
        if (!obj.TryGetPropertyValue(key, out var node) || node is null) { return null; }
        if (node is JsonValue v)
        {
            try { return v.GetValue<bool>(); }
            catch (InvalidOperationException) { return null; }
        }
        return null;
    }

    private static double? TryGetNumber(JsonObject obj, string key)
    {
        if (!obj.TryGetPropertyValue(key, out var node) || node is null) { return null; }
        if (node is JsonValue v)
        {
            try
            {
                if (v.TryGetValue<double>(out var d)) { return d; }
            }
            catch (InvalidOperationException) { /* fallthrough */ }
            try
            {
                if (v.TryGetValue<long>(out var l)) { return l; }
            }
            catch (InvalidOperationException) { /* fallthrough */ }
        }
        return null;
    }
}
