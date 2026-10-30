export interface Env {
  AUTH_DB?: D1Database;
  MOKA_API_KEY?: string;
  MOKA_BASE_URL?: string;
  MOKA_CONNECTOR_SERVICE_TOKEN?: string;
  MOKA_DEPARTMENT_API_CODE?: string;
  MOKA_EMPLOYEE_API_CODE?: string;
  MOKA_ENABLED?: string;
  MOKA_ENT_CODE?: string;
  MOKA_PRIVATE_KEY?: string;
  MOKA_PUBLIC_HOST?: string;
  MOKA_USER_NAME?: string;
  MOKA_WEBHOOK_SECRET?: string;
  MOKA_DIRECTORY_EVENTS?: Queue<MokaDirectoryEvent>;
}

export type MokaDirectoryEvent = {
  action: "create" | "deactivate" | "update";
  apiCode: string;
  entityType: "department" | "employee";
  eventKey: string;
  occurredAt?: string;
  receivedAt: string;
  sourceId: string;
  sourceType: "1" | "2";
};

export class HttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
