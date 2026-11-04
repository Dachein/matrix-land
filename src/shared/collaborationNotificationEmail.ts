import { onBrandColor } from "./platformPalette.ts";
import { resolvePlatformBrand, type PlatformBrand } from "./platformBrand.ts";
import { emailBrandHeader } from "./systemEmailTemplates.ts";

export type CollaborationNotificationKind = "mention" | "collaborator_added" | "visibility_granted" | "contribution_awarded" | "app_created";

export type CollaborationResourceType = "app" | "forum" | "knowledge";

export type CollaborationNotificationRecipientStatus = "active" | "invited";

export type CollaborationNotificationEmailInput = {
  actorName: string;
  excerpt?: string;
  kind: CollaborationNotificationKind;
  permissionLabel?: string;
  recipientName?: string;
  recipientStatus: CollaborationNotificationRecipientStatus;
  resourceName: string;
  resourceType: CollaborationResourceType;
  resourceUrl: string;
};

export type CollaborationNotificationEmail = {
  html: string;
  preheader: string;
  subject: string;
  text: string;
};

const INK_COLOR = "#11110f";
const MAX_EXCERPT_LENGTH = 280;

const resourceLabels: Record<CollaborationResourceType, string> = {
  app: "应用",
  forum: "论坛",
  knowledge: "知识库"
};

const notificationCopy: Record<CollaborationNotificationKind, {
  badge: string;
  cta: string;
  title: string;
}> = {
  app_created: {
    badge: "应用创建",
    cta: "查看应用",
    title: "应用创建成功"
  },
  collaborator_added: {
    badge: "协作邀请",
    cta: "查看协作内容",
    title: "你已被添加为协作者"
  },
  mention: {
    badge: "提及通知",
    cta: "查看提及内容",
    title: "有人在内容中提到了你"
  },
  contribution_awarded: {
    badge: "社区贡献",
    cta: "查看贡献内容",
    title: "你获得了社区贡献"
  },
  visibility_granted: {
    badge: "访问权限",
    cta: "查看已开放内容",
    title: "你已获得新的查看权限"
  }
};

const englishCopy: typeof notificationCopy = {
  app_created: { badge: "App created", cta: "View app", title: "Your app has been created" },
  collaborator_added: { badge: "Collaboration invitation", cta: "View shared content", title: "You have been added as a collaborator" },
  mention: { badge: "Mention", cta: "View mention", title: "You were mentioned" },
  contribution_awarded: { badge: "Community contribution", cta: "View contribution", title: "Your contribution was recognized" },
  visibility_granted: { badge: "Access granted", cta: "View content", title: "You have been granted access" }
};
const englishResourceLabels: typeof resourceLabels = { app: "app", forum: "discussion", knowledge: "knowledge resource" };

export function canReceiveCollaborationNotificationEmail(status: string) {
  return status === "active" || status === "invited";
}

