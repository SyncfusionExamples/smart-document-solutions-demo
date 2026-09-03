namespace Syncfusion.SmartDemo.Models;

public class ReviewFieldInfo
{
    public string Field { get; set; } = string.Empty;

    public string Value { get; set; } = string.Empty;

    public decimal Confidence { get; set; }

    public string ConfidenceSource { get; set; } = string.Empty;

    public int PageNumber { get; set; }

    public float Left { get; set; }

    public float Top { get; set; }

    public float Width { get; set; }

    public float Height { get; set; }

    public bool IsTable { get; set; }

    // True when this row was created from extracted text that did not
    // contain a "Field : Value" colon separator. For these rows the
    // Review page collapses the Field column so the user sees only
    // "Extracted value · Confidence · Edit" - matching the columns
    // the user asked for. Without this flag the row would have been
    // silently dropped (TryParseColonSeparatedText returning false
    // short-circuited the registration) and the value would never
    // reach the Review UI.
    public bool IsUnpairedText { get; set; }

    public bool IsLowConfidence => Confidence < 0.75m;

    public bool HasBounds => Width > 0 && Height > 0;

    // Marks the row as containing sensitive PII (ID, phone,
    // address, money, etc.). The Redact page only surfaces
    // sensitive rows so the user cannot accidentally mask a
    // non-PII value such as "Loss Type: Water - burst supply
    // line". The value is computed at extraction time by the
    // controller's SensitiveFieldClassifier helper and
    // persisted in session along with the row itself.
    public bool IsSensitive { get; set; }
}