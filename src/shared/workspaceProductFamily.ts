import workspaceCliPackage from "../../packages/cli/package.json" with { type: "json" };

import workspaceMailPackage from "../../sdk/mail/package.json" with { type: "json" };

export const WORKSPACE_MAIL_SDK_VERSION = workspaceMailPackage.version;
import authPackage from "../../sdk/auth/package.json" with { type: "json" };
export const WORKSPACE_AUTH_SDK_VERSION = authPackage.version;
export const WORKSPACE_AI_CLI_VERSION = workspaceCliPackage.version;
export const WORKSPACE_PASS_MCP_MINIMUM_CLI_VERSION = "0.1.0";
