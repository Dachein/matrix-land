import { audit } from "../audit.ts";
import { HttpError, readBody, requireDb } from "../http.ts";
import { readAuthSession, redirectToAuthPath, resolveCurrentUser } from "../identity/index.ts";
import { requireText } from "../values.ts";
import { createAuthBoundaryApi } from "./service.ts";

export function createAuthBoundaryServices() {
  return {
    authBoundaryApi: createAuthBoundaryApi({
      audit,
      httpError: (status, message) => new HttpError(status, message),
      readBody,
      requireDb,
      requireText,
      resolveCurrentUser
    }),
    readAuthSession,
    redirectToAuthPath,
    resolveCurrentUser
  };
}
