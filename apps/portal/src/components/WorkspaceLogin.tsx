import { ArrowRight, LogIn } from "lucide-react";
import { Button } from "../../../../src/portal/components/Button";
import { LanguageSwitcher } from "../../../../src/portal/components/LanguageSwitcher";
import { DesignSystemScope } from "../../../../src/portal/design-system/DesignSystemScope";
import { useI18n } from "../../../../src/portal/i18n";
import { EmailOtpLogin } from "./EmailOtpLogin";
import { PortalBrandMark } from "./PortalBrandMark";
import "../styles/workspace-login.css";

export type WorkspaceLoginProps = {
  entraLoginConfigured: boolean;
  emailLoginConfigured: boolean;
  emailLoginUrl: string;
  isEmailAuth: boolean;
  onMicrosoftSignIn: () => void;
  onSwitchAuthMethod: () => void;
  redirect: string;
  returnTo?: string;
};

export function WorkspaceLogin(props: WorkspaceLoginProps) {
  const { t } = useI18n();
  return <DesignSystemScope className="workspace-login">
    <header className="workspace-login-header">
      <div className="workspace-login-brand"><PortalBrandMark /><span>{t("portal.brand.name")}</span></div>
      <LanguageSwitcher variant="line" />
    </header>
    <main className="workspace-login-main">
      <section className="workspace-login-form" aria-labelledby="workspace-login-title">
        <p className="workspace-login-eyebrow">{t("portal.auth.welcome")}</p>
        <h1 id="workspace-login-title">{t("portal.auth.title")}</h1>
        <p className="workspace-login-intro">{t("portal.auth.workspaceIntro")}</p>
        <div className="workspace-login-actions">
          {props.isEmailAuth
            ? <EmailOtpLogin loginUrl={props.emailLoginUrl} redirect={props.redirect} returnTo={props.returnTo} />
            : <Button iconBefore={<LogIn size={17} />} iconAfter={<ArrowRight size={16} />} onClick={props.onMicrosoftSignIn} variant="primary">{t("portal.auth.signIn")}</Button>}
          {props.emailLoginConfigured && props.entraLoginConfigured && <Button variant="secondary" onClick={props.onSwitchAuthMethod}>
            {t(props.isEmailAuth ? "portal.auth.useMicrosoft" : "portal.auth.useEmail")}
          </Button>}
        </div>
      </section>
      <figure className="workspace-login-illustration">
        <img src="/assets/frontier/welcome-v1.webp" alt="" width="1536" height="1024" decoding="async" />
        <figcaption>{t("portal.auth.workspaceCaption")}</figcaption>
      </figure>
    </main>
    <footer className="workspace-login-footer">{t("portal.auth.workspaceFooter")}</footer>
  </DesignSystemScope>;
}
