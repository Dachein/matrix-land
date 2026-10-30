import { fileURLToPath } from "node:url";
import { installationOptions } from "./installation.mjs";
import { createCredentialStore } from "./credential-store.mjs";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { normalizeAgentType } from "./auth.mjs";
import { CLI_VERSION } from "./constants.mjs";

const PACKAGE_NAME = "@frontier-workspace/cli";


export async function installAgentMcp(rawAgent, options = {}) {
  const agent = normalizeAgentType(rawAgent);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDirectory = options.home ?? homedir();
  const installation = installationOptions(options);
  const server = mcpServerConfig({ agent, env, homeDirectory, platform, installation, execPath: options.execPath ?? process.execPath });

  if (agent === "workbuddy" || agent === "cursor") {
    return installJsonMcp(agent, server, {
      ...options,
      configPath: options.configPath ?? defaultAgentConfigPath(agent, homeDirectory)
    });
  }

  return installHostCliMcp(agent, server, options);
}

export async function installWorkBuddyMcp(options = {}) {
  return installAgentMcp("workbuddy", options);
}

export function defaultAgentConfigPath(rawAgent, homeDirectory = homedir()) {
  const agent = normalizeAgentType(rawAgent);
  if (agent === "workbuddy") return join(homeDirectory, ".workbuddy-ai", "mcp.json");
  if (agent === "cursor") return join(homeDirectory, ".cursor", "mcp.json");
  return undefined;
}

export async function resolveNpxCommand(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const executableName = platform === "win32" ? "npx.cmd" : "npx";
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const candidates = [
    join(dirname(execPath), executableName),
    ...String(env.PATH ?? env.Path ?? env.path ?? "").split(pathDelimiter).filter(Boolean).map((entry) => join(entry, executableName))
  ];
  for (const candidate of candidates) {
    const absoluteCandidate = isAbsolute(candidate) ? candidate : resolve(candidate);
    try {
      await access(absoluteCandidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      return absoluteCandidate;
    } catch {
      // Continue until an executable visible to the GUI host is found.
    }
  }
  throw new Error("Unable to locate an absolute npx executable for the Agent MCP configuration");
}

function mcpServerConfig({ agent, env, homeDirectory, platform, installation, execPath }) {
  const store = createCredentialStore({ env, home: homeDirectory, platform, ...installation });
  return {
    name: `workspace-${installation.installationKey.slice(0, 12)}`,
    agent,
    command: execPath,
    args: [fileURLToPath(new URL("../bin/frontier-workspace.mjs", import.meta.url)), "mcp", "serve"],
    env: {
      WORKSPACE_AUTH_URL: installation.authUrl,
      WORKSPACE_API_URL: installation.apiUrl,
      WORKSPACE_MCP_URL: installation.mcpUrl,
      WORKSPACE_CREDENTIAL_PATH: store.filePath,
      WORKSPACE_CREDENTIAL_STORE: "file",
      WORKSPACE_REFRESH_LOCK_PATH: store.refreshLockPath
    },
    packageSpec: `${PACKAGE_NAME}@${CLI_VERSION}`
  };
}

async function installJsonMcp(agent, server, options) {
  const config = await readConfig(options.configPath, agent);
  const nextServer = {
    ...(agent === "workbuddy" ? { type: "stdio" } : {}),
    command: server.command,
    args: server.args,
    ...(agent === "workbuddy" ? { timeout: 60000 } : {}),
    env: server.env
  };
  const previousServer = config.mcpServers?.[server.name];
  const changed = JSON.stringify(previousServer) !== JSON.stringify(nextServer);

  if (changed) {
    const nextServers = { ...(config.mcpServers ?? {}) };
    nextServers[server.name] = nextServer;
    config.mcpServers = nextServers;
    await writeConfig(options.configPath, config);
  }

  return installationResult(agent, server.packageSpec, changed, {
    server_name: server.name,
    config_path: options.configPath,
    trust_required: agent === "workbuddy"
  });
}

async function installHostCliMcp(agent, server, options) {
  const command = agent === "codex" ? "codex" : "claude";
  const removeArgs = agent === "codex"
    ? ["mcp", "remove", server.name]
    : ["mcp", "remove", "--scope", "user", server.name];
  for (const candidate of [server.name]) {
    const candidateRemoveArgs = removeArgs.map((value) => value === server.name ? candidate : value);
    const removeResult = await runHostCommand(command, candidateRemoveArgs, options);
    if (removeResult.exitCode !== 0 && !isMissingServer(removeResult)) {
      throw new Error(`${agentLabel(agent)} could not replace the existing ${candidate} MCP entry: ${commandError(removeResult)}`);
    }
  }

  const environmentArgs = Object.entries(server.env).flatMap(([key, value]) => agent === "codex"
    ? ["--env", `${key}=${value}`]
    : ["-e", `${key}=${value}`]);
  const addArgs = agent === "codex"
    ? ["mcp", "add", ...environmentArgs, server.name, "--", server.command, ...server.args]
    : ["mcp", "add", "--transport", "stdio", "--scope", "user", server.name, ...environmentArgs, "--", server.command, ...server.args];
  const addResult = await runHostCommand(command, addArgs, options);
  if (addResult.exitCode !== 0) {
    throw new Error(`${agentLabel(agent)} could not add the ${server.name} CLI MCP entry: ${commandError(addResult)}`);
  }

  return installationResult(agent, server.packageSpec, true, {
    server_name: server.name,
    configured_by: command,
    trust_required: false
  });
}

async function runHostCommand(command, args, options) {
  if (options.runCommand) return normalizeCommandResult(await options.runCommand(command, args));
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env: options.env ?? process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (error?.code === "ENOENT") {
        reject(new Error(`Required ${agentCommandLabel(command)} command '${command}' was not found; run the installer from that Agent environment`));
        return;
      }
      reject(error);
    });
    child.on("close", (exitCode) => resolveResult({ exitCode: exitCode ?? 1, stderr, stdout }));
  });
}