export function renderCollaborationNotificationEmail(
  input: CollaborationNotificationEmailInput,
  brandInput?: PlatformBrand
): CollaborationNotificationEmail {
  if (!canReceiveCollaborationNotificationEmail(input.recipientStatus)) {
    throw new Error("recipient_status_not_notifiable");
  }

  const brand = resolvePlatformBrand(brandInput);
  const en = brand.defaultLocale === "en";
  const copy = (en ? englishCopy : notificationCopy)[input.kind];
  const resourceLabel = (en ? englishResourceLabels : resourceLabels)[input.resourceType];
  const actorName = cleanSingleLine(input.actorName, 120) || (en ? "A colleague" : "一位同事");
  const recipientName = cleanSingleLine(input.recipientName, 120);
  const resourceName = cleanSingleLine(input.resourceName, 180) || (en ? `Untitled ${resourceLabel}` : `未命名${resourceLabel}`);
  const rawPermission = cleanSingleLine(input.permissionLabel, 80);
  const permissionTranslations: Record<string, string> = { "协作者": "Collaborator", "可查看": "Can view", "社区贡献": "Community contribution", "被提及人": "Mentioned", "可编辑": "Can edit", "可管理": "Can manage" };
  const permissionLabel = en ? ((permissionTranslations[rawPermission] ?? rawPermission.replace(/积分/g, "points")) || englishPermissionLabel(input.kind)) : rawPermission || defaultPermissionLabel(input.kind);
  const showPermission = input.kind !== "mention" && input.kind !== "contribution_awarded" && input.kind !== "app_created";
  const excerpt = cleanMultiline(input.excerpt, MAX_EXCERPT_LENGTH);
  const resourceUrl = safeHttpUrl(input.resourceUrl);
  const resourceCardLabel = input.kind === "app_created" ? (en ? "App domain" : "应用域名") : resourceLabel;
  const resourceCardValue = input.kind === "app_created" ? new URL(resourceUrl).hostname : resourceName;
  const actionSentence = actionSentenceFor(input.kind, actorName, resourceLabel, resourceName, en);
  const subject = `[${brand.name}] ${copy.title} · ${resourceName}`;
  const preheader = truncate(`${actionSentence} ${en ? "Open this email to view the details." : "点击邮件即可查看。"}`, 180);
  const greeting = en ? (recipientName ? `Hi ${recipientName}` : "Hello") : recipientName ? `${recipientName}，你好` : "你好";
  const footer = en ? `This ${input.kind === "app_created" ? "app creation" : "collaboration"} notification was sent automatically by ${brand.name}. Please do not reply.` : `这是一封由 ${brand.name} 自动发送的${input.kind === "app_created" ? "应用创建" : "协作"}通知，请勿直接回复。`;
  const footerNotice = en ? (input.kind === "app_created" ? "The app record has been created. Resources may still be initializing; the app has not necessarily been deployed or published." : "Only invited or active workspace members receive this email. Disabled accounts do not receive notifications.") : input.kind === "app_created"
    ? "应用记录已创建，资源可能仍在初始化。创建成功不代表应用已部署上线。"
    : "只有受邀或已激活的组织成员会收到此邮件；停用账号不会收到通知。";
  const invitedNotice = input.recipientStatus === "invited"
    ? en ? `Your ${brand.name} account is still invited. Your access is reserved; open the link and sign in for the first time to activate it.` : `你的 ${brand.name} 账号仍处于邀请状态，相关权限已经为你保留。打开链接并完成首次登录后即可使用。`
    : "";

  const text = [
    copy.title,
    "",
    `${greeting}${en ? "," : "："}`,
    actionSentence,
    "",
    `${resourceCardLabel}${en ? ": " : "："}${resourceCardValue}`,
    ...(showPermission ? [`${en ? "Your access: " : "你的权限："}${permissionLabel}`] : []),
    ...(excerpt ? ["", `${en ? "Related content: " : "相关内容："}${excerpt}`] : []),
    ...(invitedNotice ? ["", invitedNotice] : []),
    "",
    `${copy.cta}${en ? ": " : "："}${resourceUrl}`,
    "",
    footer,
    ...(input.kind === "app_created" ? [footerNotice] : [])
  ].join("\n");

  const html = `<!doctype html>
<html lang="${en ? "en" : "zh-Hans"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f2efe6;color:${INK_COLOR};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f2efe6">
    <tr>
      <td align="center" style="padding:32px 16px">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #aaa49a;border-top:3px solid ${brand.primaryColor}">
          <tr>
            <td style="padding:20px 28px;border-bottom:1px solid #d4d0c7">
              ${emailBrandHeader(brand)}
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px">
              <div style="display:inline-block;padding:6px 10px;border-left:5px solid ${brand.accentColor};background:#f2efe6;color:${INK_COLOR};font-size:12px;line-height:16px;font-weight:800">${escapeHtml(copy.badge)}</div>
              <h1 style="font-family:Georgia,'Songti SC',serif;font-weight:500;margin:18px 0 12px;font-size:28px;line-height:36px;color:${INK_COLOR};font-weight:800">${escapeHtml(copy.title)}</h1>
              <p style="margin:0 0 10px;font-size:16px;line-height:26px;color:#44403c">${escapeHtml(greeting)}${en ? "," : "："}</p>
              <p style="margin:0 0 24px;font-size:16px;line-height:26px;color:#44403c">${escapeHtml(actionSentence)}</p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#faf9f3;border:1px solid #c9c4ba">
                <tr>
                  <td style="padding:18px 20px">
                    ${input.kind === "app_created"
                      ? `<div style="font-size:17px;line-height:25px;font-weight:800;color:${INK_COLOR};overflow-wrap:anywhere">${en ? "App domain: " : "应用域名："}${escapeHtml(resourceCardValue)}</div>`
                      : `<div style="font-size:12px;line-height:18px;color:#78716c">${escapeHtml(resourceLabel)}</div><div style="margin-top:3px;font-size:17px;line-height:25px;font-weight:800;color:${INK_COLOR}">${escapeHtml(resourceName)}</div>`}
                    ${showPermission ? `<div style="margin-top:10px;font-size:13px;line-height:20px;color:#57534e">${en ? "Your access: " : "你的权限："}<strong>${escapeHtml(permissionLabel)}</strong></div>` : ""}
                  </td>
                </tr>
              </table>

              ${excerpt ? `<div style="margin-top:18px;padding:16px 18px;border-left:4px solid ${INK_COLOR};background:#faf9f3;color:#57534e;font-size:14px;line-height:23px">${escapeHtml(excerpt).replace(/\n/g, "<br>")}</div>` : ""}
              ${invitedNotice ? `<div style="margin-top:18px;padding:14px 16px;border:1px solid ${INK_COLOR};border-left:6px solid ${brand.accentColor};background:#faf9f3;color:${INK_COLOR};font-size:13px;line-height:21px">${escapeHtml(invitedNotice)}</div>` : ""}

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:26px">
                <tr>
                  <td bgcolor="${brand.primaryColor}">
                    <a href="${escapeAttribute(resourceUrl)}" style="display:inline-block;padding:13px 20px;color:${onBrandColor(brand.primaryColor)};text-decoration:none;font-size:15px;line-height:20px;font-weight:800" target="_blank">${escapeHtml(copy.cta)}&nbsp;&nbsp;→</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px;background:#faf9f3;border-top:1px solid #d4d0c7;color:#78716c;font-size:12px;line-height:19px">
              ${escapeHtml(footer)}<br>
              ${escapeHtml(footerNotice)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { html, preheader, subject, text };
}

function actionSentenceFor(
  kind: CollaborationNotificationKind,
  actorName: string,
  resourceLabel: string,
  resourceName: string,
  en = false
) {
  if (en) {
    if (kind === "app_created") return `Your app “${resourceName}” has been created.`;
    if (kind === "mention") return `${actorName} mentioned you in the ${resourceLabel} “${resourceName}”.`;
    if (kind === "collaborator_added") return `${actorName} added you as a collaborator on the ${resourceLabel} “${resourceName}”.`;
    if (kind === "contribution_awarded") return `${actorName} recognized your contribution to the ${resourceLabel} “${resourceName}”.`;
    return `${actorName} granted you access to the ${resourceLabel} “${resourceName}”.`;
  }
  if (kind === "app_created") {
    return `你的应用“${resourceName}”已创建成功。`;
  }
  if (kind === "mention") {
    return `${actorName} 在${resourceLabel}“${resourceName}”中提到了你。`;
  }
  if (kind === "collaborator_added") {
    return `${actorName} 已将你添加为${resourceLabel}“${resourceName}”的协作者。`;
  }
  if (kind === "contribution_awarded") {
    return `${actorName} 为你在${resourceLabel}“${resourceName}”中的内容添加了社区贡献。`;
  }
  return `${actorName} 已向你开放${resourceLabel}“${resourceName}”的查看权限。`;
}

function defaultPermissionLabel(kind: CollaborationNotificationKind) {
  if (kind === "collaborator_added") return "协作者";
  if (kind === "visibility_granted") return "可查看";
  if (kind === "contribution_awarded") return "社区贡献";
  return "被提及人";
}

function englishPermissionLabel(kind: CollaborationNotificationKind) {
  return kind === "collaborator_added" ? "Collaborator" : kind === "visibility_granted" ? "Can view" : kind === "contribution_awarded" ? "Community contribution" : "Mentioned";
}

function cleanSingleLine(value: unknown, maxLength: number) {
  return truncate(String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim(), maxLength);
}

function cleanMultiline(value: unknown, maxLength: number) {
  return truncate(String(value ?? "").replace(/\r\n?/g, "\n").trim(), maxLength);
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function safeHttpUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_notification_resource_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("invalid_notification_resource_url");
  }
  return url.toString();
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
