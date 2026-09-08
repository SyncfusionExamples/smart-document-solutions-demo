namespace Syncfusion.SmartDocumentSolutions.Models.BoardPack;

/// <summary>
/// Per-document watermark configuration. The Convert step leaves a
/// default for every uploaded document (enabled with a sensible
/// default text) and the Pack page lets the user edit / disable
/// each one independently.
/// </summary>
public class BoardPackWatermarkConfig
{
    public bool Enabled { get; set; } = true;

    public string Text { get; set; } = "Board Pack";

    /// <summary>Watermark text colour (RGBA). Default = brand blue.</summary>
    public string Color { get; set; } = "#1d4ed8";

    /// <summary>Font size in points before rotation.</summary>
    public float FontSize { get; set; } = 48f;

    /// <summary>Opacity 0-1. Default mirrors the watermarks.md sample (0.25).</summary>
    public float Opacity { get; set; } = 0.25f;

    /// <summary>Rotation in degrees (negative = anti-clockwise).</summary>
    public float Rotation { get; set; } = -40f;
}