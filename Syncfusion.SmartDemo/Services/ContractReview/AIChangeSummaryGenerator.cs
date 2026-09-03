using OpenAI.Chat;
using System.Text.Json;

namespace Syncfusion.SmartDemo.Services.ContractReview;

/// <summary>
/// AI agent that turns the per-action change log captured in the
/// Contract Review "Compare" step (Accept / Reject events, each
/// with the live SFDT content snapshot, author and action type)
/// into a concise HTML summary the workflow can hand to a Word
/// document.
///
/// Mirrors the structure of <see cref="AISensitiveFieldClassifier"/>:
///   * Injects a focused system prompt explaining the contract
///     review use case.
///   * Serialises the change log to a compact JSON array the model
///     can reason about.
///   * Bounds the request with a low max-output-tokens and
///     temperature 0 for deterministic JSON-shape output.
///   * Returns a single <c>summaryHtml</c> string (paragraphs +
///     bullet list) which the controller hands to
///     <see cref="HtmlToDocxConverter"/>.
///
/// The contract the model must honour: reply with a JSON object
/// of the shape
///   {"summaryHtml": "&lt;p&gt;...&lt;/p&gt;&lt;ul&gt;...&lt;/ul&gt;"}
/// and nothing else. Wrapping in markdown fences is tolerated by
/// the parser but the model is told up front not to wrap.
/// </summary>
public sealed class AIChangeSummaryGenerator
{
    private readonly OpenAIClientFactory _clientFactory;
    private readonly ILogger<AIChangeSummaryGenerator> _logger;

    private const string SystemPromptText = """
        You are a contract review summarisation assistant.
        You will be given a JSON array of "change" objects captured
        during the review of two versions of the same legal contract.
        Each change has:
          - id: 1-based index
          - action: "Accept" or "Reject" (the user's verdict on a
            tracked change)
          - author: the person who issued the change (typically
            "Counterparty")
          - at: ISO 8601 timestamp
          - content: the full document snapshot (SFDT JSON) at
            the moment the user accepted/rejected this change.
            IMPORTANT: Extract meaningful information from this SFDT
            by parsing the sections, paragraphs, and text to identify
            what clauses, values, or terms were changed. Look for:
            * Dates, amounts, percentages, or numeric values
            * Clause titles or section headings
            * Party names or entity references
            * Key terms or obligations
            Use the SFDT to derive the actual change, not just the detail field.
          - detail: optional short snippet the user had selected
            at the time (may be empty)

        CRITICAL REQUIREMENTS:
        1. EXTRACT MEANING FROM SFDT: Parse the content field's SFDT JSON to identify
           what changed in the contract (e.g., "January 1, 2026", "$1,000,000", "Liability Cap")
        2. List EVERY change exactly as it appears in the input array
        3. Do NOT omit any changes
        4. If detail is empty BUT content exists, extract key information from the SFDT
           Example: If SFDT shows "Effective Date" section with "January 15, 2026", show that
        5. Use EXACT header format shown in the output structure below
        6. Organize strictly by ACCEPTED and REJECTED sections
        7. Number each change with its ID

        Output structure:
        - Open with the review header using this EXACT format:
          <p><strong>Total Changes: [count] | Accepted Changes: [count] | Rejected Changes: [count]</strong></p>
        - Do NOT include emojis, special symbols, or decorative characters anywhere in the output
        - Then add a brief summary paragraph about the overall outcome
        - Create separate <h3> sections for "ACCEPTED CHANGES" and "REJECTED CHANGES"
        - Under each <h3>, create a <ul> list with one <li> per change
        - Each <li> must include: [#ID] [Action] by [Author] - [Extracted Meaning]
          Example: <li>#1 <strong>Accept</strong> by Counterparty - Effective Date: January 15, 2026</li>
          Example: <li>#3 <strong>Reject</strong> by Counterparty - Liability Cap: $1,000,000</li>
        - If you cannot extract meaning from SFDT, use: "Change reviewed and [accepted/rejected]"
        - Close with a <p> noting any patterns, concerns, or next steps

        Use semantic tags only: <p>, <ul>, <li>, <strong>, <em>, <h3>.
        Do NOT use <html>, <body>, <head>, <script>, <style>, tables, 
        images, inline styles, class attributes, or nested divs.

        Reply with a single JSON object of the form:
          {"summaryHtml":"<p>...</p><h3>...</h3><ul><li>...</li></ul><p>...</p>"}
        and nothing else - no markdown fences, no commentary, no preamble.
        """;

    public AIChangeSummaryGenerator(OpenAIClientFactory clientFactory, ILogger<AIChangeSummaryGenerator> logger)
    {
        _clientFactory = clientFactory;
        _logger = logger;
    }

