import { onBrandColor } from "./platformPalette.ts";
import { publicHttpsUrl, resolvePlatformBrand, type PlatformBrand } from "./platformBrand.ts";

export type SystemEmail = { subject: string; text: string; html: string };

export function emailBrandHeader(input?: PlatformBrand) {
  const brand = resolvePlatformBrand(input);
  const mark = brand.logoUrl
    ? `<img src="${escapeEmailHtml(brand.logoUrl)}" width="38" height="38" alt="${escapeEmailHtml(brand.name)}" style="display:block;width:38px;height:38px;object-fit:contain;border:0">`
    : escapeEmailHtml(brand.logoText);
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
    <td align="center" bgcolor="${brand.primaryColor}" width="38" height="38" style="width:38px;height:38px;color:${onBrandColor(brand.primaryColor)};font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:38px;font-weight:700">${mark}</td>
    <td style="padding-left:13px;color:#11110f;font-size:18px;line-height:24px;font-weight:900">${escapeEmailHtml(brand.name)}</td>
  </tr></table>`;
}

export function renderLoginCodeEmail(
  code: string,
  ttlSeconds: number,
  maxAttempts: number,
  input?: PlatformBrand
): SystemEmail {
  const brand = resolvePlatformBrand(input);
  if (!/^\d{6}$/.test(code)) throw new Error("invalid_email_template_otp");
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("invalid_email_template_limits");
  }
  const minutes = Math.ceil(ttlSeconds / 60);
  const subject = `[${brand.name}] 登录验证码`;
  const expiry = `验证码将在 ${minutes} 分钟后失效，最多可尝试 ${maxAttempts} 次。`;
  const footer = `这是一封由 ${brand.name} 自动发送的登录验证邮件，请勿直接回复。`;
  return {
    subject,
    text: [`你的 ${brand.name} 登录验证码：`, "", code, "", expiry, "如果不是你本人发起，请忽略此邮件。"].join("\n"),
    html: emailFrame(brand, subject, "登录验证", "登录验证码", `
      <p style="color:#5e5a52;font-size:15px;line-height:24px;margin:0 0 22px">请在 ${escapeEmailHtml(brand.name)} 登录页面输入以下 6 位验证码：</p>
      <div style="border:1px solid #11110f;border-left:8px solid ${brand.accentColor};background:#faf9f3;color:#11110f;font-size:36px;line-height:48px;letter-spacing:11px;font-weight:900;padding:17px 16px;text-align:center">${code}</div>
      <p style="font-size:13px;line-height:21px;color:#6f6a61;margin:20px 0 0">${expiry}</p>
    `, `${footer}\n如果不是你本人发起，请忽略此邮件。`)
  };
}

export function renderAccountInvitationEmail(
  name: string,
  email: string,
  portalUrl: string,
  input?: PlatformBrand
): SystemEmail {
  const brand = resolvePlatformBrand(input);
  const url = publicHttpsUrl(portalUrl);
  const subject = `欢迎使用 ${brand.name}｜你的账户已准备就绪`;
  const content = `你的 ${brand.name} 账户已创建。使用下方公司邮箱完成首次登录，即可激活账户并开始使用。`;
  return {
    subject,
    text: [`Hi ${name},`, "", content, `登录邮箱：${email}`, `进入 ${brand.name}：${url}`, "", "如果登录遇到问题，请联系企业管理员。", "", `${brand.name} 团队`].join("\n"),
    html: emailFrame(brand, subject, "账户邀请", `欢迎使用 ${brand.name}`, `
      <p style="margin:0 0 12px;font-size:16px;line-height:26px;color:#44403c">Hi ${escapeEmailHtml(name)},</p>
      <p style="margin:0 0 24px;font-size:16px;line-height:26px;color:#44403c">${escapeEmailHtml(content)}</p>
      <div style="padding:18px 20px;background:#faf9f3;border:1px solid #c9c4ba">
        <div style="font-size:12px;line-height:18px;color:#78716c">登录邮箱</div>
        <div style="margin-top:5px;font-size:17px;line-height:26px;font-weight:700;color:#11110f;overflow-wrap:anywhere;word-break:break-word">${escapeEmailHtml(email)}</div>
      </div>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:24px"><tr><td bgcolor="${brand.primaryColor}">
        <a href="${escapeEmailHtml(url)}" target="_blank" style="display:inline-block;padding:14px 24px;color:${onBrandColor(brand.primaryColor)};text-decoration:none;font-size:16px;line-height:22px;font-weight:700">进入 ${escapeEmailHtml(brand.name)}&nbsp;&nbsp;→</a>
      </td></tr></table>
      <p style="margin:14px 0 26px;font-size:12px;line-height:20px;color:#78716c">如果按钮无法打开，请在浏览器中访问：<br><a href="${escapeEmailHtml(url)}" style="color:#44403c;text-decoration:underline;word-break:break-all">${escapeEmailHtml(url)}</a></p>
      <p style="font-size:14px;line-height:24px;color:#57534e">如果登录遇到问题，请联系企业管理员。</p>
    `, `这是一封由 ${brand.name} 自动发送的账户邀请邮件，请勿直接回复。`)
  };
}

function emailFrame(brand: PlatformBrand, subject: string, badge: string, title: string, body: string, footer: string) {
  return `<!doctype html>
<html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeEmailHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f2efe6;color:#11110f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f2efe6"><tr><td align="center" style="padding:32px 16px">
<!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #aaa49a;border-top:3px solid ${brand.primaryColor}">
<tr><td style="padding:20px 28px;border-bottom:1px solid #d4d0c7">${emailBrandHeader(brand)}</td></tr>
<tr><td style="padding:32px 28px"><div style="display:inline-block;padding:6px 10px;border-left:5px solid ${brand.accentColor};background:#f2efe6;font-size:12px;line-height:16px;font-weight:800">${escapeEmailHtml(badge)}</div>
<h1 style="font-family:Georgia,'Songti SC',serif;font-weight:500;font-size:28px;line-height:36px;margin:18px 0 16px">${escapeEmailHtml(title)}</h1>${body}</td></tr>
<tr><td style="padding:20px 28px;background:#faf9f3;border-top:1px solid #d4d0c7;color:#78716c;font-size:12px;line-height:20px">${escapeEmailHtml(footer).replaceAll("\n", "<br>")}</td></tr>
</table><!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}

export function escapeEmailHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
