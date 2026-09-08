using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Syncfusion.SmartDocumentSolutions.Models.BoardPack;

/// <summary>
/// JSON-serialisable audit manifest for the final Board Pack.
/// Mirrors the deliverables the request asks for (SessionId,
/// CreatedAt, uploaded documents, converted PDFs, merge order,
/// bookmarks, watermarks, password protection status, generated
/// outputs).
/// </summary>
public class BoardPackAuditManifest
{
    public string SessionId { get; set; } = string.Empty;

    public DateTime CreationDate { get; set; } = DateTime.UtcNow;

    public List<BoardPackAuditDocument> UploadedDocuments { get; set; } = new();

    public List<BoardPackAuditConvertedDocument> ConvertedPdfs { get; set; } = new();

    public List<int> MergeOrder { get; set; } = new();

    public List<BoardPackAuditBookmark> Bookmarks { get; set; } = new();

    public List<BoardPackAuditWatermark> Watermarks { get; set; } = new();

    public bool PasswordProtectionEnabled { get; set; }

    public List<BoardPackAuditOutput> GeneratedOutputs { get; set; } = new();
}

public class BoardPackAuditDocument
{
    public string Id { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    public string FileType { get; set; } = string.Empty;
    public long FileSize { get; set; }
    public DateTime UploadedAt { get; set; }
}

public class BoardPackAuditConvertedDocument
{
    public string Id { get; set; } = string.Empty;
    public string SourceFileName { get; set; } = string.Empty;
    public string ConvertedFileName { get; set; } = string.Empty;
    public int PageCount { get; set; }
    public int MergeOrder { get; set; }
}

public class BoardPackAuditBookmark
{
    public string DocumentId { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public int MergeOrder { get; set; }
    public int StartPage { get; set; }
}

public class BoardPackAuditWatermark
{
    public string DocumentId { get; set; } = string.Empty;
    public string SourceFileName { get; set; } = string.Empty;
    public bool Enabled { get; set; }
    public string Text { get; set; } = string.Empty;
    public string Color { get; set; } = string.Empty;
    public float FontSize { get; set; }
    public float Opacity { get; set; }
    public float Rotation { get; set; }
}

public class BoardPackAuditOutput
{
    public string Label { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    // Serialise as "Type" in the audit manifest JSON so the
    // published manifest uses the same field name every reader
    // expects (was previously "Kind" which was confusing next
    // to fields like FileName, FileType, etc). The C# property
    // name stays `Kind` so existing call sites in
    // BoardPackGenerator (`Kind = "pdf"`, `Kind = "zip"`) keep
    // compiling without changes.
    [JsonPropertyName("Type")]
    public string Kind { get; set; } = string.Empty;
    public long Size { get; set; }
}