# Smart Document Solutions Demo

**Smart Document Solutions** streamlines document-heavy workflows by turning claim packets, contracts, invoices, and reports into structured, validated, business-ready data. Upload mixed document types, describe the outcome you need, and watch Syncfusion's document libraries perform OCR, extraction, redaction, and export — every step inspectable, every irreversible action confirmed. AI-powered sensitive data detection identifies and securely redacts confidential information, enabling safer document handling while reducing manual effort.

This showcase bundles three end-to-end demos that illustrate how Syncfusion's document libraries — combined with OpenAI — solve real-world document challenges.

---

## Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/download) installed.
- Windows, macOS, or Linux with a modern browser (Edge, Chrome).
- A valid **Syncfusion license key** (place in `Program.cs` to remove the evaluation banner). See configuration below.

## How to Run

1. **Navigate to the project**:
```text
   cd Syncfusion.SmartDemo
```

2. **Restore dependencies and build**:
```text
   dotnet restore
   dotnet build
```

3. **Run the application** (uses the default profile from `Properties/launchSettings.json`):
```text
   dotnet run
```

4. **Open the home page** in your browser at:

   **http://localhost:xxxx;**

   The home page will launch with cards linking to all three demos: **Claim Intake**, **Contract Review**, and **Board Pack**.

---

## Demos Included

- Claim Intake    - https://document.syncfusion.com/smart-document-solutions/claim-intake/
- Contract Review - https://document.syncfusion.com/smart-document-solutions/contract-review/
- Board Pack      - https://document.syncfusion.com/smart-document-solutions/board-pack/
---

### AI Key Requirement

Few demos use OpenAI to power specific features. Not every demo needs an OpenAI key - see the table below.

| Demo | OpenAI Key Required? | What the key is used for |
|---|---|---|
| **Claim Intake** | Yes, for AI-powered detection | Sensitive (PII) field detection and intelligent redaction. OCR and export still work without a key. |
| **Contract Review** | Yes, for AI summary only | Generating the plain-English change summary. Document comparison, Track Changes, and export work without a key. |
| **Board Pack** | No | Pure Syncfusion document processing - no AI calls. |

To enable the AI-powered features in any demo that needs them:

1. Provide a valid **OpenAI API key** and a **model name** in `appsettings.json`.
2. Ensure your OpenAI account has access to the selected model.

---

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