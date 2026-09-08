# document-processing-smart-showcase

## Smart Document Processing Demo

**Smart Document Solutions** streamlines document-heavy workflows by turning claim packets, contracts, invoices, and reports into structured, validated, business-ready data. Upload mixed document types, describe the outcome you need, and watch Syncfusion's document libraries perform OCR, extraction, redaction, and export — every step inspectable, every irreversible action confirmed. AI-powered sensitive data detection identifies and securely redacts confidential information, enabling safer document handling while reducing manual effort.

This showcase bundles three end-to-end demos that illustrate how Syncfusion's document libraries — combined with OpenAI — solve real-world document challenges.

---

## Demos Included

### 1. Claim Intake
Upload claim packets (mixed PDFs, scanned forms, images) and watch the pipeline automatically:
- Perform **OCR** on scanned documents to make them searchable.
- **Extract** structured fields (claimant info, dates, amounts, policy numbers) using AI.
- **Redact** sensitive information (PII) automatically with AI-assisted detection before export.
- Export the cleaned, validated claim file as PDF.

### 2. Contract Review
Upload a contract and a revised version to:
- **Compare** documents side-by-side and detect additions, deletions, and modifications.
- Render **Track Changes** directly into the document with the Syncfusion Document Editor (`SFDT`).
- Generate an **AI-powered change summary** that explains every meaningful change in plain English.
- Export the reviewed contract as PDF.

### 3. Board Pack
Assemble executive board packs from multiple source documents:
- **Merge** heterogeneous files (DOCX, PPTX, XLSX) into a single consolidated document.
- Insert structured **bookmarks** by default for navigation across files (agenda, financials, reports). Bookmarks can be reviewed and edited before export.
- Apply consistent **watermarks** (Draft / Confidential / Final) across the merged output. Watermarking is optional and configurable per export.
- Optionally **password-protect** the exported PDF. The user can set a password on demand; when no password is supplied, the PDF is exported without encryption.
- Export the final pack as a polished PDF.

---

## Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/download) installed.
- Windows, macOS, or Linux with a modern browser (Edge, Chrome, Firefox).
- A valid **Syncfusion license key** (place in `Program.cs` to remove the evaluation banner). See configuration below.

### AI Key Requirement (per demo)

Some demos use OpenAI to power specific features. Not every demo needs an OpenAI key - see the table below.

| Demo | OpenAI Key Required? | What the key is used for |
|---|---|---|
| **Claim Intake** | Yes, for AI-powered detection | Sensitive (PII) field detection and intelligent redaction. OCR and export still work without a key. |
| **Contract Review** | Yes, for AI summary only | Generating the plain-English change summary. Document comparison, Track Changes, and export work without a key. |
| **Board Pack** | No | Pure Syncfusion document processing - no AI calls. |

To enable the AI-powered features in any demo that needs them:

1. Provide a valid **OpenAI API key** and a **model name** in `appsettings.json` (see [Configure OpenAI Settings](#step-1-configure-openai-settings) below).
2. Ensure your OpenAI account has access to the selected model (e.g. `gpt-4o-mini`, `gpt-4-turbo`, `gpt-35-turbo`).

> If the OpenAI credentials are left blank, only the AI-assisted features listed above will be disabled — every demo still runs in its core (non-AI) mode so you can try the workflow end-to-end.

---

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

   **http://localhost:&lt;port&gt;**

   The home page will launch with cards linking to all three demos: **Claim Intake**, **Contract Review**, and **Board Pack**.

   > Replace `<port>` with the port shown in the console output after `dotnet run` (the default profile binds to `http://localhost:5192`, but the actual port may differ if it is already in use). You can also check `Properties/launchSettings.json` for the configured URLs.

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

### Configuration Reference

| Setting | What it is | Required |
|---------|-----------|----------|
| `OpenAI.ApiKey` | Your OpenAI API key, used server-side only. | Yes (for Claim Intake AI features) |
| `OpenAI.Model` | The chat-completions model name (e.g. `gpt-4o-mini`, `gpt-4-turbo`, `gpt-35-turbo`). | Yes (for Claim Intake AI features) |
| `Syncfusion.LicenseKey` | Your Syncfusion license key from the Customer Portal; removes the evaluation banner and unlocks commercial features. | Yes (for production use) |

**Note:** If OpenAI credentials are left blank, the AI-assisted features listed in the [per-demo requirement table](#ai-key-requirement-per-demo) above will be disabled. All three demos still run in their core (non-AI) mode without a key.
