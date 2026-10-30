import { buildAppDeveloperContext } from "../../../../src/shared/appsAgentHandoff";
import type { AppsApp } from "../../../../src/shared/types";
import { WORKSPACE_MAIL_SDK_EMBEDDED_SHA256 } from "./mailSdkPackageMetadata";

export function appMailSdkHandoff(app: AppsApp) {
  const context = buildAppDeveloperContext(app);
  return {
    schemaVersion: "workspace.apps.mail-sdk-handoff.v1",
    appId: app.id,
    sdk: {
      ...(context.emailSending.sdk as object),
      sha256: WORKSPACE_MAIL_SDK_EMBEDDED_SHA256,
    },
    mailbox: context.mail,
    resources: context.resources,
    bindings: context.bindings,
    readiness: context.readiness,
    runtime: {
      ...context.runtime,
      endpointEnv: "WORKSPACE_MAIL_ENDPOINT",
      tokenSecret: "WORKSPACE_MAIL_TOKEN",
      appIdEnv: "WORKSPACE_APP_ID",
      serverOnly: true,
    },
    configuration: {
      tool: "apps_app_write",
      arguments: {
        action: "update_config",
        appId: app.id,
        emailEnabled: true,
        emailPrefix:
          app.manifest.email?.routing.address?.split("@")[0] || app.appCode,
        emailTriggerEnabled:
          app.manifest.email?.routing.triggerEnabled === true,
      },
    },
    examples: {
      send: "const mail = new WorkspaceMail({endpoint:env.WORKSPACE_MAIL_ENDPOINT,token:env.WORKSPACE_MAIL_TOKEN}); await mail.send({to:authorizedRecipient,subject,body,idempotencyKey:`job:${jobId}:result`});",
      receive:
        "const mailbox = await mail.mailbox(); const page = await mail.list(); const message = await mail.get(messageId); const attachment = await mail.getAttachment(messageId,attachmentId); // follow nextCursor/nextBodyOffset/nextOffset",
      trigger: `import { WorkspaceMail, verifyWorkspaceMailEvent, acknowledgeWorkspaceMailEvent } from '@frontier-workspace/mail';
// Handle this signed endpoint before browser-login middleware.
if (new URL(request.url).pathname === '/_workspace/mail/received') {
  const event = await verifyWorkspaceMailEvent(request,{token:env.WORKSPACE_MAIL_TOKEN,appId:env.WORKSPACE_APP_ID});
  // Atomically persist event.id in an app-owned inbox table (UNIQUE event ID).
  // Persist pending work before acknowledging. A durable app job processes it,
  // reading mail.get(event.messageId), all body pages and attachment chunks.
  await enqueueMailEventOnce(event);
  return acknowledgeWorkspaceMailEvent(event);
}`,
    },
    trigger: {
      enabled: app.manifest.email?.routing.triggerEnabled === true,
      path: "/_workspace/mail/received",
      authentication:
        "SDK verifies HMAC with WORKSPACE_MAIL_TOKEN and a five-minute timestamp window; never trust unsigned request fields.",
      delivery:
        "At least once, up to 20 attempts, retried each minute. A 2xx response must include x-workspace-mail-ack equal to the verified event.id. Redirects are not followed.",
      history:
        "Only new inbound mail received after enabling the Trigger is delivered. Enabling or re-enabling does not replay history. Outbound mail does not trigger it.",
      backgroundWork:
        "For long jobs, add a cron_trigger or queue resource with apps_app_write(update_config, addResourceTypes) and persist pending work in the app database. Do not acknowledge work kept only in memory or ctx.waitUntil.",
      readiness:
        "Deploy and test the callback before enabling Trigger. Enable it in APPS settings or update_config; the published application handles its own business work. mailbox() reports pending/failed delivery counts.",
      taskPolicy:
        "Application triggers do not create Mate Tasks. Mate inboxPrompt remains a separate Runtime policy.",
    },
  };
}
