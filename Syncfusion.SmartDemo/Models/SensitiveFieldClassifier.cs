using Syncfusion.SmartDemo.Services;

namespace Syncfusion.SmartDemo.Models;

// Static facade over the AI-backed classifier in Services.
internal static class SensitiveFieldClassifier
{
    public static bool IsSensitive(string? field, string? value)
    {
        var classifier = ResolveClassifier();
        if (classifier is null)
        {
            return false;
        }

        return classifier.IsSensitiveAsync(field, value).GetAwaiter().GetResult();
    }

    public static Task<bool> IsSensitiveAsync(string? field, string? value)
    {
        var classifier = ResolveClassifier();
        return classifier is null
            ? Task.FromResult(false)
            : classifier.IsSensitiveAsync(field, value);
    }

    public static Task<IReadOnlyList<bool>> IsSensitiveBatchAsync(
        IReadOnlyList<(string Field, string Value)> items,
        CancellationToken cancellationToken = default)
    {
        var classifier = ResolveClassifier();
        if (classifier is null || items is null || items.Count == 0)
        {
            return Task.FromResult<IReadOnlyList<bool>>(Array.Empty<bool>());
        }

        return classifier.ClassifyAsync(items, cancellationToken);
    }

    private static AISensitiveFieldClassifier? ResolveClassifier()
    {
        return SensitiveFieldClassifierScope.Services
            ?.GetService(typeof(AISensitiveFieldClassifier)) as AISensitiveFieldClassifier;
    }
}

// Holds the root service provider so the static facade can resolve the classifier.
internal static class SensitiveFieldClassifierScope
{
    public static IServiceProvider? Services { get; set; }
}