    /// <summary>
    /// Generate the AI summary. Each <paramref name="entry"/>
    /// shape matches what the Compare view pushes into
    /// <c>state.changeLog</c> via
    /// <c>contractReview.js -> pushChangeLog</c>: a content
    /// snapshot (SFDT JSON), author, action type and timestamp.
    /// </summary>
    public async Task<string> GenerateSummaryHtmlAsync(
        IReadOnlyList<ChangeLogEntry> entries,
        CancellationToken cancellationToken = default)
    {
        if (entries is null || entries.Count == 0)
        {
            return BuildEmptySummary();
        }

        try
        {
            return await SendRequestAsync(entries, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "AI change summary generator failed; falling back to a stub summary.");
            return BuildFallbackSummary(entries);
        }
    }

    private async Task<string> SendRequestAsync(
        IReadOnlyList<ChangeLogEntry> entries,
        CancellationToken cancellationToken)
    {
        // Build the payload. We deliberately drop the
        // SFDT "content" from the user-visible prompt and
        // keep it inside a separate field so the model can
        // use it as context but we don't bloat the token
        // count. The system prompt already explains how to
        // read the field.
        var payload = new List<object>(entries.Count);
        for (var i = 0; i < entries.Count; i++)
        {
            var entry = entries[i];
            payload.Add(new
            {
                id = i + 1,
                action = entry.Action ?? "Unknown",
                author = entry.Author ?? "Unknown",
                at = entry.At > 0
                    ? DateTimeOffset.FromUnixTimeMilliseconds(entry.At).ToString("o")
                    : string.Empty,
                detail = entry.Detail ?? string.Empty,
                content = entry.ContentSfdt ?? string.Empty
            });
        }

        var messages = new List<ChatMessage>
        {
            new SystemChatMessage(SystemPromptText),
            new UserChatMessage(JsonSerializer.Serialize(payload))
        };

        var completion = await _clientFactory.ChatClient
            .CompleteChatAsync(messages, cancellationToken: cancellationToken)
            .ConfigureAwait(false);

        var raw = completion.Value.Content.Count > 0
            ? completion.Value.Content[0].Text
            : null;

        if (string.IsNullOrWhiteSpace(raw))
        {
            _logger.LogWarning("AI change summary generator returned empty content; falling back.");
            return BuildFallbackSummary(entries);
        }

        return ParseSummaryHtml(raw) ?? BuildFallbackSummary(entries);
    }

