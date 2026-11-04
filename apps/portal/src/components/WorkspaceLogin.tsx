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
        <svg className="workspace-signal" viewBox="0 0 600 510" aria-hidden="true">
          <g className="signal-line">
            <path d="M25 20H575V480H25ZM25 95H575M25 405H575M100 20V480M500 20V480" />
            <ellipse cx="300" cy="250" rx="250" ry="100" transform="rotate(-35 300 250)" />
            <ellipse cx="300" cy="250" rx="240" ry="100" transform="rotate(40 300 250)" />
            <ellipse cx="300" cy="250" rx="100" ry="230" transform="rotate(12 300 250)" />
          </g>
          <path className="signal-action" d="M205 173L335 110L447 190L312 263Z" />
          <path className="signal-paper" d="M205 173V325L312 406V263Z" />
          <path className="signal-ink" d="M312 263L447 190V337L312 406Z" />
          <path className="signal-line" d="M233 159L341 239M267 143L375 221M301 127L410 205M233 194V346M270 222V374M206 224L312 304M206 274L312 354" />
          <path className="signal-wire" d="M357 239V383M402 214V359M312 313L447 240M312 363L447 290" />
          <path className="signal-action" d="M463 85L502 46H476V34H524V82H512V56L473 95Z" />
          <circle className="signal-ink" cx="100" cy="145" r="20" />
          <path className="signal-wire" d="M87 145H113M100 132V158M91 136L109 154M91 154L109 136" />
          <circle className="signal-action" cx="520" cy="315" r="14" />
          <path className="signal-gesture" d="M145 90C216 56 320 55 368 80M147 94C228 64 312 64 368 83M64 352C110 370 162 365 192 350M183 343L197 348L192 362" />
        </svg>
        <figcaption>{t("portal.auth.workspaceCaption")}</figcaption>
      </figure>
    </main>
    <footer className="workspace-login-footer">{t("portal.auth.workspaceFooter")}</footer>
  </DesignSystemScope>;
}
