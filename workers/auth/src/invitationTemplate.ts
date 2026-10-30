import { renderAccountInvitationEmail } from "../../../src/shared/systemEmailTemplates.ts";
import type { PlatformBrand } from "../../../src/shared/platformBrand.ts";

export function renderInvitationEmail(name: string, email: string, portalUrl: string, brand?: PlatformBrand) {
  return renderAccountInvitationEmail(name, email, portalUrl, brand);
}
