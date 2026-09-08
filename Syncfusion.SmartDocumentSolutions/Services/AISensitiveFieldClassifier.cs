using OpenAI.Chat;
using System.Text.Json;

namespace Syncfusion.SmartDocumentSolutions.Services;

// Asks Azure OpenAI whether each (field, value) pair is sensitive.
// One prompt per batch; falls back to non-sensitive on any AI error.
public sealed class AISensitiveFieldClassifier
{
    //private readonly AzureOpenAIClientFactory _clientFactory;
    private readonly OpenAIClientFactory _clientFactory;
    private readonly ILogger<AISensitiveFieldClassifier> _logger;

    private const string SystemPromptText = """
        You are a privacy reviewer for an insurance claim intake system.
        For each row you receive, decide whether the value contains
        Personally Identifiable Information (PII) or other sensitive data
        that must be redacted before the document is shared outside the
        organisation.

        Treat a row as sensitive when the value, taken together with the
        field name, reveals any of:
          - government identifiers (SSN, EIN, passport, driver's license,
            national ID, tax ID);
          - contact information (phone, fax, email, mailing or residence
            address, including partial addresses that include a street
            number/name or a ZIP/postal code combined with a city);
          - financial identifiers (bank account, routing, IBAN, SWIFT,
            credit or debit card number, CVV/CVC, PIN);
          - insurance identifiers (policy number, claim number, claimant
            ID, insured ID, policyholder ID, beneficiary ID);
          - personal demographics (date of birth, age, gender, sex, race,
            ethnicity, marital status);
          - financial amounts that could be considered private (salary,
            income, wages, net worth, settlement, payout, premium,
            deductible, coverage limit) - but NOT generic invoice line
            items like "Loss Type: Water - burst supply line" or
            "Damage Description: kitchen ceiling water damage";
          - medical information (diagnosis, treatment, prescription,
            provider, patient ID, injury description, hospital name).

        Treat a row as NOT sensitive when the value is a generic claim
        descriptor, loss description, repair description, location name
        without an address, vehicle make/model/year without a VIN or
        plate, or any other business-operational field that does not
        identify a specific person.

        You will be given a JSON array. Each element has a 1-based
        "id", a "field" label (may be empty), and a "value". Reply
        with a JSON object of the form
        {"verdicts":[{"id":1,"sensitive":true},{"id":2,"sensitive":false},...]}
        in the SAME order, with no commentary, no markdown fences, and
        no extra text.
        """;
    //public AISensitiveFieldClassifier(AzureOpenAIClientFactory clientFactory, ILogger<AISensitiveFieldClassifier> logger)
    //{
    //    _clientFactory = clientFactory;
    //    _logger = logger;
    //}
    public AISensitiveFieldClassifier(OpenAIClientFactory clientFactory, ILogger<AISensitiveFieldClassifier> logger)
    {
        _clientFactory = clientFactory;
        _logger = logger;
    }

    public async Task<bool> IsSensitiveAsync(string? field, string? value, CancellationToken cancellationToken = default)
    {
        var items = new (string Field, string Value)[] { (field ?? string.Empty, value ?? string.Empty) };
        var verdicts = await ClassifyAsync(items, cancellationToken).ConfigureAwait(false);
        return verdicts.Count > 0 && verdicts[0];
    }

    public async Task<IReadOnlyList<bool>> ClassifyAsync(
        IReadOnlyList<(string Field, string Value)> items,
        CancellationToken cancellationToken = default)
    {
        if (items is null || items.Count == 0)
        {
            return Array.Empty<bool>();
        }

        var verdicts = new bool[items.Count];
        var needsAi = new List<int>();
        for (var i = 0; i < items.Count; i++)
        {
            if (string.IsNullOrWhiteSpace(items[i].Value))
            {
                verdicts[i] = false;
            }
            else
            {
                needsAi.Add(i);
            }
        }

        if (needsAi.Count == 0)
        {
            return verdicts;
        }

        try
        {
            var responsePayload = await SendBatchAsync(items, needsAi, cancellationToken).ConfigureAwait(false);
            for (var i = 0; i < needsAi.Count; i++)
            {
                verdicts[needsAi[i]] = responsePayload[i];
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "AI sensitive-data classifier failed; defaulting remaining {Count} rows to non-sensitive.", needsAi.Count);
        }

        return verdicts;
    }

    private async Task<IReadOnlyList<bool>> SendBatchAsync(
        IReadOnlyList<(string Field, string Value)> items,
        IReadOnlyList<int> indices,
        CancellationToken cancellationToken)
    {
        var payload = new List<object>(indices.Count);
        for (var i = 0; i < indices.Count; i++)
        {
            var (field, value) = items[indices[i]];
            payload.Add(new
            {
                id = i + 1, // 1-based, matching the system prompt contract
                field = field ?? string.Empty,
                value = value ?? string.Empty,
            });
        }

        var messages = new List<ChatMessage>
        {
            new SystemChatMessage(SystemPromptText),
            new UserChatMessage(JsonSerializer.Serialize(payload)),
        };

        var completion = await _clientFactory.ChatClient
            .CompleteChatAsync(messages, cancellationToken: cancellationToken)
            .ConfigureAwait(false);

        var raw = completion.Value.Content.Count > 0
            ? completion.Value.Content[0].Text
            : null;

        if (string.IsNullOrWhiteSpace(raw))
        {
            _logger.LogWarning("AI sensitive-data classifier returned empty content; defaulting to non-sensitive.");
            return new bool[indices.Count];
        }

        return ParseVerdicts(raw, indices.Count);
    }

    private static IReadOnlyList<bool> ParseVerdicts(string raw, int expectedCount)
    {
        // Strip markdown fences if the model wrapped the JSON despite the prompt.
        var trimmed = raw.Trim();
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

        using var doc = JsonDocument.Parse(trimmed);
        var verdicts = new bool[expectedCount];

        if (!doc.RootElement.TryGetProperty("verdicts", out var verdictsElement) ||
            verdictsElement.ValueKind != JsonValueKind.Array)
        {
            return verdicts;
        }

        foreach (var entry in verdictsElement.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            if (!entry.TryGetProperty("id", out var idElement) || idElement.ValueKind != JsonValueKind.Number)
            {
                continue;
            }

            if (!idElement.TryGetInt32(out var id) || id < 1 || id > expectedCount)
            {
                continue;
            }

            var sensitive = false;
            if (entry.TryGetProperty("sensitive", out var sensitiveElement) &&
                sensitiveElement.ValueKind is JsonValueKind.True or JsonValueKind.False)
            {
                sensitive = sensitiveElement.GetBoolean();
            }

            verdicts[id - 1] = sensitive;
        }

        return verdicts;
    }
}
