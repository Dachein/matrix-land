import { WORKSPACE_AI_CLI_VERSION } from "./workspaceProductFamily.ts";
export const WORKSPACE_CLI_PACKAGE_NAME = "@frontier-workspace/cli";
export const WORKSPACE_CLI_PACKAGE_SPEC = `${WORKSPACE_CLI_PACKAGE_NAME}@${WORKSPACE_AI_CLI_VERSION}`;
export const WORKSPACE_CLI_INSTALL_COMMAND = `npm install -g ./frontier-workspace-cli-${WORKSPACE_AI_CLI_VERSION}.tgz`;
export const WORKSPACE_CLI_CURRENT_VERSION_COMMAND = "frontier-workspace version";
export const WORKSPACE_CLI_UPDATE_COMMAND = WORKSPACE_CLI_INSTALL_COMMAND;
export const WORKSPACE_CLI_SERVE_COMMAND = "frontier-workspace mcp serve";

export type WorkspaceCliAgent = "workbuddy" | "claude-code" | "codex" | "cursor";

export function workspaceAgentInstallCommand(agent: WorkspaceCliAgent, executable = "frontier-workspace") {
  return `${executable} agent install --agent=${agent} --open-browser=always --output=jsonl`;
}

export const WORKSPACE_AGENT_INSTALL_COMMANDS = {
  workbuddy: workspaceAgentInstallCommand("workbuddy"),
  claudeCode: workspaceAgentInstallCommand("claude-code"),
  codex: workspaceAgentInstallCommand("codex"),
  cursor: workspaceAgentInstallCommand("cursor")
} as const;

export const WORKSPACE_WORKBUDDY_INSTALL_COMMAND = WORKSPACE_AGENT_INSTALL_COMMANDS.workbuddy;

export type WorkspaceAppsDeployTarget = "pages" | "worker";

export function workspaceAppsCliManifest(appId: string, targets: WorkspaceAppsDeployTarget[]) {
  const deploy = Object.fromEntries(targets.map((target) => [
    target,
    [
      "frontier-workspace apps deploy",
      `--app ${appId}`,
      "--source .",
      "--deploy-dir dist",
      `--target ${target}`,
      `--entrypoint ${target === "worker" ? "index.js" : "index.html"}`,
      "--version VERSION",
      '--name "VERSION_NAME"',
      "--notes-file RELEASE_NOTES.md"
    ].join(" ")
  ])) as Partial<Record<WorkspaceAppsDeployTarget, string>>;

  return {
    packageName: WORKSPACE_CLI_PACKAGE_NAME,
    install: WORKSPACE_CLI_INSTALL_COMMAND,
    preflight: {
      policy: "before_each_deploy" as const,
      currentVersion: WORKSPACE_CLI_CURRENT_VERSION_COMMAND,
      requiredVersion: WORKSPACE_AI_CLI_VERSION,
      install: WORKSPACE_CLI_INSTALL_COMMAND,
      update: WORKSPACE_CLI_UPDATE_COMMAND,
      instruction: "Before every App deployment, run frontier-workspace version and use the CLI archive bundled with the same workspace source release. Install or update from that local archive when versions differ; do not assume a public npm release exists."
    },
    authenticate: {
      workbuddy: workspaceAgentInstallCommand("workbuddy", "frontier-workspace"),
      codex: workspaceAgentInstallCommand("codex", "frontier-workspace"),
      claudeCode: workspaceAgentInstallCommand("claude-code", "frontier-workspace"),
      cursor: workspaceAgentInstallCommand("cursor", "frontier-workspace")
    },
    deploy,
    publish: `frontier-workspace mcp call apps_deployment_release --args '${JSON.stringify({
      action: "publish",
      appId,
      deploymentId: "DEPLOYMENT_ID"
    })}'`
  };
}
