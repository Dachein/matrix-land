export { WORKSPACE_MAIL_EVENT_PATH, verifyWorkspaceMailEvent, acknowledgeWorkspaceMailEvent, type WorkspaceMailEvent } from "./events.ts";

/** Workspace Mail SDK. Tokens belong on the application's server, never in browser bundles. */
export type MailAttachmentInput = {
  filename: string;
  mimeType: string;
  contentBase64: string;
};
export type MailSendInput = {
  attachments?: MailAttachmentInput[];
  to: string;
  subject: string;
  body: string;
  idempotencyKey: string;
};
export type MailReplyInput = {
  attachments?: MailAttachmentInput[];
  messageId: string;
  body: string;
  idempotencyKey: string;
};
export type MailMessage = {
  id: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  attachmentCount: number;
  read: boolean;
  archived: boolean;
  labels: string[];
  version: number;
};
export type MailListInput = {
  folder?: "inbox" | "sent";
  limit?: number;
  cursor?: string;
  from?: string;
  after?: string;
  before?: string;
  query?: string;
  unread?: boolean;
  archived?: boolean;
  label?: string;
};
export type MailDetail = {
  message: MailMessage;
  messageIdHeader: string;
  references: string;
  inReplyTo: string;
  body: string;
  bodyFormat: "text" | "html";
  nextBodyOffset: number | null;
  attachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    sha256?: string;
  }>;
  processing?: unknown;
};
export type WorkspaceMailTransport = (
  name: string,
  args: Record<string, unknown>,
) => Promise<any>;
export class WorkspaceMailError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export class WorkspaceMail {
  private call: WorkspaceMailTransport;
  constructor(
    options:
      | { transport: WorkspaceMailTransport }
      | { endpoint?: string; token: string; fetch?: typeof fetch },
  ) {
    if ("transport" in options) {
      this.call = options.transport;
      return;
    }
    const origin = new URL(
      options.endpoint || "https://mail-api.example.invalid",
    );
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    )
      throw new Error("workspace_mail_endpoint_invalid");
    this.call = async (name, args) => {
      const response = await (options.fetch || fetch)(
        `${origin.origin}/v1/app/mail/${name}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(args),
          redirect: "manual",
          signal: AbortSignal.timeout(60000),
        },
      );
      if (response.status >= 300 && response.status < 400)
        throw new WorkspaceMailError(502, "mail_redirect_denied");
      const payload = (await response.json()) as any;
      if (!response.ok)
        throw new WorkspaceMailError(
          response.status,
          payload.error || "mail_request_failed",
        );
      return payload;
    };
  }
  /** Mailbox allocation and permission status. App callers cannot allocate arbitrary addresses. */
  mailbox(): Promise<{
    status: string;
    inbox?: string;
    sender?: string;
    receive: boolean;
    send: boolean;
    trigger?: { enabled: boolean; path: string; delivery: string; pending: number; failed: number };
  }> {
    return this.call("mailbox", {});
  }
  list(input: MailListInput = {}): Promise<{
    status: string;
    messages: MailMessage[];
    nextCursor: string | null;
  }> {
    return this.call("mail_list", input);
  }
  get(messageId: string, bodyOffset = 0): Promise<MailDetail> {
    return this.call("mail_get", { messageId, bodyOffset });
  }
  getAttachment(
    messageId: string,
    attachmentId: string,
    offset = 0,
    length = 262144,
  ): Promise<{
    data: string;
    encoding: "base64";
    offset: number;
    nextOffset: number | null;
    totalBytes: number;
    filename: string;
    mimeType: string;
  }> {
    return this.call("mail_get_attachment", {
      messageId,
      attachmentId,
      offset,
      length,
    });
  }
  update(input: {
    messageId: string;
    expectedVersion: number;
    read?: boolean;
    archived?: boolean;
    labels?: string[];
  }): Promise<{ message: MailMessage }> {
    return this.call("mail_update", input);
  }
  send(
    input: MailSendInput,
  ): Promise<{ id: string; status: string; messageId?: string }> {
    return this.call("mail_send", input);
  }
  reply(
    input: MailReplyInput,
  ): Promise<{ id: string; status: string; messageId?: string }> {
    return this.call("mail_reply", input);
  }
}

export type MailboxAllocation = {
  userId: string;
  orgId: string;
  mateId: string;
  address: string;
  name?: string;
  isDefault?: boolean;
};
/** Platform-only allocation client. Its transport must authenticate the exact owner and provisioning scope. */
export class WorkspaceMailProvisioner {
  private call: WorkspaceMailTransport;
  constructor(transport: WorkspaceMailTransport) {
    this.call = transport;
  }
  assign(
    input: MailboxAllocation,
  ): Promise<{ address: string; status: string }> {
    return this.call("/internal/provision", input);
  }
  revoke(): Promise<{ status: string }> {
    return this.call("/internal/mailboxes/disable", {});
  }
  revokeApp(): Promise<{ status: string }> {
    return this.call("/internal/apps/revoke", {});
  }
  lookup(): Promise<{
    mailboxId: string;
    address: string;
    status: string;
  } | null> {
    return this.call("/internal/mailboxes/lookup", {});
  }
  configureApp(input: {
    appId: string;
    name?: string;
    token: string;
    receive: boolean;
    send: boolean;
    inbox?: string;
    sender?: string;
    triggerEnabled?: boolean;
  }): Promise<{ status: string; inbox?: string; sender?: string }> {
    return this.call("/internal/apps/configure", input);
  }
}
