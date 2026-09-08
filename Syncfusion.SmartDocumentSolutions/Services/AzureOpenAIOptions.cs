using System.ComponentModel.DataAnnotations;

namespace Syncfusion.SmartDocumentSolutions.Services;

// Configuration for the AzureOpenAI section of appsettings.json.
public sealed class AzureOpenAIOptions
{
    public const string SectionName = "AzureOpenAI";

    [Required]
    public string Endpoint { get; set; } = string.Empty;

    [Required]
    public string ApiKey { get; set; } = string.Empty;

    [Required]
    public string Deployment { get; set; } = string.Empty;
}
