export type MailboxIdentity = {
  orgId: string;
  userId: string;
  mateId: string;
  address: string;
  name?: string;
  isDefault?: boolean;
  status?: string;
  ownerKind?: "mate" | "app";
  ownerId?: string;
  receiveEnabled?: boolean;
};
export type MailEnv = {
  WORKSPACE_MATE_EMAIL_DOMAIN?: string;
  WORKSPACE_EMAIL_ROUTING_DOMAIN?: string;
  WORKSPACE_MAIL_URL?: string;
  RUNTIME_DB: D1Database;
  MAIL_OBJECTS: R2Bucket;
  LEGACY_MAIL_OBJECTS?: R2Bucket;
  WORKSPACE_MAIL_SECRET: string;
  EMAIL?: SendEmail;
  APPS_CONTROL_PLANE?: Fetcher;
  MATE_RUNTIME?: Fetcher;
  CF_API_TOKEN?: string;
  CF_ZONE_ID?: string;
  CF_ACCOUNT_ID?: string;
};
export class MailError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
