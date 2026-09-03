# document-processing-smart-showcase
Document processing showcase: Claims Intake (OCR, extraction, redaction), Contract Review (comparison, track changes, AI summary), Invoice Batch (table extraction, workbook creation), and Board Pack (merge, bookmarks, watermarks). Built with Syncfusion and OpenAI.

## AI Configure & Licensing

All runtime secrets and the Syncfusion license are configured in `appsettings.json` and `Program.cs`. Update the placeholder values before running the app.

### Step 1: Configure OpenAI Settings

Open `Syncfusion.SmartDemo/appsettings.json` and replace the OpenAI placeholders:

```json
{
  "OpenAI": {
    "ApiKey": "YOUR_OPENAI_API_KEY",
    "Model": "YOUR_MODEL_NAME"
  }
  ...
}
```

### Step 2: Configure Syncfusion License

Open `Syncfusion.SmartDemo/Program.cs` and replace the Syncfusion license placeholder:

```csharp
Syncfusion.Licensing.SyncfusionLicenseProvider.RegisterLicense("YOUR_SYNCFUSION_LICENSE_KEY");
```

### Configuration Reference

| Setting | What it is | Required |
|---------|-----------|----------|
| `OpenAI.ApiKey` | Your OpenAI API key, used server-side only. | Yes (for AI features) |
| `OpenAI.Model` | The chat-completions model name (e.g. `gpt-4o-mini`, `gpt-4-turbo`, `gpt-35-turbo`). | Yes (for AI features) |
| `Syncfusion.LicenseKey` | Your Syncfusion license key from the Customer Portal; removes the evaluation banner and unlocks commercial features. | Yes (for production use) |

**Note:** If OpenAI credentials are left blank, AI-powered features (intelligent field detection, change summaries, etc.) will be disabled, and only the raw OCR/extraction data will be available.