    private static string? ParseSummaryHtml(string raw)
    {
        var trimmed = raw.Trim();
        // Tolerate markdown fences even though the prompt
        // forbids them - the model occasionally wraps
        // anyway, and the cost of stripping them is one
        // string op.
        if (trimmed.StartsWith("```", StringComparison.Ordinal))
        {
            var firstNewline = trimmed.IndexOf('\n');
            if (firstNewline > 0)
            {
                trimmed = trimmed[(firstNewline + 1)..];
            }
            if (trimmed.EndsWith("```", StringComparison.Ordinal))
            {
                trimmed = trimmed[..^3].TrimEnd();
            }
        }

        try
        {
            using var doc = JsonDocument.Parse(trimmed);
            if (!doc.RootElement.TryGetProperty("summaryHtml", out var summaryElement) ||
                summaryElement.ValueKind != JsonValueKind.String)
            {
                return null;
            }
            return summaryElement.GetString();
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string BuildEmptySummary()
    {
        return "<p>No accepted or rejected changes were recorded for this contract review.</p>";
    }

    private static string BuildFallbackSummary(IReadOnlyList<ChangeLogEntry> entries)
    {
        // The model failed (rate limit, transient outage, or
        // a JSON parse miss on its reply). Produce a
        // deterministic list grouped by action so the
        // user still gets a usable summary. Format matches
        // the AI-generated output structure.
        var accepts = 0;
        var rejects = 0;
        for (var i = 0; i < entries.Count; i++)
        {
            var action = (entries[i].Action ?? string.Empty).ToLowerInvariant();
            if (action.StartsWith("accept", StringComparison.Ordinal)) { accepts++; }
            else if (action.StartsWith("reject", StringComparison.Ordinal)) { rejects++; }
        }

        var html = new System.Text.StringBuilder();

        // Header with exact format: Total Changes: X | Accepted: X | Rejected: X
        html.Append($"<p><strong>Total Changes: {entries.Count} | Accepted Changes: {accepts} | Rejected Changes: {rejects}</strong></p>");
        html.Append($"<p>This contract review resulted in {accepts} accepted change{(accepts != 1 ? "s" : "")} and {rejects} rejected change{(rejects != 1 ? "s" : "")}. "
            + "A detailed breakdown of each change is shown below. The AI summary is unavailable right now.</p>");

        // ACCEPTED CHANGES section
        var acceptedItems = new List<string>();
        for (var i = 0; i < entries.Count; i++)
        {
            var entry = entries[i];
            var action = (entry.Action ?? string.Empty).ToLowerInvariant();
            if (action.StartsWith("accept", StringComparison.Ordinal))
            {
                var detail = ExtractChangeDetail(entry);
                acceptedItems.Add($"<li>#{i + 1} <strong>Accept</strong> by {System.Net.WebUtility.HtmlEncode(entry.Author ?? "Unknown")} - {System.Net.WebUtility.HtmlEncode(detail)}</li>");
            }
        }
        if (acceptedItems.Count > 0)
        {
            html.Append("<h3>ACCEPTED CHANGES</h3>");
            html.Append("<ul>");
            foreach (var item in acceptedItems)
            {
                html.Append(item);
            }
            html.Append("</ul>");
        }

        // REJECTED CHANGES section
        var rejectedItems = new List<string>();
        for (var i = 0; i < entries.Count; i++)
        {
            var entry = entries[i];
            var action = (entry.Action ?? string.Empty).ToLowerInvariant();
            if (action.StartsWith("reject", StringComparison.Ordinal))
            {
                var detail = ExtractChangeDetail(entry);
                rejectedItems.Add($"<li>#{i + 1} <strong>Reject</strong> by {System.Net.WebUtility.HtmlEncode(entry.Author ?? "Unknown")} - {System.Net.WebUtility.HtmlEncode(detail)}</li>");
            }
        }
        if (rejectedItems.Count > 0)
        {
            html.Append("<h3>REJECTED CHANGES</h3>");
            html.Append("<ul>");
            foreach (var item in rejectedItems)
            {
                html.Append(item);
            }
            html.Append("</ul>");
        }

        html.Append("<p>Review the above changes carefully to ensure alignment with your contract objectives.</p>");
        return html.ToString();
    }

    private static string ExtractChangeDetail(ChangeLogEntry entry)
    {
        // Try to extract meaningful detail from the entry.
        // First, use the detail field if available
        if (!string.IsNullOrWhiteSpace(entry.Detail))
        {
            return entry.Detail.Trim();
        }

        // If detail is empty, try to extract from SFDT content
        if (!string.IsNullOrWhiteSpace(entry.ContentSfdt))
        {
            try
            {
                // Try to extract text content from SFDT JSON
                var extracted = ExtractTextFromSfdt(entry.ContentSfdt);
                if (!string.IsNullOrWhiteSpace(extracted))
                {
                    return extracted;
                }
            }
            catch
            {
                // If extraction fails, continue to default
            }
        }

        // Default fallback
        return "Change reviewed";
    }

    private static string ExtractTextFromSfdt(string sfdt)
    {
        try
        {
            // Simple heuristic: look for common text patterns in SFDT
            // SFDT contains sections with text content; try to extract first meaningful text
            using var doc = System.Text.Json.JsonDocument.Parse(sfdt);
            var root = doc.RootElement;
            
            // Try to get sections or blocks that contain text
            if (root.TryGetProperty("sections", out var sections) && sections.ValueKind == System.Text.Json.JsonValueKind.Array)
            {
                var enumerator = sections.EnumerateArray().GetEnumerator();
                if (enumerator.MoveNext())
                {
                    var section = enumerator.Current;
                    if (section.TryGetProperty("blocks", out var blocks) && blocks.ValueKind == System.Text.Json.JsonValueKind.Array)
                    {
                        foreach (var block in blocks.EnumerateArray())
                        {
                            if (block.TryGetProperty("inlines", out var inlines) && inlines.ValueKind == System.Text.Json.JsonValueKind.Array)
                            {
                                foreach (var inline in inlines.EnumerateArray())
                                {
                                    if (inline.TryGetProperty("text", out var textElement) && textElement.ValueKind == System.Text.Json.JsonValueKind.String)
                                    {
                                        var text = textElement.GetString();
                                        if (!string.IsNullOrWhiteSpace(text))
                                        {
                                            // Return first 80 characters of extracted text
                                            return text.Length > 80 ? text.Substring(0, 80) + "..." : text;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        catch
        {
            // If any parsing fails, just return empty string
        }

        return string.Empty;
    }
}

/// <summary>
/// One row in the in-memory change log the Compare view
/// pushes. We declare it in the same file as the AI
/// generator because the generator is the only consumer
/// and there is no reason to put a 1-class DTO into its
/// own file.
/// </summary>
public sealed class ChangeLogEntry
{
    public long At { get; set; }
    public string? Author { get; set; }
    public string? Action { get; set; }
    public string? Detail { get; set; }
    public string? ContentSfdt { get; set; }
}
