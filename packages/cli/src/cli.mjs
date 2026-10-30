import { installationOptions, extractInstallationFlags } from "./installation.mjs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createCredentialStore } from "./credential-store.mjs";
import { authorizePkce, currentCredential, openBrowser, pollDeviceAuthorization, startDeviceAuthorization } from "./auth.mjs";
import { CLI_VERSION } from "./constants.mjs";
import { downloadAppsSourceSnapshot, listAppsSourceSnapshots, uploadAppsSourceSnapshot } from "./apps-snapshots.mjs";
import { deployLocalAppsApp } from "./apps-deploy.mjs";
import { applyAppsMigrations, planAppsMigrations } from "./apps-migrations.mjs";
import { callMcpTool, listMcpTools } from "./mcp-client.mjs";
import { runMcpProxy } from "./mcp-proxy.mjs";
import { installAgentMcp } from "./agent-install.mjs";
import { transferUpload } from "./upload-transfer.mjs";

export async function runCli(args, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let store = options.store;
  try {
    if (isHelpOption(args) && args[0] === "apps" && args[1] === "deploy") {
      stdout.write(APPS_DEPLOY_HELP);
      return;
    }
    if ((isHelpOption(args) && args.length === 1) || (args[0] === "help" && args.length === 1)) {
      stdout.write(ROOT_HELP);
      return;
    }
    if (args[0] === "upload" && isHelpOption(args)) {
      stdout.write(UPLOAD_HELP);
      return;
    }
    if (args[0] === "version" || args[0] === "--version" || args[0] === "-v") {
      stdout.write(`workspace-cli version ${CLI_VERSION}\n`);
      return;
    }
    const parsed = extractInstallationFlags(args);
    args = parsed.args;
    options = { ...options, ...parsed.options };
    const installation = installationOptions(options);
    options = { ...options, ...installation };
    store ??= createCredentialStore({ ...options.storeOptions, ...installation });
    if (args[0] === "auth" && args[1] === "device") {
      await authorizeDevice(args, stdout, store, options);
      return;
    }
    if (args[0] === "auth" && (args[1] === "login" || args[1] === "pkce")) {
      await authorizeWithPkce(args, stdout, store, options);
      return;
    }
    if (args[0] === "auth" && args[1] === "status") {
      const credential = await store.load();
      stdout.write(`${JSON.stringify({ logged_in: Boolean(credential?.refresh_token), method: credential?.authorization_method ?? (credential?.refresh_token ? "oauth" : null), agent_type: credential?.agent_type ?? null, credential_store: store.kind, expires_at: credential?.expires_at ?? null })}\n`);
      return;
    }
    if (args[0] === "auth" && (args[1] === "logout" || args[1] === "revoke")) {
      await store.clear();
      stdout.write(`${JSON.stringify({ logged_in: false, method: null })}\n`);
      return;
    }
    if (args[0] === "mcp" && args[1] === "serve") {
      await currentCredential(store, options);
      await runMcpProxy(store, options);
      return;
    }
    if (args[0] === "mcp" && args[1] === "tools") {
      stdout.write(`${JSON.stringify(await listMcpTools(store, options))}\n`);
      return;
    }
    if (args[0] === "mcp" && args[1] === "call") {
      const toolName = args[2]?.trim();
      if (!toolName || toolName.startsWith("-")) throw new Error("Usage: frontier-workspace mcp call <tool> [--args JSON | --args-file PATH]");
      const toolArgs = await readToolArgs(args);
      stdout.write(`${JSON.stringify(await callMcpTool(store, toolName, toolArgs, options))}\n`);
      return;
    }
    if (args[0] === "upload") {
      const input = {
        compress: args.includes("--compress"),
        ffmpegBin: optionValue(args, "--ffmpeg-bin")?.trim(),
        filePath: optionValue(args, "--file")?.trim(),
        requestPath: optionValue(args, "--request-file")?.trim(),
        resumePath: optionValue(args, "--resume")?.trim(),
      };
      if (input.resumePath) {
        if (input.compress || input.ffmpegBin || input.requestPath) throw new Error("--resume cannot be combined with --compress, --ffmpeg-bin, or --request-file");
      } else {
        for (const [key, optionName] of [["filePath", "--file"], ["requestPath", "--request-file"]]) {
          if (!input[key] || input[key].startsWith("--")) throw new Error(`Missing required option ${optionName}`);
        }
        if (input.ffmpegBin && !input.compress) throw new Error("--ffmpeg-bin requires --compress");
      }
      stdout.write(`${JSON.stringify(await transferUpload(input, { ...options, stderr, store }))}\n`);
      return;
    }
    if (args[0] === "apps" && args[1] === "snapshot") {
      await runAppsSnapshotCommand(args, stdout, store, options);
      return;
    }
    if (args[0] === "apps" && args[1] === "deploy") {
      const appId = requiredOption(args, "--app");
      const assetsDirectory = optionValue(args, "--assets-dir")?.trim();
      assertAssetsDirectoryProvided(args, assetsDirectory);
      const deployDir = requiredOption(args, "--deploy-dir");
      const target = requiredOption(args, "--target");
      const version = requiredVersionOption(args, "--version", 80);
      const versionName = requiredTextOption(args, "--name", 160);
      const releaseNotes = await requiredNotesOption(args);
      const workerFirstRoutes = optionValues(args, "--assets-run-worker-first-route").filter(Boolean);
      const queueConsumer = queueConsumerOption(args);
      const result = await deployLocalAppsApp(store, {
        appId,
        assetsBinding: optionValue(args, "--assets-binding"),
        assetsDirectory,
        assetsHtmlHandling: optionValue(args, "--assets-html-handling"),
        assetsNotFoundHandling: optionValue(args, "--assets-not-found-handling"),
        assetsRunWorkerFirst: workerFirstRoutes.length > 0 ? workerFirstRoutes : args.includes("--assets-run-worker-first"),
        cronSchedules: optionValues(args, "--cron").filter(Boolean),
        deployDir,
        dryRun: args.includes("--dry-run"),
        entrypoint: optionValue(args, "--entrypoint"),
        loginRequired: optionalYesNo(args, "--login-required"),
        releaseNotes,
        queueConsumer,
        skipSource: args.includes("--skip-source"),
        source: optionValue(args, "--source") ?? ".",
        sourceExcludes: optionValues(args, "--source-exclude"),
        target,
        version,
        versionName
      }, options);
      stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (args[0] === "apps" && args[1] === "d1" && args[2] === "migrate") {
      const action = args[3];
      const input = {
        allowDataMigrations: args.includes("--allow-data-migrations"),
        appId: requiredOption(args, "--app"),
        directory: optionValue(args, "--dir") ?? "migrations",
        tablePrefix: optionValue(args, "--table-prefix")
      };
      if (action === "plan") {
        stdout.write(`${JSON.stringify(await planAppsMigrations(store, input, options))}\n`);
        return;
      }
      if (action === "apply") {
        stdout.write(`${JSON.stringify(await applyAppsMigrations(store, input, options))}\n`);
        return;
      }
      throw new Error("Usage: frontier-workspace apps d1 migrate plan|apply --app <appId> --table-prefix <app_prefix_> [--dir migrations] [--allow-data-migrations]");
    }
    if (args[0] === "agent" && args[1] === "install") {
      await installAgentConnection(args, requiredOption(args, "--agent"), stdout, store, options);
      return;
    }
    if (args[0] === "workbuddy" && args[1] === "install") {
      await installAgentConnection(args, "workbuddy", stdout, store, options);
      return;
    }
    throw new Error("Usage: frontier-workspace auth login|device|status|logout | frontier-workspace agent install --agent <agent> | frontier-workspace mcp serve|tools|call | frontier-workspace upload | frontier-workspace apps snapshot upload|list|download | frontier-workspace apps deploy | frontier-workspace apps d1 migrate plan|apply | frontier-workspace workbuddy install | frontier-workspace version");
  } catch (error) {
    stderr.write(`workspace: ${error instanceof Error ? error.message : "unknown error"}\n`);
    if (options.throwOnError) throw error;
    process.exitCode = 1;
  }
}

const ROOT_HELP = `Usage: frontier-workspace <command> [options]

Commands:
  auth login|device|status|logout
  agent install --agent <codex|claude-code|cursor|workbuddy>
  mcp serve|tools|call
  upload --file <path> --request-file <path>
  apps snapshot upload|list|download
  apps deploy
  apps d1 migrate plan|apply
  workbuddy install
  version

Run "frontier-workspace apps deploy --help" for deployment options.
`;

const UPLOAD_HELP = `Usage: frontier-workspace upload [options]

Required for a new upload:
  --file <path>                 Local file to transfer
  --request-file <path>         JSON upload descriptor supplied by a resource

Optional:
  --compress                    Transcode a video to H.264/AAC MP4 with local FFmpeg
  --ffmpeg-bin <path>           FFmpeg executable (default: FFMPEG_PATH or ffmpeg)
  --resume <checkpoint.json>    Resume an interrupted Media TUS upload

Supported resource providers:
  media                         TUS for resumable uploads, or multipart direct upload
  r2                            Signed HTTP PUT upload

FFmpeg is optional and is never bundled with Workspace CLI. If --compress is selected
and FFmpeg is missing, Workspace prints install instructions for the current OS.
The resource prepares its upload descriptor using the final file size after compression.
`;

const APPS_DEPLOY_HELP = `Usage: frontier-workspace apps deploy [options]

Required:
  --app <appId>                 APPS App ID
  --deploy-dir <directory>      Built Pages files or Worker modules
  --target <pages|worker>       Deployment target
  --version <version>           Release version
  --name <name>                 Release name
  --notes <text>                One release's notes, maximum 4000 characters
  --notes-file <path>           Read one release's notes from a file; same limit

Source and execution:
  --source <directory>          Source snapshot root (default: .)
  --source-exclude <pattern>    Repeatable source exclusion
  --entrypoint <path>           Default: index.html for Pages, index.js for Worker
  --skip-source                 Do not upload a source snapshot
  --dry-run                     Validate and summarize without network writes
  --login-required <yes|no>     Target company-account sign-in policy; yes defaults
                                the access scope to Collaborators and Owner only

Worker Static Assets:
  --assets-dir <directory>      Built browser assets; required for Worker frontends
  --assets-binding <name>       Assets binding (default: ASSETS)
  --assets-html-handling <mode> auto-trailing-slash, force-trailing-slash,
                                drop-trailing-slash, or none
  --assets-not-found-handling <mode>
                                none, 404-page, or single-page-application
  --assets-run-worker-first     Run the Worker before static asset routing
  --assets-run-worker-first-route <glob>
                                Repeatable Worker-first route

Worker Runtime Topology:
  --cron <expression>           Repeatable Cron trigger; requires cron_trigger
  --queue-consumer <binding>    Configure this App Queue binding as a consumer
  --queue-max-batch-size <n>    Default: 10; range: 1-100
  --queue-max-batch-timeout <s> Default: 5; range: 0-60 seconds
  --queue-max-retries <n>       Default: 3; range: 0-100
  --queue-max-concurrency <n>   Optional maximum concurrent consumers
  --queue-retry-delay <s>       Optional retry delay in seconds

Result and publication:
  This command creates a ready, unpublished deployment. Production traffic is
  unchanged. After review and explicit approval, publish the returned deployment
  with Workspace MCP MCP apps_deployment_release(action=publish).

Example:
  frontier-workspace apps deploy --app app_xxx --source . \\
    --deploy-dir .build/worker --target worker --entrypoint index.js \\
    --assets-dir dist --assets-binding ASSETS \\
    --assets-not-found-handling single-page-application \\
    --assets-run-worker-first --version 1.4.0 --name "Full-stack release" \\
    --notes-file RELEASE_NOTES.md

.workspace-assets/ is an internal archive directory reserved for Workspace CLI.
Do not create or copy it manually; always pass browser output with --assets-dir.
`;

function isHelpOption(args) {
  return args.includes("--help") || args.includes("-h");
}

async function installAgentConnection(args, agentType, stdout, store, options) {
  let credential = await store.load();
  if (credential) {
    try {
      credential = await currentCredential(store, options);
    } catch {
      await store.clear();
      credential = undefined;
    }
  }
  if (credential?.authorization_method !== "authorization_code_pkce") credential = undefined;
  const authorizationReused = Boolean(credential?.refresh_token);
  if (!authorizationReused) await authorizeWithPkce(args, stdout, store, { ...options, agentType });
  const installation = await installAgentMcp(agentType, options);
  stdout.write(`${JSON.stringify({ ...installation, authorization_reused: authorizationReused })}\n`);
}

function assertAssetsDirectoryProvided(args, assetsDirectory) {
  const assetOptions = [
    "--assets-binding",
    "--assets-dir",
    "--assets-html-handling",
    "--assets-not-found-handling",
    "--assets-run-worker-first",
    "--assets-run-worker-first-route"
  ];
  if (!assetsDirectory && assetOptions.some((name) => hasOption(args, name))) {
    throw new Error("Worker Static Assets options require --assets-dir <directory>; .workspace-assets/ is reserved for Workspace CLI and must not be created manually");
  }
}

function queueConsumerOption(args) {
  const bindingName = optionValue(args, "--queue-consumer")?.trim();
  const settingNames = [
    "--queue-max-batch-size",
    "--queue-max-batch-timeout",
    "--queue-max-retries",
    "--queue-max-concurrency",
    "--queue-retry-delay"
  ];
  if (!bindingName) {
    if (settingNames.some((name) => hasOption(args, name))) {
      throw new Error("Queue consumer settings require --queue-consumer <binding>");
    }
    return undefined;
  }
  return {
    bindingName,
    ...integerOption(args, "--queue-max-batch-size", "maxBatchSize"),
    ...integerOption(args, "--queue-max-batch-timeout", "maxBatchTimeout"),
    ...integerOption(args, "--queue-max-retries", "maxRetries"),
    ...integerOption(args, "--queue-max-concurrency", "maxConcurrency"),
    ...integerOption(args, "--queue-retry-delay", "retryDelay")
  };
}

function integerOption(args, optionName, propertyName) {
  const value = optionValue(args, optionName);
  if (value === undefined) return {};
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${optionName} must be an integer`);
  return { [propertyName]: parsed };
}

function optionalYesNo(args, optionName) {
  const value = optionValue(args, optionName)?.trim().toLowerCase();
  if (value === undefined) return undefined;
  if (value === "yes") return true;
  if (value === "no") return false;
  throw new Error(`${optionName} must be yes or no`);
}

function hasOption(args, name) {
  return args.some((value) => value === name || value.startsWith(`${name}=`));
}

async function authorizeWithPkce(args, stdout, store, options) {
  const browserMode = optionValue(args, "--open-browser") ?? "auto";
  await authorizePkce(store, {
    ...options,
    agentType: options.agentType ?? optionValue(args, "--agent") ?? process.env.WORKSPACE_AGENT ?? "codex",
    openBrowser: browserMode !== "never" && options.openBrowser !== false,
    async onAuthorization(details) {
      stdout.write(`${JSON.stringify({
        type: "authorization_required",
        method: "authorization_code_pkce",
        authorization_url: details.authorizationUrl,
        callback: "loopback"
      })}\n`);
      await options.onAuthorization?.(details);
    }
  });
  stdout.write(`${JSON.stringify({ type: "authorization_complete", logged_in: true, method: "authorization_code_pkce" })}\n`);
}

async function runAppsSnapshotCommand(args, stdout, store, options) {
  const action = args[2];
  const appId = requiredOption(args, "--app");
  if (action === "upload") {
    const result = await uploadAppsSourceSnapshot(store, {
      appId,
      dryRun: args.includes("--dry-run"),
      notes: await optionalNotesOption(args),
      purpose: "backup",
      source: optionValue(args, "--source") ?? ".",
      sourceExcludes: optionValues(args, "--source-exclude"),
      version: requiredVersionOption(args, "--version", 120),
      versionName: requiredTextOption(args, "--name", 160)
    }, options);
    stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (action === "list") {
    stdout.write(`${JSON.stringify(await listAppsSourceSnapshots(store, appId, options))}\n`);
    return;
  }
  if (action === "download") {
    const snapshotId = requiredOption(args, "--snapshot");
    const result = await downloadAppsSourceSnapshot(store, { appId, snapshotId }, options);
    const outputPath = resolve(optionValue(args, "--output") ?? result.fileName);
    if (!args.includes("--force") && await pathExists(outputPath)) {
      throw new Error(`Output file already exists: ${outputPath}. Pass --force to replace it`);
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, result.archive);
    stdout.write(`${JSON.stringify({ archiveSha256: result.archiveSha256, outputPath, sizeBytes: result.archive.byteLength, snapshotId })}\n`);
    return;
  }
  throw new Error("Usage: frontier-workspace apps snapshot upload --app <appId> --version <number> --name <name> [--notes TEXT | --notes-file PATH] | list|download --app <appId>");
}

async function requiredNotesOption(args) {
  const notes = await optionalNotesOption(args);
  if (!notes) throw new Error("Missing release notes; pass --notes <text> or --notes-file <path>");
  if (notes.length > 4_000) throw new Error("Release notes must not exceed 4000 characters");
  return notes;
}

async function optionalNotesOption(args) {
  const inline = optionValue(args, "--notes");
  const file = optionValue(args, "--notes-file");
  if (inline !== undefined && file !== undefined) throw new Error("Use only one of --notes or --notes-file");
  const notes = file !== undefined
    ? (await readFile(resolve(file), "utf8")).trim()
    : inline?.trim() ?? "";
  if (notes.length > 4_000) throw new Error("Notes must not exceed 4000 characters");
  return notes;
}

async function readToolArgs(args) {
  const inline = optionValue(args, "--args");
  const file = optionValue(args, "--args-file");
  if (inline && file) throw new Error("Use only one of --args or --args-file");
  const text = file ? await readFile(resolve(file), "utf8") : inline ?? "{}";
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("MCP tool arguments must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP tool arguments must be a JSON object");
  }
  return value;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function requiredOption(args, name) {
  const value = optionValue(args, name)?.trim();
  if (!value || value.startsWith("--")) throw new Error(`Missing required option ${name}`);
  return value;
}

function requiredTextOption(args, name, maxLength) {
  const value = requiredOption(args, name);
  if (value.length > maxLength) throw new Error(`${name} must not exceed ${maxLength} characters`);
  return value;
}

function requiredVersionOption(args, name, maxLength) {
  const value = requiredTextOption(args, name, maxLength);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${name} must use letters, numbers, dot, underscore, or hyphen`);
  }
  return value;
}

async function authorizeDevice(args, stdout, store, options) {
  const device = await startDeviceAuthorization(options);
  stdout.write(`${JSON.stringify({
    type: "device_authorization",
    user_code: device.user_code,
    verification_uri: device.verification_uri,
    verification_uri_complete: device.verification_uri_complete,
    expires_in: device.expires_in,
    interval: device.interval
  })}\n`);
  const browserMode = optionValue(args, "--open-browser") ?? "auto";
  if (browserMode !== "never" && options.openBrowser !== false) (options.browserOpener ?? openBrowser)(device.verification_uri_complete || device.verification_uri);
  await pollDeviceAuthorization(device, store, options);
  stdout.write(`${JSON.stringify({ type: "authorization_complete", logged_in: true, method: "oauth" })}\n`);
}

function optionValue(args, name) {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(`${name}=`)) {
      values.push(value.slice(name.length + 1));
      continue;
    }
    if (value === name) {
      values.push(args[index + 1] ?? "");
      index += 1;
    }
  }
  return values;
}
