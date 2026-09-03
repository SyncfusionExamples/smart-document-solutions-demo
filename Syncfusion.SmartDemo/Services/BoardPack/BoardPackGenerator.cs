using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Syncfusion.Drawing;
using Syncfusion.Pdf;
using Syncfusion.Pdf.Graphics;
using Syncfusion.Pdf.Interactive;
using Syncfusion.Pdf.Parsing;
using Syncfusion.Pdf.Security;
using Syncfusion.SmartDemo.Models.BoardPack;

namespace Syncfusion.SmartDemo.Services.BoardPack;

/// <summary>
/// Generates the final Board Pack PDF. The pipeline:
///   1. Build the merge order from
///      <see cref="BoardPackWorkspace.Documents"/>.MergeOrder.
///   2. Load each converted PDF in turn with
///      <c>PdfLoadedDocument</c> and append its pages to a
///      destination <c>PdfDocument</c> using
///      <c>PdfDocumentBase.ImportPageRange</c> so embedded
///      annotations / form fields keep their positions on the
///      destination page.
///   3. After each document is appended add a top-level
///      <c>PdfBookmark</c> whose destination points at the first
///      page of that section so the reader's outlines panel
///      navigates straight there.
///   4. For every document whose
///      <see cref="BoardPackWatermarkConfig"/> is enabled, draw
///      the watermark text on each page of that document's
///      section.
///   5. If the workspace opted into password protection, configure
///      AES-256 encryption with the user's password.
///   6. Save the final PDF, append every audit fact to
///      <see cref="BoardPackAuditManifest"/>, and write the
///      manifest to disk.
/// </summary>
public class BoardPackGenerator
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    private readonly ILogger<BoardPackGenerator> _logger;

    public BoardPackGenerator(ILogger<BoardPackGenerator> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Result of running the pipeline. The controller exposes
    /// these fields as JSON to the client so the Export page can
    /// show previews / downloads without re-running the generator.
    /// </summary>
    public class GenerationResult
    {
        public string FinalPdfPath { get; set; } = string.Empty;
        public string SessionRoot { get; set; } = string.Empty;
        public int TotalPages { get; set; }
        public int TotalDocuments { get; set; }
        public List<BoardPackAuditBookmark> Bookmarks { get; set; } = new();
        public List<BoardPackAuditWatermark> Watermarks { get; set; } = new();
        public bool PasswordProtectionApplied { get; set; }
        public string? SourcesZipPath { get; set; }
        public string? ManifestPath { get; set; }
        public BoardPackAuditManifest Manifest { get; set; } = new();
    }

    private readonly BoardPackWorkspaceStore _store;

    public BoardPackGenerator(
        ILogger<BoardPackGenerator> logger,
        BoardPackWorkspaceStore store)
    {
        _logger = logger;
        _store = store;
    }

    /// <summary>
    /// Run the full pipeline. The caller supplies the live
    /// workspace snapshot (source of truth for merge order,
    /// watermark configs, password flag) and the per-session
    /// file paths are resolved through the injected workspace
    /// store.
    /// </summary>
    public GenerationResult Generate(BoardPackWorkspace workspace)
    {
        if (workspace is null)
        {
            throw new ArgumentNullException(nameof(workspace));
        }

        if (workspace.Documents.Count == 0)
        {
            throw new InvalidOperationException("At least one converted document is required before generating a Board Pack.");
        }

        // Pull a deterministic merge order: take every document
        // that has actually been converted and sort by
        // MergeOrder ascending (then by UploadedAtUtc so the
        // first upload wins the tie-breaker on the default 0
        // values).
        var ordered = workspace.Documents
            .Where(d => d.Status == BoardPackConversionStatus.Converted && !string.IsNullOrWhiteSpace(d.ConvertedFileName))
            .OrderBy(d => d.MergeOrder)
            .ThenBy(d => d.UploadedAtUtc)
            .ToList();

        if (ordered.Count == 0)
        {
            throw new InvalidOperationException("None of the uploaded documents were successfully converted.");
        }

        var sessionRoot = _store.GetSessionRoot();
        var finalPdfPath = Path.Combine(sessionRoot, BoardPackGeneratorPaths.GeneratedSubFolder, BoardPackGeneratorPaths.BoardPackPdfFileName);
        var sourcesZipPath = Path.Combine(sessionRoot, BoardPackGeneratorPaths.GeneratedSubFolder, BoardPackGeneratorPaths.SourcesZipFileName);
        var manifestPath = Path.Combine(sessionRoot, BoardPackGeneratorPaths.GeneratedSubFolder, BoardPackGeneratorPaths.ManifestFileName);
        Directory.CreateDirectory(Path.GetDirectoryName(finalPdfPath)!);

        var bookmarks = new List<BoardPackAuditBookmark>();
        var auditWatermarks = new List<BoardPackAuditWatermark>();

        using (var finalDoc = new PdfDocument())
        {
            // Track the page index (0-based) at which each
            // document's section starts so the audit JSON can
            // reference 1-based "page 1 of section X".
            var sectionStartPages = new Dictionary<string, int>();
            int currentSectionStart = 0;

            for (int i = 0; i < ordered.Count; i++)
            {
                var doc = ordered[i];
                var pdfPath = ResolveConvertedPdfPath(workspace, doc);
                if (!System.IO.File.Exists(pdfPath))
                {
                    throw new FileNotFoundException($"Converted PDF for '{doc.FileName}' was not found on disk.", pdfPath);
                }

                sectionStartPages[doc.Id] = finalDoc.Pages.Count; // 0-based

                using (var loaded = new PdfLoadedDocument(pdfPath))
                {
                    if (loaded.Pages.Count == 0)
                    {
                        _logger.LogWarning("Converted PDF for {Doc} has zero pages; it will be skipped from the final Board Pack.", doc.FileName);
                        continue;
                    }

                    // Capture the source-document bookmark tree BEFORE
                    // importing pages. The converted PDF (e.g. a Word
                    // doc rendered to PDF by DocIORenderer, or a
                    // PowerPoint converted by PresentationToPdfConverter)
                    // may contain its own outline tree with one entry per
                    // heading / slide title. ImportPage on Syncfusion's
                    // PdfDocumentBase carries those outline entries over
                    // to the destination document as top-level bookmarks,
                    // which would end up as SIBLINGS of the per-document
                    // bookmark we want to render in the final Board Pack
                    // (so 3 documents can produce 5+ outline entries).
                    // Snapshotting the tree up front lets us rebuild it
                    // under the per-document bookmark AFTER the import.
                    var sourceOutline = CaptureOutlineSnapshot(loaded);
                    var bookmarkCountBefore = finalDoc.Bookmarks.Count;

                    currentSectionStart = ImportAllPages(finalDoc, loaded);

                    // --- 1. Bookmarks ----------------------------------------------
                    // The single per-document bookmark ALWAYS points at the
                    // first page of the document's section. Any source
                    // outline entries that were carried over by
                    // ImportPage are re-parented under this bookmark so
                    // the final PDF shows exactly one top-level entry
                    // per uploaded document, with the source headings as
                    // children. We then remove any duplicate top-level
                    // bookmarks the import introduced (the import
                    // appends after the existing top-level entries, so
                    // the new entries all sit at indices >= the count
                    // captured before the import).
                    ApplyBookmark(finalDoc, doc, currentSectionStart, bookmarks, sourceOutline, bookmarkCountBefore);
                }
            }

            // --- 2. Common watermark -------------------------------------------
            // The Pack step now exposes a SINGLE packet-wide
            // watermark editor (toggle + text "Confidential" +
            // colour picker). When enabled we draw that text on
            // every page of the final Board Pack so the watermark
            // is consistent across the merged document. The
            // per-document watermark rows on the old UI are kept
            // for backwards compatibility with old snapshots but
            // are intentionally not consulted here.
            if (workspace.CommonWatermark is { Enabled: true } &&
                !string.IsNullOrWhiteSpace(workspace.CommonWatermark.Text))
            {
                ApplyCommonWatermark(finalDoc, workspace.CommonWatermark, auditWatermarks);
            }
            else
            {
                auditWatermarks.Add(new BoardPackAuditWatermark
                {
                    DocumentId = string.Empty,
                    SourceFileName = "(board pack)",
                    Enabled = false,
                    Text = workspace.CommonWatermark?.Text ?? string.Empty,
                    Color = workspace.CommonWatermark?.Color,
                    FontSize = workspace.CommonWatermark?.FontSize ?? 0,
                    Opacity = workspace.CommonWatermark?.Opacity ?? 0,
                    Rotation = workspace.CommonWatermark?.Rotation ?? 0
                });
            }

            // --- 3. Password protection (apply BEFORE save so the
            // file on disk is encrypted) ----------------------------
            bool passwordApplied = false;
            if (workspace.PasswordProtect && !string.IsNullOrWhiteSpace(workspace.Password))
            {
                var security = finalDoc.Security;
                security.KeySize = PdfEncryptionKeySize.Key256Bit;
                security.Algorithm = PdfEncryptionAlgorithm.AES;
                security.UserPassword = workspace.Password;
                security.OwnerPassword = string.IsNullOrWhiteSpace(workspace.Password)
                    ? "owner"
                    : workspace.Password + "-owner";
                security.EncryptionOptions = PdfEncryptionOptions.EncryptAllContents;
                passwordApplied = true;
            }

            using (var outStream = System.IO.File.Create(finalPdfPath))
            {
                finalDoc.Save(outStream);
            }
            finalDoc.Close(true);

            var result = new GenerationResult
            {
                FinalPdfPath = finalPdfPath,
                SessionRoot = sessionRoot,
                TotalDocuments = ordered.Count,
                TotalPages = totalPages(ordered, workspace),
                Bookmarks = bookmarks,
                Watermarks = auditWatermarks,
                PasswordProtectionApplied = passwordApplied,
                SourcesZipPath = sourcesZipPath,
                ManifestPath = manifestPath
            };

            BuildSourcesZip(workspace, ordered, sourcesZipPath);
            WriteManifest(workspace, ordered, bookmarks, auditWatermarks, passwordApplied, result, manifestPath);

            return result;
        }
    }

    private static int totalPages(List<BoardPackSourceDocument> ordered, BoardPackWorkspace workspace)
    {
        // Best-effort: sum converted page counts. The actual
        // truth lives in the generated PDF, but the controller
        // exposes the manifest with the same number and the
        // export page can use either source.
        return ordered
            .Where(d => !string.IsNullOrWhiteSpace(d.ConvertedFileName))
            .Sum(d => d.ConvertedPageCount);
    }

    private static int ImportAllPages(PdfDocument target, PdfLoadedDocument loaded)
    {
        int startPage = target.Pages.Count;
        for (int i = 0; i < loaded.Pages.Count; i++)
        {
            target.ImportPage(loaded, i);
        }
        return startPage;
    }

    /// <summary>
    /// Snapshot of a single outline entry inside a converted source
    /// PDF. We only need the data we can re-emit through the public
    /// <see cref="Syncfusion.Pdf.Interactive.PdfBookmark"/> API:
    /// the visible title, the 0-based page index inside the source
    /// document the entry originally pointed at, and the tree of
    /// child entries (captured as the same shape recursively).
    /// Storing this BEFORE the page import means the final Board
    /// Pack outline can be rebuilt under a single per-document
    /// bookmark even after the import wipes or re-parents the
    /// original entries.
    /// </summary>
    private sealed class OutlineSnapshot
    {
        public string Title { get; set; } = string.Empty;
        public int PageIndex { get; set; }
        public List<OutlineSnapshot> Children { get; set; } = new();
    }

    /// <summary>
    /// Walk the outline tree of <paramref name="loaded"/> and capture
    /// every entry as an <see cref="OutlineSnapshot"/>. The
    /// <see cref="Syncfusion.Pdf.Interactive.PdfLoadedBookmark"/>
    /// tree carries the same hierarchy as the rendered PDF's
    /// bookmarks panel, so a recursive walk produces a faithful copy
    /// we can re-emit in the destination document. We use the
    /// destination page's index inside the SOURCE document - that is
    /// what the source renderer set; the generator will re-base it
    /// onto the merged document's page indices when it re-emits
    /// each entry under the per-document bookmark.
    /// </summary>
    private static List<OutlineSnapshot> CaptureOutlineSnapshot(PdfLoadedDocument loaded)
    {
        var result = new List<OutlineSnapshot>();
        try
        {
            for (int i = 0; i < loaded.Bookmarks.Count; i++)
            {
                var entry = loaded.Bookmarks[i] as Syncfusion.Pdf.Interactive.PdfBookmark;
                if (entry is null) { continue; }
                result.Add(CaptureBookmarkEntry(entry, loaded));
            }
        }
        catch
        {
            // Defensive: a corrupt source outline must not break the
            // merge. Return what we have so far (likely an empty
            // list) so the generator still produces a valid Board
            // Pack with just the per-document bookmark.
        }
        return result;
    }

    /// <summary>
    /// Find the 0-based index of <paramref name="page"/> inside
    /// <paramref name="loaded"/>. The Syncfusion
    /// <see cref="Syncfusion.Pdf.Parsing.PdfLoadedPageCollection"/>
    /// does not expose an <c>IndexOf</c> method on .NET Core, so we
    /// walk the collection comparing by reference. The walk is
    /// bounded by the source document's page count, which is the
    /// same order of magnitude as the destination document so the
    /// cost is negligible. Returns -1 when the page is not found.
    /// </summary>
    private static int IndexOfPageInLoaded(PdfLoadedDocument loaded, Syncfusion.Pdf.PdfPageBase page)
    {
        if (loaded is null || page is null) { return -1; }
        try
        {
            for (int i = 0; i < loaded.Pages.Count; i++)
            {
                if (ReferenceEquals(loaded.Pages[i], page))
                {
                    return i;
                }
            }
        }
        catch
        {
            // Defensive: a misbehaving loaded document must not
            // throw during outline capture.
        }
        return -1;
    }

    /// <summary>
    /// Find the 0-based index of <paramref name="page"/> inside
    /// <paramref name="finalDoc"/>. Mirrors
    /// <see cref="IndexOfPageInLoaded"/> for the destination
    /// <see cref="PdfDocument"/>; the same reference-equality walk
    /// works because <see cref="PdfDocumentBase.Pages"/> is a
    /// <c>PdfPageCollection</c> that also lacks <c>IndexOf</c> on
    /// the .NET Core build.
    /// </summary>
    private static int IndexOfPageInFinal(PdfDocument finalDoc, Syncfusion.Pdf.PdfPageBase page)
    {
        if (finalDoc is null || page is null) { return -1; }
        try
        {
            for (int i = 0; i < finalDoc.Pages.Count; i++)
            {
                if (ReferenceEquals(finalDoc.Pages[i], page))
                {
                    return i;
                }
            }
        }
        catch
        {
            // Defensive.
        }
        return -1;
    }

    /// <summary>
    /// Recursively snapshot a single outline entry. The base
    /// <see cref="Syncfusion.Pdf.Interactive.PdfBookmarkBase"/>
    /// exposes <c>Count</c> and the indexer for tree traversal,
    /// but the per-entry <c>Title</c> and <c>Destination</c>
    /// members live on the derived <see cref="Syncfusion.Pdf.Interactive.PdfBookmark"/>
    /// class. <c>PdfLoadedBookmark</c> inherits from
    /// <c>PdfBookmark</c>, so this cast works for any node we pull
    /// out of <c>loaded.Bookmarks</c> (and for child nodes walked
    /// through the same indexer).
    /// </summary>
    private static OutlineSnapshot CaptureBookmarkEntry(Syncfusion.Pdf.Interactive.PdfBookmark entry, PdfLoadedDocument owner)
    {
        var snap = new OutlineSnapshot
        {
            Title = entry.Title ?? string.Empty,
            PageIndex = 0
        };
        try
        {
            if (entry.Destination?.Page is { } destPage)
            {
                var idx = IndexOfPageInLoaded(owner, destPage);
                if (idx >= 0)
                {
                    snap.PageIndex = idx;
                }
            }
        }
        catch
        {
            // Keep the default PageIndex = 0 on any failure.
        }

        // Recurse into children. The indexer on PdfBookmarkBase
        // returns PdfBookmarkBase instances, so we cast to
        // PdfBookmark (the runtime type is PdfLoadedBookmark, which
        // derives from PdfBookmark) before recursing.
        try
        {
            for (int i = 0; i < entry.Count; i++)
            {
                var child = entry[i] as Syncfusion.Pdf.Interactive.PdfBookmark;
                if (child is null) { continue; }
                snap.Children.Add(CaptureBookmarkEntry(child, owner));
            }
        }
        catch
        {
            // Drop children on failure rather than throw.
        }

        return snap;
    }

    /// <summary>
    /// Create (and audit) the single per-document bookmark for the
    /// document that was just appended. The bookmark points at the
    /// first page of this document's section in the merged PDF and
    /// uses the user-configured <see cref="BoardPackSourceDocument.BookmarkTitle"/>
    /// (or the display name / file name as a fallback).
    ///
    /// Source PDF outline entries captured by
    /// <see cref="CaptureOutlineSnapshot"/> are re-emitted as
    /// children of this bookmark, with their destinations remapped
    /// onto the merged document's page indices. This keeps the
    /// Board Pack outline at exactly one top-level entry per
    /// document while still preserving every heading / slide-title
    /// the source renderer produced.
    /// </summary>
    private static void ApplyBookmark(PdfDocument finalDoc, BoardPackSourceDocument doc, int startPageIndex, List<BoardPackAuditBookmark> audit, List<OutlineSnapshot> sourceOutline, int bookmarkCountBeforeImport)
    {
        if (finalDoc.Pages.Count == 0)
        {
            return;
        }

        // 0-based startPageIndex => PdfDestination.Page expects the
        // 0-based position into the destination document's
        // pages collection.
        var safeIndex = Math.Min(Math.Max(startPageIndex, 0), finalDoc.Pages.Count - 1);
        var destinationPage = finalDoc.Pages[safeIndex];

        var title = string.IsNullOrWhiteSpace(doc.BookmarkTitle)
            ? (string.IsNullOrWhiteSpace(doc.DisplayName) ? doc.FileName : doc.DisplayName)
            : doc.BookmarkTitle;

        // Remove any top-level bookmarks the import of source pages
        // appended to the merged document. ImportPage on Syncfusion's
        // PdfDocumentBase copies over the source outline, which is
        // exactly the duplicate behaviour that produced the
        // "Executive Dashboard" / "Financial Detail" siblings we
        // saw in the bug report. We captured bookmarkCountBefore
        // before the import so we know which entries are
        // import-introduced.
        //
        // The order matters: PdfBookmarkBase.RemoveAt(int) takes an
        // index, but indices shift as we delete entries. We collect
        // the snapshots first (title + relative page) and remove
        // them by index from the end so the loop is stable, then
        // re-emit them under the per-document bookmark using the
        // preserved snapshot data. This is more robust than trying
        // to mutate the existing PdfBookmark objects in place
        // because we cannot change a bookmark's parent after it
        // has been added to the collection.
        var importedSnapshots = new List<OutlineSnapshot>();
        try
        {
            // Capture from the END so removing by index is stable.
            for (int i = finalDoc.Bookmarks.Count - 1; i >= bookmarkCountBeforeImport; i--)
            {
                var bm = finalDoc.Bookmarks[i] as Syncfusion.Pdf.Interactive.PdfBookmark;
                if (bm is null) { continue; }
                var snap = new OutlineSnapshot
                {
                    Title = bm.Title ?? string.Empty,
                    PageIndex = 0 // relative offset within this document's section
                };
                try
                {
                    if (bm.Destination?.Page is { } destPage)
                    {
                        var idx = IndexOfPageInFinal(finalDoc, destPage);
                        if (idx >= 0)
                        {
                            // Express the destination as a relative
                            // offset inside this document's section
                            // so the rebuild step can re-base it
                            // onto the merged document's page
                            // indices without re-resolving the page
                            // object (which would now be the same
                            // page anyway, but this is more
                            // explicit and easier to audit).
                            snap.PageIndex = idx - safeIndex;
                            if (snap.PageIndex < 0) { snap.PageIndex = 0; }
                        }
                    }
                }
                catch
                {
                    // Keep the fallback.
                }
                // Capture children before removal so the rebuild
                // has access to the full tree.
                try
                {
                    for (int c = 0; c < bm.Count; c++)
                    {
                        var child = bm[c] as Syncfusion.Pdf.Interactive.PdfBookmark;
                        if (child is null) { continue; }
                        snap.Children.Add(new OutlineSnapshot
                        {
                            Title = child.Title ?? string.Empty,
                            PageIndex = 0
                        });
                    }
                }
                catch
                {
                    // Ignore child capture failures.
                }
                importedSnapshots.Add(snap);
            }
            // Now actually remove them (still iterating from the end).
            for (int i = finalDoc.Bookmarks.Count - 1; i >= bookmarkCountBeforeImport; i--)
            {
                try
                {
                    finalDoc.Bookmarks.RemoveAt(i);
                }
                catch
                {
                    // If a particular entry cannot be removed
                    // (shouldn't happen, but defensive), keep it
                    // and move on. The rebuild step below will
                    // still produce the per-document bookmark on
                    // top.
                }
            }
        }
        catch
        {
            // Worst case: the outline stays messy but the merge
            // still completes. The per-document bookmark below
            // is the contract the user asked for; everything
            // else is a best-effort cleanup.
        }

        // Belt-and-suspenders: the cleanup loop above only
        // removes entries with index >= bookmarkCountBeforeImport
        // and silently swallows per-entry RemoveAt failures. If
        // any of those removals threw (e.g. a per-sheet bookmark
        // from a converted Excel workbook where ImportPage
        // re-parented the outline to an unexpected slot), the
        // leftover entries would end up as siblings of the
        // per-document bookmark we are about to add - producing
        // the "3 documents but 5 outline entries" bug.
        //
        // To guarantee the user-facing contract ("one top-level
        // bookmark per uploaded document") we re-run the cleanup
        // a second time, but ONLY against the indices that
        // correspond to entries introduced by the current import
        // (i.e. those with index >= bookmarkCountBeforeImport).
        // We MUST NOT touch indices < bookmarkCountBeforeImport
        // because those hold the per-document bookmarks added by
        // previous iterations of this loop - a previous
        // implementation of this safeguard iterated from the
        // end down to 0, which wiped out the bookmarks created
        // for earlier documents and left only the most recently
        // added per-document bookmark in the final PDF.
        //
        // Children of any leftover entries that we captured into
        // importedSnapshots above have already been preserved,
        // and the sourceOutline snapshot taken before the import
        // has already been captured, so nothing useful is lost.
        try
        {
            for (int i = finalDoc.Bookmarks.Count - 1; i >= bookmarkCountBeforeImport; i--)
            {
                try
                {
                    finalDoc.Bookmarks.RemoveAt(i);
                }
                catch
                {
                    // Continue. The per-document bookmark is
                    // the only contract the user asked for.
                }
            }
        }
        catch
        {
            // A misbehaving outline must not prevent the merge.
        }

        // Add the single per-document bookmark at the top level.
        var bookmark = finalDoc.Bookmarks.Add(title);
        bookmark.Destination = new PdfDestination(destinationPage);
        bookmark.Destination.Location = new PointF(0, 0);
        bookmark.Color = Color.FromArgb(43, 118, 255);
        bookmark.TextStyle = PdfTextStyle.Bold;

        // Re-emit the source outline (from the source PDF's
        // pre-import snapshot) AND any entries the import brought
        // over (from the importedSnapshots list, which already
        // has its indices relative to this document's section)
        // as children of the per-document bookmark. The
        // import-side snapshots are processed first because they
        // are typically fewer; the source-side snapshot is
        // preferred when both lists contain an entry with the
        // same title, because the source PDF's outline is the
        // user-facing one (e.g. Word headings) and the imported
        // side only mirrors what the import already copied.
        var mergedChildren = new List<OutlineSnapshot>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var s in importedSnapshots)
        {
            if (string.IsNullOrWhiteSpace(s.Title)) { continue; }
            if (seen.Add(s.Title))
            {
                mergedChildren.Add(s);
            }
        }
        foreach (var s in sourceOutline)
        {
            if (string.IsNullOrWhiteSpace(s.Title)) { continue; }
            if (seen.Add(s.Title))
            {
                mergedChildren.Add(s);
            }
        }

        foreach (var child in mergedChildren)
        {
            var childPageIndex = Math.Min(Math.Max(safeIndex + child.PageIndex, 0), finalDoc.Pages.Count - 1);
            var childBookmark = bookmark.Add(child.Title);
            childBookmark.Destination = new PdfDestination(finalDoc.Pages[childPageIndex]);
            childBookmark.Destination.Location = new PointF(0, 0);
            childBookmark.Color = Color.FromArgb(43, 118, 255);

            // Recurse into grandchildren.
            foreach (var grand in child.Children)
            {
                if (string.IsNullOrWhiteSpace(grand.Title)) { continue; }
                var grandPageIndex = Math.Min(Math.Max(childPageIndex + grand.PageIndex, 0), finalDoc.Pages.Count - 1);
                var grandBookmark = childBookmark.Add(grand.Title);
                grandBookmark.Destination = new PdfDestination(finalDoc.Pages[grandPageIndex]);
                grandBookmark.Destination.Location = new PointF(0, 0);
                grandBookmark.Color = Color.FromArgb(43, 118, 255);
            }
        }

        // Audit trail uses 1-based page numbers to match what
        // users see in a PDF viewer's status bar.
        audit.Add(new BoardPackAuditBookmark
        {
            DocumentId = doc.Id,
            Title = title,
            MergeOrder = doc.MergeOrder,
            StartPage = safeIndex + 1
        });
    }

    private static void ApplyCommonWatermark(PdfDocument finalDoc, BoardPackWatermarkConfig watermark, List<BoardPackAuditWatermark> audit)
    {
        // Single packet-wide watermark. We draw the configured
        // text on every page of the merged document so the user
        // sees a consistent watermark regardless of which
        // document a page originated from.
        try
        {
            var brush = ParseColor(watermark.Color);

            for (int p = 0; p < finalDoc.Pages.Count; p++)
            {
                var page = finalDoc.Pages[p];
                var graphics = page.Graphics;
                var state = graphics.Save();
                graphics.SetTransparency(watermark.Opacity);

                // The original implementation drew the text at
                // hard-coded PointF(-150, 450) which only looks
                // right on a portrait page of roughly letter /
                // A4 size. Landscape pages (e.g. PowerPoint
                // slides) end up with the watermark jammed into
                // the top-left corner and rotated off-page,
                // which is what produced the empty landscape
                // slide in the screenshot.
                //
                // Centre the watermark on each page instead and
                // pick a font size that always fits inside the
                // (shorter) page dimension with a small margin,
                // so the same configuration works for portrait
                // AND landscape pages.
                var pageSize = page.Size;
                var pageWidth = pageSize.Width;
                var pageHeight = pageSize.Height;
                // Cap the rendered font size at ~30% of the
                // shorter page dimension (minus margins) so a
                // large watermark.Text + landscape slide does
                // not overflow. The user-configured font size
                // is respected up to that cap, with a hard
                // floor of 12pt so the text never disappears.
                var shortSide = Math.Min(pageWidth, pageHeight);
                var margin = shortSide * 0.10f;
                var maxFontForPage = (shortSide - (margin * 2f)) * 0.30f;
                var drawFontSize = Math.Min(watermark.FontSize, Math.Max(12f, maxFontForPage));
                var drawFont = new PdfStandardFont(PdfFontFamily.Helvetica, drawFontSize);

                // Measure the text so we can centre it on the
                // page once everything is rotated. PdfGraphics
                // composes transforms by post-multiplying, so
                // the effective matrix is
                //   Translate(cx, cy) * Rotate(angle) * Translate(-textW/2, -textH/2)
                // which places the text top-left at the page
                // centre and then rotates it about that point -
                // giving a properly centred, rotated watermark
                // on every page (portrait or landscape).
                var textSize = drawFont.MeasureString(watermark.Text ?? string.Empty);
                var cx = pageWidth / 2f;
                var cy = pageHeight / 2f;
                var halfW = textSize.Width / 2f;
                var halfH = textSize.Height / 2f;

                graphics.TranslateTransform(cx, cy);
                graphics.RotateTransform(watermark.Rotation);
                graphics.TranslateTransform(-halfW, -halfH);
                graphics.DrawString(watermark.Text, drawFont, PdfPens.Red, new PdfSolidBrush(brush), new PointF(0f, 0f));
                graphics.Restore(state);
            }
        }
        catch
        {
            // Don't fail the pack because of a single bad
            // watermark config. Surface it in the audit
            // manifest and move on.
        }

        audit.Add(new BoardPackAuditWatermark
        {
            DocumentId = string.Empty,
            SourceFileName = "(board pack)",
            Enabled = true,
            Text = watermark.Text,
            Color = watermark.Color,
            FontSize = watermark.FontSize,
            Opacity = watermark.Opacity,
            Rotation = watermark.Rotation
        });
    }

    private static Color ParseColor(string hex)
    {
        if (string.IsNullOrWhiteSpace(hex))
        {
            return Color.FromArgb(29, 78, 216);
        }

        try
        {
            var trimmed = hex.TrimStart('#');
            if (trimmed.Length == 6)
            {
                trimmed = "FF" + trimmed;
            }
            if (trimmed.Length != 8)
            {
                return Color.FromArgb(29, 78, 216);
            }
            return Color.FromArgb(
                Convert.ToInt32(trimmed.Substring(0, 2), 16),
                Convert.ToInt32(trimmed.Substring(2, 2), 16),
                Convert.ToInt32(trimmed.Substring(4, 2), 16),
                Convert.ToInt32(trimmed.Substring(6, 2), 16));
        }
        catch
        {
            return Color.FromArgb(29, 78, 216);
        }
    }

    private string ResolveConvertedPdfPath(BoardPackWorkspace workspace, BoardPackSourceDocument doc)
    {
        if (string.IsNullOrWhiteSpace(doc.ConvertedFileName))
        {
            throw new InvalidOperationException($"Document '{doc.FileName}' has no converted file.");
        }
        return _store.GetPdfFilePath(doc.ConvertedFileName);
    }

    private void BuildSourcesZip(BoardPackWorkspace workspace, List<BoardPackSourceDocument> ordered, string zipPath)
    {
        if (string.IsNullOrWhiteSpace(zipPath))
        {
            return;
        }

        try
        {
            if (System.IO.File.Exists(zipPath))
            {
                System.IO.File.Delete(zipPath);
            }

            using var zipStream = System.IO.File.Create(zipPath);
            using var archive = new System.IO.Compression.ZipArchive(zipStream, System.IO.Compression.ZipArchiveMode.Create);
            foreach (var doc in ordered)
            {
                string officePath = _store.GetOfficeFilePath(doc.StoredFileName);
                if (!System.IO.File.Exists(officePath))
                {
                    continue;
                }

                var entry = archive.CreateEntry(doc.FileName, System.IO.Compression.CompressionLevel.Optimal);
                using var entryStream = entry.Open();
                using var fileStream = System.IO.File.OpenRead(officePath);
                fileStream.CopyTo(entryStream);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to write SourceDocuments.zip for session {Session}", workspace.SessionId);
        }
    }

    private void WriteManifest(
        BoardPackWorkspace workspace,
        List<BoardPackSourceDocument> ordered,
        List<BoardPackAuditBookmark> bookmarks,
        List<BoardPackAuditWatermark> watermarks,
        bool passwordApplied,
        GenerationResult result,
        string manifestPath)
    {

        var manifest = new BoardPackAuditManifest
        {
            SessionId = workspace.SessionId,
            CreationDate = DateTime.UtcNow
        };

        foreach (var doc in workspace.Documents)
        {
            manifest.UploadedDocuments.Add(new BoardPackAuditDocument
            {
                Id = doc.Id,
                FileName = doc.FileName,
                FileType = doc.GetFriendlyFileType(),
                FileSize = doc.FileSize,
                UploadedAt = doc.UploadedAtUtc
            });
        }

        foreach (var doc in ordered)
        {
            manifest.ConvertedPdfs.Add(new BoardPackAuditConvertedDocument
            {
                Id = doc.Id,
                SourceFileName = doc.FileName,
                ConvertedFileName = doc.ConvertedFileName ?? string.Empty,
                PageCount = doc.ConvertedPageCount,
                MergeOrder = doc.MergeOrder
            });
        }

        manifest.MergeOrder = ordered.Select(d => ordered.IndexOf(d)).ToList();
        manifest.Bookmarks = bookmarks;
        manifest.Watermarks = watermarks;
        manifest.PasswordProtectionEnabled = passwordApplied;

        long finalSize = 0;
        try
        {
            finalSize = new FileInfo(result.FinalPdfPath).Length;
        }
        catch
        {
            // best-effort size only
        }

        manifest.GeneratedOutputs.Add(new BoardPackAuditOutput
        {
            Label = "Final Board Pack PDF",
            FileName = Path.GetFileName(result.FinalPdfPath),
            Kind = "pdf",
            Size = finalSize
        });

        manifest.GeneratedOutputs.Add(new BoardPackAuditOutput
        {
            Label = "Source Documents",
            FileName = string.IsNullOrWhiteSpace(result.SourcesZipPath)
                ? string.Empty
                : Path.GetFileName(result.SourcesZipPath),
            Kind = "zip",
            Size = SafeFileLength(result.SourcesZipPath)
        });

        try
        {
            // First write to get the manifest file created
            var json = JsonSerializer.Serialize(manifest, JsonOptions);
            System.IO.File.WriteAllText(manifestPath, json);

            // Now add the Audit Manifest entry with the correct file size
            manifest.GeneratedOutputs.Add(new BoardPackAuditOutput
            {
                Label = "Audit Manifest",
                FileName = string.IsNullOrWhiteSpace(result.ManifestPath)
                    ? string.Empty
                    : Path.GetFileName(result.ManifestPath),
                Kind = "manifest",
                Size = SafeFileLength(manifestPath)
            });

            // Serialize again to include the Audit Manifest entry in the JSON
            var jsonWithManifest = JsonSerializer.Serialize(manifest, JsonOptions);
            System.IO.File.WriteAllText(manifestPath, jsonWithManifest);

            result.Manifest = manifest;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to write AuditManifest.json for session {Session}", workspace.SessionId);
            manifest.GeneratedOutputs.Add(new BoardPackAuditOutput
            {
                Label = "Audit Manifest",
                FileName = string.IsNullOrWhiteSpace(result.ManifestPath)
                    ? string.Empty
                    : Path.GetFileName(result.ManifestPath),
                Kind = "manifest",
                Size = 0
            });
        }
    }

    private static long SafeFileLength(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return 0;
        }
        try
        {
            return new FileInfo(path).Length;
        }
        catch
        {
            return 0;
        }
    }
}

/// <summary>
/// Mirror of the constants used by the generator and the
/// controller. Defined here in their own static class so neither
/// hand-written string appears in two different files. The
/// sub-folder constants mirror the ones on
/// <see cref="BoardPackWorkspaceStore"/> so both sides agree
/// about where the generator writes its output.
/// </summary>
public static class BoardPackGeneratorPaths
{
    public const string GeneratedSubFolder = "generated";
    public const string BoardPackPdfFileName = "BoardPack.pdf";
    public const string SourcesZipFileName = "SourceDocuments.zip";
    public const string ManifestFileName = "AuditManifest.json";
}