import { defaultAgentConfigPath } from "./agent-install.mjs";

export {
  defaultAgentConfigPath,
  installAgentMcp,
  installWorkBuddyMcp,
  resolveNpxCommand
} from "./agent-install.mjs";

export function defaultWorkBuddyConfigPath(homeDirectory) {
  return defaultAgentConfigPath("workbuddy", homeDirectory);
}
