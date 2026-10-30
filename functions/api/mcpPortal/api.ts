import { HttpError, json, parseJsonBody, requireConfiguredSecret } from "../http.ts";
import { requireAdminPortalUser, resolveCurrentUser } from "../identity/index.ts";
import { requireText } from "../values.ts";
import { createMcpPortalApi } from "./service.ts";

export function createMcpPortalServices() {
  return {
    mcpPortalApi: createMcpPortalApi({
      httpError: (status, message) => new HttpError(status, message),
      json,
      parseJson: (value) => parseJsonBody(value),
      requireAdminPortalUser,
      requireSecret: requireConfiguredSecret,
      requireText,
      resolveCurrentUser
    })
  };
}
