import assert from "node:assert/strict";
import { test } from "node:test";
import { platformBrandFromEnv, resolvePlatformBrand } from "./platformBrand.ts";
import { renderAccountInvitationEmail, renderLoginCodeEmail } from "./systemEmailTemplates.ts";
import { renderCollaborationNotificationEmail } from "./collaborationNotificationEmail.ts";

const kinds = ["mention", "collaborator_added", "visibility_granted", "contribution_awarded", "app_created"];
const companyBrand = resolvePlatformBrand({ name: "Example & Partners", logoText: "EP", primaryColor: "#123456", accentColor: "#aabbcc" });

function notifications(brand) {
  return [
    renderLoginCodeEmail("123456", 600, 5, brand),
    renderAccountInvitationEmail("Ada <Admin>", "ada@example.com", "https://work.example.com/", brand),
    ...kinds.map((kind) => renderCollaborationNotificationEmail({
      kind, actorName: "Lin", recipientStatus: "invited", resourceType: "app", resourceName: "Research <App>", resourceUrl: "https://work.example.com/apps/research"
    }, brand))
  ];
}

test("all seven built-in email kinds have neutral defaults and configurable identity", () => {
  for (const email of notifications(undefined)) {
    assert.doesNotMatch(JSON.stringify(email), /办公室允许访问/i);
    assert.match(email.html, /Frontier Workspace/);
  }
  for (const email of notifications(companyBrand)) {
    assert.match(email.subject, /Example & Partners/);
    assert.match(email.html, /Example &amp; Partners/);
    assert.match(email.html, /bgcolor="#123456"/);
    assert.match(email.html, />EP<\/td>/);
    assert.doesNotMatch(email.html, /Workspace|WORKSPACE|<App>/);
  }
});

test("brand values cannot inject email headers, HTML attributes or CSS", () => {
  for (const input of [
    { name: "Safe\r\nBcc: attacker@example.com" },
    { primaryColor: 'red" onclick="alert(1)' },
    { logoUrl: "javascript:alert(1)" },
    { logoUrl: "https://user:password@example.com/logo.png" },
    { logoText: "" },
    { secret: "not-public" }
  ]) assert.throws(() => resolvePlatformBrand(input));
  const email = renderLoginCodeEmail("123456", 600, 5, resolvePlatformBrand({ name: '<img src=x onerror="alert(1)">' }));
  assert.doesNotMatch(email.html, /<img/);
  assert.match(email.html, /&lt;img/);
});

test("custom logos are shared by every built-in template and escaped", () => {
  const brand = resolvePlatformBrand({ ...companyBrand, logoUrl: 'https://work.example.com/logo.png?a=1&b=2' });
  for (const email of notifications(brand)) {
    assert.match(email.html, /<img src="https:\/\/work.example.com\/logo.png\?a=1&amp;b=2"/);
    assert.match(email.html, /alt="Example &amp; Partners"/);
  }
});

test("invitation links require an explicit HTTPS installation URL", () => {
  for (const url of [undefined, "", "javascript:alert(1)", "http://example.com", "https://user:pass@example.com"]) {
    assert.throws(() => renderAccountInvitationEmail("Ada", "ada@example.com", url));
  }
  const email = renderAccountInvitationEmail('<img src=x>', "ada@example.com", "https://work.example.com/", companyBrand);
  assert.match(email.html, /&lt;img src=x&gt;/);
  assert.match(email.text, /https:\/\/work.example.com\//);
});

test("OTP is only in the message body and rendered with valid limits", () => {
  const email = renderLoginCodeEmail("123456", 61, 3, companyBrand);
  assert.doesNotMatch(email.subject, /123456/);
  assert.match(email.text, /2 分钟/);
  assert.match(email.html, /3 次/);
  assert.throws(() => renderLoginCodeEmail("<code>", 600, 5));
  assert.throws(() => renderLoginCodeEmail("123456", NaN, 5));
});

test("invalid deployment JSON fails explicitly without revealing its values", () => {
  assert.equal(platformBrandFromEnv({}).name, "Frontier Workspace");
  assert.deepEqual(platformBrandFromEnv({ PLATFORM_BRAND_JSON: JSON.stringify(companyBrand) }), companyBrand);
  for (const value of ["", "not-json", "null", "[]", JSON.stringify({ token: "private-value" })]) {
    assert.throws(() => platformBrandFromEnv({ PLATFORM_BRAND_JSON: value }), (error) => {
      assert.doesNotMatch(error.message, /private-value/);
      return true;
    });
  }
});
