
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Caching.Distributed;
using Syncfusion.Licensing;
using System.Text.RegularExpressions;
using Syncfusion.SmartDemo.Models;
using Syncfusion.SmartDemo.Models.BoardPack;
using Syncfusion.SmartDemo.Services;
using Syncfusion.SmartDemo.Services.BoardPack;
using Syncfusion.SmartDemo.Services.ContractReview;

Syncfusion.Licensing.SyncfusionLicenseProvider.RegisterLicense("YOUR_SYNCFUSION_LICENSE_KEY");
var builder = WebApplication.CreateBuilder(args);

// -----------------------------------------------------------------
// Data Protection key ring.
//
// On Azure App Service the worker process is rebuilt on every
// restart, which means the in-memory key ring used to encrypt
// the session / antiforgery cookies is regenerated. If we do not
// persist the keys somewhere the encrypted cookies become
// unreadable on the next request, which manifests itself as the
// session looking "empty" after a recycle - exactly the same
// user-facing symptom as a wiped in-memory session cache.
//
// Persist the keys to %HOME%\Data\Keys on Azure App Service
// (persistent across restarts and zip-deploys) or to
// App_Data\Keys when running locally. This is the same location
// Microsoft recommends for stateful web apps on App Service.
// -----------------------------------------------------------------
{
    var home = Environment.GetEnvironmentVariable("HOME");
    string keysPath;
    if (!string.IsNullOrWhiteSpace(home))
    {
        keysPath = Path.Combine(home, "Data", "Keys");
    }
    else
    {
        keysPath = Path.Combine(builder.Environment.ContentRootPath, "App_Data", "Keys");
    }
    Directory.CreateDirectory(keysPath);
    builder.Services.AddDataProtection()
        .PersistKeysToFileSystem(new DirectoryInfo(keysPath))
        .SetApplicationName("Syncfusion.Smart.Server");
}

// Add services to the container.
builder.Services.AddControllers();
builder.Services.AddRazorPages();

// HttpContextAccessor is consumed by PerSessionFileStore so it
// can read / write the per-user session cookie.
builder.Services.AddHttpContextAccessor();

// -----------------------------------------------------------------
// File-backed distributed cache.
//
// Replaces the default in-process AddDistributedMemoryCache(),
// which loses every session entry on every Azure App Service
// recycle. The custom implementation writes through to
// %HOME%\Data\SessionCache (or App_Data\SessionCache locally),
// so the user's "chosen template", extracted fields, and AI
// transcript survive restarts and zip-deploys.
//
// See Services\FileDistributedCache.cs for the design rationale.
// -----------------------------------------------------------------
{
    var home = Environment.GetEnvironmentVariable("HOME");
    string cacheRoot;
    if (!string.IsNullOrWhiteSpace(home))
    {
        cacheRoot = Path.Combine(home, "Data", "SessionCache");
    }
    else
    {
        cacheRoot = Path.Combine(builder.Environment.ContentRootPath, "App_Data", "SessionCache");
    }
    Directory.CreateDirectory(cacheRoot);
    builder.Services.AddSingleton<IDistributedCache>(_ => new FileDistributedCache(cacheRoot));
}

// Session configuration:
//   * Use our file-backed distributed cache as the backing
//     store (see above).
//   * Mark the session cookie as essential so the
//     CookiePolicyMiddleware does not silently drop it.
//   * Increase the idle timeout - 20 minutes was too aggressive
//     for an interactive demo where the user may be reviewing
//     extractions for a while between page loads.
builder.Services.AddSession(options =>
{
    options.Cookie.Name = ".Syncfusion.Smart.Session";
    options.Cookie.HttpOnly = true;
    options.Cookie.IsEssential = true;
    options.Cookie.SameSite = SameSiteMode.Lax;
    options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
    options.IdleTimeout = TimeSpan.FromHours(2);
});

// Per-session file store. Singleton because the underlying
// IWebHostEnvironment and IHttpContextAccessor are both
// effectively singletons.
builder.Services.AddSingleton<PerSessionFileStore>();

// Azure OpenAI: configuration, shared client, and AI sensitive-data classifier.
builder.Services.Configure<OpenAIOptions>(
    builder.Configuration.GetSection(OpenAIOptions.SectionName));

// Production override: environment variables (Azure App Service -> Configuration ->
// Application Settings) take precedence over appsettings.json. Set the two values
// below in App Service to hide the API key from source / publish output:
//   OPENAI_API_KEY  -> opts.ApiKey
//   OPENAI_Model    -> opts.Model
builder.Services.PostConfigure<OpenAIOptions>(opts =>
{
    var apiKey = Environment.GetEnvironmentVariable("OPENAI_API_KEY");
    if (!string.IsNullOrWhiteSpace(apiKey))
    {
        opts.ApiKey = apiKey;
    }

    var model = Environment.GetEnvironmentVariable("OPENAI_Model");
    if (!string.IsNullOrWhiteSpace(model))
    {
        opts.Model = model;
    }
});

