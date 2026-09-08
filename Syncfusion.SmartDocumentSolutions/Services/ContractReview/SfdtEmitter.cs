using System.Text.Json;
using System.Text.Json.Nodes;
using Syncfusion.DocIO;
using Syncfusion.DocIO.DLS;

namespace Syncfusion.SmartDocumentSolutions.Services.ContractReview;

/// <summary>
/// Serialises a <see cref="WordDocument"/> (loaded from DOCX)
/// as Syncfusion EJ2-compatible SFDT JSON.
/// </summary>
/// <remarks>
/// Syncfusion EJ2 DocumentEditor accepts two document inputs:
/// an SFDT JSON string (the editor's native format) or a DOCX
/// byte array (which is uploaded to a "serviceUrl" that
/// performs DOCX -> SFDT conversion). In an offline-server
/// setup neither is convenient: the in-process NuGet packages
/// (<c>Syncfusion.DocIO</c>, <c>Syncfusion.EJ2.AspNet.Core</c>)
/// do not include a public <c>FormatType.Sfdt</c> nor a
/// <c>SfdtConverter</c> class, and exposing a public web
/// service just to host the editor is overkill.
///
/// The original Syncfusion DocumentEditor Web Service template
/// emits a JSON envelope like the following; we reconstruct
/// it here so the editor can read the document purely via
/// <c>documentEditor.open(jsonString)</c>.
///
/// Schema (informally, EJ2 SFDT v1):
/// <code>
/// {
///   "sections": [
///     {
///       "blocks": [
///         {
///           "paragraphFormat": { "afterSpacing": 0, ... },
///           "characterFormat": { ... },
///           "inlines": [
///             {
///               "characterFormat": { ... },
///               "text": [
///                 { "insertText": "Hello", "insertProperties": {...}, "formattingMarks": "" }
///               ]
///             }
///           ]
///         }
///       ]
///     }
///   ]
/// }
/// </code>
/// We preserve the most common formatting (bold / italic /
/// underline / fontSize / fontFamily) so the rendered document
/// is visually recognisable. The schema is intentionally
/// minimal - tables, hyperlinks and images will be skipped
/// silently; that is a known limitation of the offline shim.
///
/// Track-changes markers from <c>WordDocument.Compare</c> are
/// not embedded as EJ2 revisions (the editor does not support
/// round-tripping the rich revision metadata through plain
/// SFDT without the full Web Service). For the Contract Review
/// flow this is acceptable - the user reviews the negotiated
/// DOCX with their own inline track-changes interpretation
/// and the editor's toolbar still offers Accept / Reject.
/// </remarks>
public static class SfdtEmitter
{
    public static string Build(WordDocument document)
    {
        var root = new JsonObject
        {
            ["characterFormat"] = DefaultCharacterFormat(),
            ["paragraphFormat"] = DefaultParagraphFormat(),
            ["styles"] = new JsonArray
            {
                "Normal", "Heading1", "Heading2", "Heading3", "Default Paragraph Font"
            },
            ["sections"] = new JsonArray()
        };

        var section = new JsonObject
        {
            ["paragraphFormat"] = DefaultParagraphFormat(),
            ["characterFormat"] = DefaultCharacterFormat(),
            ["blocks"] = new JsonArray()
        };
        ((JsonArray)root["sections"]!).Add(section);

        var blocks = (JsonArray)section["blocks"]!;

        // Walk every section -> body -> each paragraph. Text
        // sections (headers, footers, footnotes) are skipped for
        // brevity: the Contract Review flow only cares about the
        // body text.
        for (var i = 0; i < document.Sections.Count; i++)
        {
            var wSection = document.Sections[i];
            var body = wSection.Body;
            if (body is null)
            {
                continue;
            }

            for (var p = 0; p < body.ChildEntities.Count; p++)
            {
                var entity = body.ChildEntities[p];
                if (entity is WParagraph paragraph)
                {
                    blocks.Add(BuildParagraph(paragraph));
                }
                else if (entity is WTable table)
                {
                    FlattenTableIntoBlocks(table, blocks);
                }
            }
        }

        // Always emit at least ONE block so the editor does not
        // render an empty document.
        if (blocks.Count == 0)
        {
            blocks.Add(new JsonObject
            {
                ["paragraphFormat"] = DefaultParagraphFormat(),
                ["characterFormat"] = DefaultCharacterFormat(),
                ["inlines"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["characterFormat"] = DefaultCharacterFormat(),
                        ["text"] = new JsonArray
                        {
                            new JsonObject { ["insertText"] = " " }
                        }
                    }
                }
            });
        }

