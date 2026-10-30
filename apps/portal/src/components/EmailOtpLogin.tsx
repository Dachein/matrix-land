import { KeyRound, Mail } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { FormField, TextInput } from "../../../../src/portal/components/FormField";
import { useI18n, type TranslationKey } from "../../../../src/portal/i18n";
import {
  emailOtpVerifyUrl,
  isEmailOtpNotEligibleError,
  isValidEmailOtpCode,
  normalizeEmailOtpCode,
  reloadAfterEmailOtpLogin,
  requestEmailOtp,
  verifyEmailOtp,
  type EmailOtpChallenge
} from "../data/emailOtpClient";

const minimumResendDelaySeconds = 60;

export function EmailOtpLogin({
  loginUrl,
  redirect,
  returnTo
}: {
  loginUrl: string;
  redirect: string;
  returnTo?: string;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<EmailOtpChallenge>();
  const [busyAction, setBusyAction] = useState<"request" | "verify">();
  const [errorKey, setErrorKey] = useState<TranslationKey>();
  const [resendAvailableAt, setResendAvailableAt] = useState(0);
  const [resendSeconds, setResendSeconds] = useState(0);
  const verifyInFlightRef = useRef(false);

  useEffect(() => {
    if (!resendAvailableAt) {
      setResendSeconds(0);
      return;
    }

    const updateCountdown = () => {
      setResendSeconds(Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1_000)));
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1_000);
    return () => window.clearInterval(timer);
  }, [resendAvailableAt]);

  async function sendCode() {
    setBusyAction("request");
    setErrorKey(undefined);

    try {
      const nextChallenge = await requestEmailOtp(loginUrl, { email, redirect, returnTo });
      const normalizedEmail = email.trim().toLowerCase();
      setEmail(normalizedEmail);
      setChallenge(nextChallenge);
      setCode("");
      setResendAvailableAt(Date.now() + Math.max(
        minimumResendDelaySeconds,
        nextChallenge.retryAfter
      ) * 1_000);
    } catch (error) {
      if (isEmailOtpNotEligibleError(error)) {
        setChallenge(undefined);
        setCode("");
        setResendAvailableAt(0);
        setErrorKey("portal.auth.emailNotEligible");
      } else {
        setErrorKey("portal.auth.emailGenericError");
      }
    } finally {
      setBusyAction(undefined);
    }
  }

  async function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendCode();
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (verifyInFlightRef.current) {
      return;
    }
    if (!challenge || !isValidEmailOtpCode(code)) {
      setErrorKey("portal.auth.emailCodeInvalid");
      return;
    }

    verifyInFlightRef.current = true;
    setBusyAction("verify");
    setErrorKey(undefined);
    let verificationSucceeded = false;
    try {
      const result = await verifyEmailOtp(emailOtpVerifyUrl(loginUrl), {
        challengeId: challenge.challengeId,
        code,
        redirect
      });
      reloadAfterEmailOtpLogin(result.redirectUrl, {
        origin: window.location.origin,
        reload: () => window.location.reload(),
        replaceState: (target) => window.history.replaceState(window.history.state, "", target)
      });
      verificationSucceeded = true;
    } catch {
      setErrorKey("portal.auth.emailGenericError");
    } finally {
      if (!verificationSucceeded) {
        verifyInFlightRef.current = false;
        setBusyAction(undefined);
      }
    }
  }

  function changeEmail() {
    setChallenge(undefined);
    setCode("");
    setErrorKey(undefined);
    setResendAvailableAt(0);
  }

  if (!challenge) {
    return (
      <form className="workspace-email-form" onSubmit={submitEmail}>
        <FormField
          error={errorKey ? t(errorKey) : undefined}
          htmlFor="workspace-email-address"
          label={t("portal.auth.emailAddressLabel")}
          required
        >
          <TextInput
            autoCapitalize="none"
            autoComplete="email"
            disabled={busyAction !== undefined}
            id="workspace-email-address"
            inputMode="email"
            onChange={(event) => {
              setEmail(event.target.value);
              setErrorKey(undefined);
            }}
            placeholder={t("portal.auth.emailAddressPlaceholder")}
            required
            spellCheck={false}
            type="email"
            value={email}
          />
        </FormField>
        <Button
          disabled={!email.trim()}
          iconBefore={<Mail aria-hidden="true" size={17} />}
          isLoading={busyAction === "request"}
          type="submit"
          variant="primary"
        >
          {t("portal.auth.emailSendCode")}
        </Button>
      </form>
    );
  }

  return (
    <form className="workspace-email-form" onSubmit={submitCode}>
      <div className="workspace-email-delivery" aria-live="polite">
        <strong>{t("portal.auth.emailCodeSent", { email })}</strong>
        <span>{t("portal.auth.emailCodeExpires", {
          minutes: Math.max(1, Math.ceil(challenge.expiresIn / 60))
        })}</span>
      </div>
      <FormField
        error={errorKey ? t(errorKey) : undefined}
        hideLabel
        htmlFor="workspace-email-code"
        label={t("portal.auth.emailCodeLabel")}
        required
      >
        <TextInput
          autoComplete="one-time-code"
          autoFocus
          className="workspace-email-code-input"
          disabled={busyAction !== undefined}
          id="workspace-email-code"
          inputMode="numeric"
          maxLength={6}
          onChange={(event) => {
            setCode(normalizeEmailOtpCode(event.target.value));
            setErrorKey(undefined);
          }}
          pattern="[0-9]{6}"
          placeholder={t("portal.auth.emailCodePlaceholder")}
          required
          value={code}
        />
      </FormField>
      <Button
        disabled={busyAction !== undefined || !isValidEmailOtpCode(code)}
        iconBefore={<KeyRound aria-hidden="true" size={17} />}
        isLoading={busyAction === "verify"}
        type="submit"
        variant="primary"
      >
        {t("portal.auth.emailVerifyCode")}
      </Button>
      <div className="workspace-email-secondary-actions">
        <Button
          disabled={busyAction !== undefined || resendSeconds > 0}
          isLoading={busyAction === "request"}
          onClick={() => void sendCode()}
          size="compact"
        >
          {resendSeconds > 0
            ? t("portal.auth.emailResendIn", { seconds: resendSeconds })
            : t("portal.auth.emailResend")}
        </Button>
        <Button disabled={busyAction !== undefined} onClick={changeEmail} size="compact">
          {t("portal.auth.emailChangeAddress")}
        </Button>
      </div>
    </form>
  );
}
