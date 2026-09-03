using System;

namespace Syncfusion.SmartDemo.Models.BoardPack;

/// <summary>
/// Represents a single Office document that has been uploaded into a
/// Board Pack session. The document can be in any of the supported
/// source formats (.docx, .xlsx, .pptx). All state for the Board
/// Pack workflow flows through a collection of these objects keyed
/// by an opaque <see cref="Id"/>.
/// </summary>
public class BoardPackSourceDocument
{
    /// <summary>
    /// Stable, opaque identifier for the document within the
    /// session. Stays the same for the entire workflow (Upload ->
    /// Convert -> Pack -> Export) so the client can refer to it
    /// across stepper transitions without reloading everything.
    /// </summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>The original name of the file as uploaded.</summary>
    public string FileName { get; set; } = string.Empty;

    /// <summary>
    /// Normalised file-type label displayed in the UI ("Word",
    /// "Excel", "PowerPoint"). Matches one of the badges used by
    /// the Claim Intake demo so the two samples share the same
    /// vocabulary.
    /// </summary>
    public string FileType { get; set; } = string.Empty;

    /// <summary>
    /// Logical Office category. Drives the choice of Syncfusion
    /// renderer (DocIO for Word, XlsIO for Excel, Presentation for
    /// PowerPoint).
    /// </summary>
    public BoardPackOfficeKind Kind { get; set; } = BoardPackOfficeKind.Word;

    /// <summary>Size of the original upload in bytes.</summary>
    public long FileSize { get; set; }

    /// <summary>UTC timestamp when the upload completed.</summary>
    public DateTime UploadedAtUtc { get; set; } = DateTime.UtcNow;

    /// <summary>Display name used as a bookmark / watermark seed.</summary>
    public string DisplayName { get; set; } = string.Empty;

    /// <summary>
    /// On-disk name of the upload. Cannot contain the original
    /// file name (we re-name to <c>DisplayName-&lt;guid&gt;.ext</c>
    /// the way ClaimIntake does today to keep the URL stable while
    /// the user drags / drops the packet).
    /// </summary>
    public string StoredFileName { get; set; } = string.Empty;

    /// <summary>
    /// Web-relative URL the front-end uses to fetch a preview of
    /// the original upload. Used by the Upload page preview
    /// button. For native Office formats the back-end does not
    /// serve an in-browser preview directly - the workspace
    /// falls back to a per-file meta card with size and kind.
    /// </summary>
    public string PreviewUrl { get; set; } = string.Empty;

    /// <summary>
    /// URL of the converted PDF for this document. Populated by
    /// the Convert step. Null until conversion succeeds.
    /// </summary>
    public string? ConvertedPreviewUrl { get; set; }

    /// <summary>On-disk name of the converted PDF.</summary>
    public string? ConvertedFileName { get; set; }

    /// <summary>Number of pages in the converted PDF.</summary>
    public int ConvertedPageCount { get; set; }

    /// <summary>Current conversion status.</summary>
    public BoardPackConversionStatus Status { get; set; } = BoardPackConversionStatus.Waiting;

    /// <summary>Optional human-readable conversion error.</summary>
    public string? ErrorMessage { get; set; }

    /// <summary>The user-controlled merge position (0-based).</summary>
    public int MergeOrder { get; set; }

    /// <summary>
    /// Per-document watermark configuration. Always present so
    /// the Pack page can iterate without null checks.
    /// </summary>
    public BoardPackWatermarkConfig Watermark { get; set; } = new();

    /// <summary>Bookmark title shown to the reader.</summary>
    public string BookmarkTitle { get; set; } = string.Empty;

    /// <summary>
    /// True when this document contributes a default bookmark
    /// pointing at its merge-section's first page. Always on by
    /// default; the user can edit the title but not disable the
    /// default mapping in the primary scenario.
    /// </summary>
    public bool AutoBookmark { get; set; } = true;

    public string GetFriendlyFileType()
    {
        if (!string.IsNullOrWhiteSpace(FileType))
        {
            return FileType;
        }

        return Kind switch
        {
            BoardPackOfficeKind.Word => "Word",
            BoardPackOfficeKind.Excel => "Excel",
            BoardPackOfficeKind.PowerPoint => "PowerPoint",
            _ => "File"
        };
    }
}

public enum BoardPackOfficeKind
{
    Word = 0,
    Excel = 1,
    PowerPoint = 2
}

/// <summary>
/// Lifecycle status of an Office document within the Board Pack
/// Convert step. Values are 1:1 with the badges the UI renders.
/// </summary>
public enum BoardPackConversionStatus
{
    Waiting = 0,
    Converting = 1,
    Converted = 2,
    Failed = 3
}