//builder.Services.AddSingleton<AzureOpenAIClientFactory>();
builder.Services.AddSingleton<OpenAIClientFactory>();
builder.Services.AddSingleton<AISensitiveFieldClassifier>();
// AI change-summary agent + HTML->DOCX converter used by
// the contract-review AI summary step. Both are stateless
// singletons because they only hold configuration and
// helpers - no per-request state lives on them.
builder.Services.AddSingleton<AIChangeSummaryGenerator>();
builder.Services.AddSingleton<HtmlToDocxConverter>();

// Board Pack: services registered in the same order as the
// Claim Intake pipeline so future readers can map one sample to
// the other 1:1. All three are singletons because every member
// is either stateless (the converter), only uses injected
// dependencies (the store), or both (the generator).
builder.Services.AddSingleton<BoardPackWorkspaceStore>();
builder.Services.AddSingleton<BoardPackOfficeConverter>();
builder.Services.AddSingleton<BoardPackGenerator>();

builder.Services.AddCors(options =>
{
    options.AddPolicy("dev", policy =>
    {
        policy.AllowAnyHeader()
              .AllowAnyMethod()
              .AllowAnyOrigin();
    });
});
// Learn more about configuring Swagger/OpenAPI at https://aka.ms/aspnetcore/swashbuckle
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

// -----------------------------------------------------------------
// ForwardedHeaders: trust X-Forwarded-Proto and X-Forwarded-For
// from AWS CloudFront (and any other TLS-terminating reverse proxy).
//
// Without this, Request.IsHttps returns false behind CloudFront
// because the app server receives plain HTTP from the proxy.
// Modern browsers silently drop Secure=false cookies on HTTPS
// pages, so every request lands in a fresh session — the root
// cause of the AWS "only 1 document loads / 404 on convert" bug.
//
// KnownNetworks / KnownProxies are cleared because CloudFront
// IP ranges are large and change over time. The app is always
// deployed behind the proxy, so there is no risk of header spoofing
// from untrusted hosts reaching the server directly.
// -----------------------------------------------------------------
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    options.ForwardLimit = 2;
    options.RequireHeaderSymmetry = false;
    // Trust all upstream proxies (CloudFront / Azure Front Door /
    // ALB all use dynamic IP ranges, so static allow-lists are not
    // practical here).
    options.KnownNetworks.Clear();
    options.KnownProxies.Clear();
});

var app = builder.Build();

// Expose the root service provider to the static SensitiveFieldClassifier facade.
Syncfusion.SmartDemo.Models.SensitiveFieldClassifierScope.Services = app.Services;

// Must be the first middleware so that all subsequent middleware
// (UsePathBase, UseHttpsRedirection, routing, cookie-based session
// handling) observe the corrected Request.Scheme and Request.IsHttps.
app.UseForwardedHeaders();

var pathBase = builder.Configuration["PathBase"]
    ?? Environment.GetEnvironmentVariable("ASPNETCORE_PATHBASE");

if (!string.IsNullOrWhiteSpace(pathBase) && !string.Equals(pathBase, "/", StringComparison.Ordinal))
{
    if (!pathBase.StartsWith('/'))
    {
        pathBase = "/" + pathBase;
    }

    app.UsePathBase(pathBase);
}

// -----------------------------------------------------------------
// Static files.
//
// The wwwroot/templatefiles folder is still served by the default
// static-files middleware (it contains the read-only demo
// templates). Per-user uploads are served by the
// ClaimIntakeController's /api/claim-intake/preview/{file}
// endpoint, which goes through PerSessionFileStore for proper
// session authorisation. Serving them via a static-files
// middleware would let any logged-out user enumerate every
// session's PDFs.
// -----------------------------------------------------------------
app.Use(async (context, next) =>
{
    var request = context.Request;
    var path = request.Path.Value ?? string.Empty;

    if (HttpMethods.IsGet(request.Method) || HttpMethods.IsHead(request.Method))
    {
        var hasTrailingSlash = path.EndsWith("/", StringComparison.Ordinal);
        var hasExtension = !string.IsNullOrEmpty(System.IO.Path.GetExtension(path));
        var isApi = path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase);
        var isRoot = string.Equals(path, "/", StringComparison.Ordinal);

        if (!hasTrailingSlash && !hasExtension && !isApi && !isRoot)
        {
            var queryString = request.QueryString.HasValue ? request.QueryString.Value : string.Empty;
            // Honor UsePathBase (e.g. "/demos" on Azure App Service) so the
            // 301 Location keeps the base prefix instead of dropping it and
            // landing the user outside the app.
            var pathBase = (request.PathBase.Value ?? string.Empty).TrimEnd('/');
            var redirectUrl = pathBase + path + "/" + queryString;
            context.Response.StatusCode = StatusCodes.Status301MovedPermanently;
            context.Response.Headers.Location = redirectUrl;
            return;
        }
    }

    await next();
});
app.UseStaticFiles();

if (app.Environment.IsDevelopment())
{
    app.UseCors("dev");
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();

app.UseRouting();

app.UseSession();

app.UseAuthorization();

app.MapRazorPages();

app.MapControllers();

app.Run();
