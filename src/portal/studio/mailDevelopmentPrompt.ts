import type { AppsApp } from "../../shared/types";

export function appHasMailResource(app: AppsApp) {
  return app.resources.some(
    (resource) =>
      resource.type === "email_sending" || resource.type === "email_routing",
  );
}

/** Copy a discovery workflow, so SDK releases and resource changes are resolved by MCP at execution time. */
export function appMailDevelopmentPrompt(app: AppsApp, locale: string) {
  const appId = JSON.stringify(app.id);
  const mailbox =
    app.manifest.email?.routing.address ||
    app.manifest.email?.sending.senderMailbox;
  const getApp = `apps_app_read({ action: "get", appId: ${appId} })`;
  const getSdk = `apps_app_read({ action: "mail_sdk", appId: ${appId} })`;
  if (locale === "zh-CN") {
    return [
      "请为当前 APPS APP 接入统一的 Workspace Mail 邮箱，并按业务需要实现邮件功能。",
      `目标应用已经创建：${JSON.stringify(app.name)}，appId=${app.id}。请复用此 appId。`,
      mailbox
        ? `当前显示的邮箱：${mailbox}。执行时以 MCP 返回的最新配置为准。`
        : "邮箱地址以 MCP 返回的实际分配结果为准。",
      "",
      "1. 先调用 ping_who_am_i 检查连接与账号，再调用 " +
        getApp +
        "，核对目标应用、权限、邮箱和资源状态。",
      "2. 已开通邮箱时，保留 MCP 返回的地址和 Trigger 状态。需要开通或调整时，通过 apps_app_write(action=update_config, appId=" +
        appId +
        ") 设置 emailEnabled=true、emailPrefix=业务指定名称，一次开通同一地址的收信与发信；新开通时 emailTriggerEnabled=false。",
      "3. 调用 " +
        getSdk +
        "，获取当前 SDK 版本、固定安装地址、校验值、完整开发 Prompt、资源绑定、运行配置与示例。按平台返回的最新资料安装并实施；后续升级或资源调整时重新获取。",
      "4. 邮件代码仅在服务端运行，使用平台注入的 WORKSPACE_MAIL_ENDPOINT、WORKSPACE_MAIL_TOKEN 和 WORKSPACE_APP_ID。按业务需要补齐服务端资源，凭证不得进入浏览器代码。",
      "5. 收件使用 mailbox、list、get、getAttachment，按 nextCursor、nextBodyOffset、nextOffset 读取完整正文与附件。发信使用 mail.send 或 mail.reply，使用与业务记录绑定并持久保存的 idempotencyKey，重试沿用同一个 key。默认收件保存，处理与回复规则由业务需求决定。",
      "6. 业务需要新邮件 Trigger 时，提供 POST /_workspace/mail/received，在浏览器登录中间件之前使用 verifyWorkspaceMailEvent 验签，将 event.id 和待处理工作持久化、以唯一约束去重，再返回 acknowledgeWorkspaceMailEvent(event)。耗时工作使用持久任务、Queue 或定时器。回调部署并验证后再启用 emailTriggerEnabled；按至少一次投递设计，启用不重放历史邮件。应用按自身业务执行，不自动创建 Mate Task。",
      "7. 完成构建与相关测试，核对中文附件名、附件字节、发送幂等性、Trigger 重试与去重。真实邮件仅发往当前会话明确授权的测试地址。遵循项目现有 CI/CD 和发布授权，使用官方 Workspace CLI 保留源码备份。",
      "",
      "交付 appId、实际邮箱地址、SDK 版本、已实现功能、Trigger 状态、测试结果及后续可开发部分。请直接推进已有信息足够的工作。",
    ].join("\n");
  }
  return [
    "Connect this APPS App to the unified Workspace Mail mailbox and implement email features as required by its business workflow.",
    `This App already exists: ${JSON.stringify(app.name)}, appId=${app.id}. Reuse this appId.`,
    mailbox
      ? `Currently displayed mailbox: ${mailbox}. Resolve the latest configuration through MCP when executing.`
      : "Use the mailbox actually assigned by MCP.",
    "",
    `1. Call ping_who_am_i to check the account and connection, then ${getApp} to verify the target App, permissions, mailbox and resource readiness.`,
    `2. For an enabled mailbox, preserve the address and Trigger state returned by MCP. To enable or adjust it, use apps_app_write(action=update_config, appId=${appId}) with emailEnabled=true and the required emailPrefix. One mailbox enables both receiving and sending. Initially use emailTriggerEnabled=false.`,
    `3. Call ${getSdk} for the current SDK version, fixed download URL, checksum, complete development Prompt, resource bindings, runtime settings and examples. Install and implement using that response. Fetch it again for subsequent SDK upgrades or resource changes.`,
    "4. Run mail code only on the server with platform-injected WORKSPACE_MAIL_ENDPOINT, WORKSPACE_MAIL_TOKEN and WORKSPACE_APP_ID. Add server resources as needed; keep credentials out of browser code.",
    "5. Read with mailbox, list, get and getAttachment; follow nextCursor, nextBodyOffset and nextOffset for complete bodies and attachments. Send with mail.send or mail.reply, using a persistent business-record idempotencyKey and the same key for retries. Store received mail by default; processing and replies follow business requirements.",
    "6. If new-mail automation is required, implement POST /_workspace/mail/received before browser-login middleware. Verify with verifyWorkspaceMailEvent, durably persist event.id and pending work with a unique constraint, then return acknowledgeWorkspaceMailEvent(event). Use durable jobs, a Queue or a schedule for long work. Deploy and verify the callback before enabling emailTriggerEnabled. Handle at-least-once delivery and duplicates; activation does not replay history. App callbacks execute their own business logic and do not automatically create Mate Tasks.",
    "7. Build and run relevant checks for Unicode filenames, attachment bytes, sending idempotency, Trigger retries and deduplication. Send real tests only to recipients explicitly authorized in the current conversation. Follow the project CI/CD and existing release authorization, preserving source backups with the official Workspace CLI.",
    "",
    "Deliver the appId, assigned address, SDK version, implemented features, Trigger state, test results and remaining business work. Proceed with work for which sufficient information is available.",
  ].join("\n");
}
