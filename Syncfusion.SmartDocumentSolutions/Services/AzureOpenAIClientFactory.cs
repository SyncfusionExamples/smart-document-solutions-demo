
using Microsoft.Extensions.Options;
using OpenAI;
using OpenAI.Chat;
using System.ComponentModel.DataAnnotations;

namespace Syncfusion.SmartDocumentSolutions.Services;

// Owns the single OpenAIClient and exposes a ChatClient.
public sealed class OpenAIClientFactory : IDisposable
{
    private readonly OpenAIClient _client;
    private readonly string _model;
    private readonly Lazy<ChatClient> _chatClient;

    public OpenAIClientFactory(IOptions<OpenAIOptions> options)
    {
        var opts = options.Value;

        if (string.IsNullOrWhiteSpace(opts.ApiKey) ||
            string.IsNullOrWhiteSpace(opts.Model))
        {
            throw new InvalidOperationException(
                "OpenAI configuration is missing. Set ApiKey and Model under the OpenAI section of appsettings.json.");
        }

        _model = opts.Model;
        _client = new OpenAIClient(opts.ApiKey);

        _chatClient = new Lazy<ChatClient>(
            () => _client.GetChatClient(_model));
    }

    public ChatClient ChatClient => _chatClient.Value;

    public void Dispose()
    {
        // No disposal currently required.
    }
}

public sealed class OpenAIOptions
{
    public const string SectionName = "OpenAI";
    public string ApiKey { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
}