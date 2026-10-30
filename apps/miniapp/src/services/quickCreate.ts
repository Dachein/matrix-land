/** A display name is not a unique identity: repeat creations need distinct mailbox codes. */
export function quickMateCode(value: string, now = Date.now(), random = Math.random()) {
  const slug = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mini";
  const time = Math.max(0, Math.floor(now)).toString(36);
  const nonce = Math.floor(Math.min(Math.max(random, 0), 0.999999999) * 0x100000000).toString(36).padStart(7, "0");
  return `${slug}-${time}-${nonce}`;
}

export class MateProvisionIncompleteError extends Error {
  mateId: string;
  cause: unknown;

  constructor(mateId: string, cause: unknown) {
    super("mate_provision_incomplete");
    this.name = "MateProvisionIncompleteError";
    this.mateId = mateId;
    this.cause = cause;
  }
}

export function quickCreateErrorMessage(error: unknown, language?: Language) {
  if (error instanceof MateProvisionIncompleteError) return translate("create.incomplete", {}, language);
  const code = error instanceof Error ? error.message : "";
  if (code === "default_mate_not_published") return translate("home.firstMateNoPublished", {}, language);
  if (code === "default_mate_email_conflict") return translate("create.defaultConflict", {}, language);
  if (code === "default_mate_user_email_invalid") return translate("create.defaultEmailInvalid", {}, language);
  if (code === "mate_email_conflict" || code === "mate_identity_conflict") return translate("create.conflict", {}, language);
  if (code === "mate_deploy_failed") return translate("create.deployFailed", {}, language);
  if (code === "mate_definition_invalid") return translate("create.invalid", {}, language);
  if (code === "http_429") return translate("create.rateLimited", {}, language);
  if (code && !/^[a-z0-9_]+$/i.test(code)) return code;
  return translate("create.failed", {}, language);
}
import { translate, type Language } from "./i18n";
