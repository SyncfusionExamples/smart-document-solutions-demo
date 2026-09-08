using System;
using System.Collections.Generic;

namespace Syncfusion.SmartDocumentSolutions.Models.BoardPack;

/// <summary>
/// In-memory + JSON-serialisable snapshot of the user's Board Pack
/// session. The controller serialises one of these into a
/// per-session file under the uploads root so it survives App
/// Service restarts exactly like the Claim Intake recovery cache.
/// </summary>
public class BoardPackWorkspace
{
    public string SessionId { get; set; } = string.Empty;

    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    public DateTime LastModifiedUtc { get; set; } = DateTime.UtcNow;

    /// <summary>The current workflow page (0 = Upload, 1 = Convert, 2 = Pack, 3 = Export).</summary>
    public string ActiveMode { get; set; } = "upload";

    public List<BoardPackSourceDocument> Documents { get; set; } = new();

    public bool PasswordProtect { get; set; } = false;

    public string Password { get; set; } = string.Empty;

    /// <summary>
    /// Single, packet-wide watermark applied to every page of the
    /// final Board Pack when the user enables it on the Pack step.
    /// The text defaults to <c>Confidential</c> and the colour is
    /// user-controlled via the same kind of colour picker the
    /// per-document watermark row used to expose. Per-document
    /// <see cref="BoardPackSourceDocument.Watermark"/> entries are
    /// preserved for backwards compatibility with snapshots that
    /// pre-date the common-watermark UI but the generator now
    /// ignores them and relies exclusively on this property.
    /// </summary>
    public BoardPackWatermarkConfig CommonWatermark { get; set; } = new()
    {
        Enabled = false,
        Text = "Confidential",
        Color = "#1d4ed8",
        FontSize = 48f,
        Opacity = 0.25f,
        Rotation = -40f
    };

    /// <summary>
    /// Final generated PDF relative to the per-session folder
    /// (e.g. <c>generated/board-pack.pdf</c>). Set when the user
    /// runs the Pack step.
    /// </summary>
    public string? BoardPackPdfFileName { get; set; }

    /// <summary>URL of the final Board Pack PDF for in-app previewing.</summary>
    public string? BoardPackPreviewUrl { get; set; }

    /// <summary>ZIP archive containing the unmodified source files.</summary>
    public string? SourcesZipFileName { get; set; }

    /// <summary>JSON manifest containing the full audit trail.</summary>
    public string? ManifestFileName { get; set; }

    /// <summary>
    /// True when the user has modified a Pack-step setting
    /// (reorder, bookmark title, watermark, password) after a
    /// successful Pack run. The Export step's "complete" tick
    /// is invalid while this flag is set - the user must run
    /// Pack again before the deliverables can be considered
    /// current. The flag is cleared on every successful
    /// <c>POST /api/board-pack/pack</c> so the next state read
    /// sees a fresh, in-sync snapshot.
    /// </summary>
    public bool PackDirty { get; set; } = false;
}