import { audit } from "../audit.ts";
import { userProfileColumns } from "../catalog/service.ts";
import { HttpError, readBody, requireDb } from "../http.ts";
import {
  normalizeAvatarUrl,
  normalizeProfileDepartment
} from "../portalContent.ts";
import {
  requireAdminPortalUser,
  resolveCurrentUser
} from "../identity/index.ts";
import {
  normalizeEditableRole,
  normalizeIdentityProvider,
  normalizeRole,
  optionalText,
  requireText
} from "../values.ts";
import { createAdminUsersApi } from "./adminList.ts";
import { createUserDirectoryApi } from "./directory.ts";
import { createUsersApi } from "./service.ts";

export function createUsersServices() {
  return {
    adminUsersApi: createAdminUsersApi({
      normalizeIdentityProvider,
      normalizeRole,
      requireAdminPortalUser,
      requireDb,
      userProfileColumns
    }),
    userDirectoryApi: createUserDirectoryApi({
      httpError: (status, message) => new HttpError(status, message),
      requireDb,
      resolveCurrentUser
    }),
    usersApi: createUsersApi({
      audit,
      httpError: (status, message) => new HttpError(status, message),
      normalizeAvatarUrl,
      normalizeEditableRole,
      normalizeIdentityProvider,
      normalizeProfileDepartment,
      normalizeRole,
      optionalText,
      readBody,
      requireAdminPortalUser,
      requireDb,
      requireText,
      resolveCurrentUser,
      userProfileColumns
    })
  };
}