function normalizeCommandResult(result) {
  return {
    exitCode: Number(result?.exitCode ?? result?.code ?? 0),
    stderr: String(result?.stderr ?? ""),
    stdout: String(result?.stdout ?? "")
  };
}

function isMissingServer(result) {
  return /not found|no .*mcp server|does not exist|unknown server/i.test(`${result.stdout}\n${result.stderr}`);
}

function commandError(result) {
  return (result.stderr || result.stdout || `exit ${result.exitCode}`).trim().slice(0, 300);
}

function installationResult(agent, packageSpec, changed, extra) {
  return {
    type: "agent_installation_complete",
    agent,
    installed: true,
    changed,
    package: packageSpec,
    ...extra,
    next_action: agent === "workbuddy"
      ? "Open WorkBuddy Custom Connectors, trust this workspace entry, then start a new task."
      : `Restart ${agentLabel(agent)} or start a new Agent session, then call ping_who_am_i.`
  };
}

function agentLabel(agent) {
  if (agent === "claude-code") return "Claude Code";
  if (agent === "codex") return "Codex";
  if (agent === "cursor") return "Cursor";
  return "WorkBuddy";
}

function agentCommandLabel(command) {
  return command === "claude" ? "Claude Code" : "Codex";
}

function buildMacPath(npxCommand) {
  return [...new Set([
    dirname(npxCommand),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ])].join(":");
}

async function readConfig(configPath, agent) {
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${agentLabel(agent)} MCP config is not valid JSON: ${configPath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${agentLabel(agent)} MCP config must contain a JSON object: ${configPath}`);
  }
  if (parsed.mcpServers !== undefined && (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers))) {
    throw new Error(`${agentLabel(agent)} mcpServers must be a JSON object: ${configPath}`);
  }
  return parsed;
}

async function writeConfig(configPath, config) {
  await mkdir(dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, configPath);
}