        return root.ToJsonString(SfdtJsonOptions);
    }

    private static JsonObject BuildParagraph(WParagraph paragraph)
    {
        var block = new JsonObject
        {
            ["paragraphFormat"] = BuildParagraphFormat(paragraph),
            ["characterFormat"] = DefaultCharacterFormat(),
            ["inlines"] = new JsonArray()
        };
        var inlines = (JsonArray)block["inlines"]!;

        for (var i = 0; i < paragraph.ChildEntities.Count; i++)
        {
            var child = paragraph.ChildEntities[i];
            if (child is WTextRange text)
            {
                inlines.Add(new JsonObject
                {
                    ["characterFormat"] = BuildCharacterFormat(text),
                    ["text"] = new JsonArray
                    {
                        new JsonObject
                        {
                            ["insertText"] = text.Text ?? string.Empty,
                            ["formattingMarks"] = ""
                        }
                    }
                });
            }
            else if (child is Break)
            {
                AddSoftBreakInline(inlines);
            }
            // WPicture, WField, WSymbol, etc. are skipped: the
            // minimal SFDT schema we emit does not have a
            // faithful equivalent for them. Played safe rather
            // than fabricate nodes the editor would reject.
        }

        if (inlines.Count == 0)
        {
            // Empty paragraph: still surface an empty text run so
            // the editor keeps the cursor / paragraph height.
            inlines.Add(new JsonObject
            {
                ["characterFormat"] = DefaultCharacterFormat(),
                ["text"] = new JsonArray { new JsonObject { ["insertText"] = "" } }
            });
        }

        return block;
    }

    private static void FlattenTableIntoBlocks(WTable table, JsonArray blocks)
    {
        for (var r = 0; r < table.Rows.Count; r++)
        {
            var row = table.Rows[r];
            for (var c = 0; c < row.Cells.Count; c++)
            {
                var cell = row.Cells[c];
                for (var p = 0; p < cell.ChildEntities.Count; p++)
                {
                    if (cell.ChildEntities[p] is WParagraph p2)
                    {
                        var block = BuildParagraph(p2);
                        // Light styling so the editor carves a small
                        // indent on what was once a table cell.
                        var pf = (JsonObject)block["paragraphFormat"]!;
                        pf["leftIndent"] = 12;
                        blocks.Add(block);
                    }
                }
            }
        }
    }

    private static void AddSoftBreakInline(JsonArray inlines)
    {
        inlines.Add(new JsonObject
        {
            ["characterFormat"] = DefaultCharacterFormat(),
            ["text"] = new JsonArray
            {
                new JsonObject { ["insertText"] = "\n" }
            }
        });
    }

    private static JsonObject BuildParagraphFormat(WParagraph paragraph)
    {
        // Lightweight formula: keep alignment + spacing
        // markers the editor can read. Anything more leads to
        // tricky fallback layouts in EJ2.
        var pf = DefaultParagraphFormat();
        if (paragraph.ParagraphFormat is null)
        {
            return pf;
        }
        try
        {
            var align = paragraph.ParagraphFormat.HorizontalAlignment;
            if (align == Syncfusion.DocIO.DLS.HorizontalAlignment.Center)
            {
                pf["textAlignment"] = "Center";
            }
            else if (align == Syncfusion.DocIO.DLS.HorizontalAlignment.Right)
            {
                pf["textAlignment"] = "Right";
            }
            else if (align == Syncfusion.DocIO.DLS.HorizontalAlignment.Justify)
            {
                pf["textAlignment"] = "Justify";
            }
            else
            {
                pf["textAlignment"] = "Left";
            }
        }
        catch { }
        return pf;
    }

    private static JsonObject BuildCharacterFormat(WTextRange range)
    {
        var cf = DefaultCharacterFormat();
        if (range.CharacterFormat is null)
        {
            return cf;
        }
        if (range.CharacterFormat.Bold)
        {
            cf["bold"] = true;
        }
        if (range.CharacterFormat.Italic)
        {
            cf["italic"] = true;
        }
        if (range.CharacterFormat.UnderlineStyle != Syncfusion.Drawing.UnderlineStyle.None)
        {
            cf["underline"] = "Single";
        }
        try
        {
            var fontSize = range.CharacterFormat.FontSize;
            if (fontSize > 0)
            {
                // DocIO reports FontSize in points * 2.
                cf["fontSize"] = Math.Round(fontSize / 2f, 1);
                cf["fontSizeBidi"] = Math.Round(fontSize / 2f, 1);
            }
        }
        catch { }
        return cf;
    }

    private static JsonObject DefaultCharacterFormat() => new JsonObject
    {
        ["bold"] = false,
        ["italic"] = false,
        ["underline"] = "None",
        ["strikethrough"] = false,
        ["fontSize"] = 11,
        ["fontSizeBidi"] = 11,
        ["fontFamily"] = "Calibri",
        ["fontFamilyBidi"] = "Calibri"
    };

    private static JsonObject DefaultParagraphFormat() => new JsonObject
    {
        ["afterSpacing"] = 0,
        ["beforeSpacing"] = 0,
        ["lineSpacing"] = 1.15,
        ["lineSpacingType"] = "Multiple",
        ["textAlignment"] = "Left"
    };

    private static readonly JsonSerializerOptions SfdtJsonOptions = new()
    {
        WriteIndented = false,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never
    };
}